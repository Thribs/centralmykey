'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

function poolTransacional(connection) {
  return {
    query: (...args) => connection.query(...args),
    getConnection: async () => ({
      query: (...args) => connection.query(...args),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {}
    })
  };
}

async function iniciarApi(connection) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => next();
  app.locals.exigirPermissao = () => (req, res, next) => next();
  const pool = poolTransacional(connection);
  require('./rotas-relatorios')(app, pool);
  require('./rotas-financeiro')(app, pool);
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function requisitar(url) {
  const resposta = await fetch(url);
  return { resposta, corpo: await resposta.json() };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

function porMoeda(lista, moeda) {
  return lista.find(item => item.moeda === moeda) || {};
}

function diferenca(depois, antes, campos) {
  return campos.map(campo => Number(depois[campo] || 0) - Number(antes[campo] || 0));
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const sufixo = `${process.pid}${String(Date.now()).slice(-8)}`;
  const marcador = `FIN-RESUMO-${sufixo}`;
  let servidor;
  let clienteId;
  let fornecedorId;
  let erro;

  try {
    await connection.beginTransaction();
    const api = await iniciarApi(connection);
    servidor = api.servidor;
    const resumoUrl = `${api.url}/api/financeiro/resumo`;
    const baselineResposta = await requisitar(resumoUrl);
    assert.strictEqual(baselineResposta.resposta.status, 200);

    const telefone = `5588${sufixo}`;
    const [cliente] = await connection.query(`
      INSERT INTO clientes
        (nome, telefone, telefone_normalizado, cadastro_status, ativo)
      VALUES (?, ?, ?, 'COMPLETO', 1)
    `, [`CLIENTE ${marcador}`, telefone, telefone]);
    clienteId = cliente.insertId;
    const [fornecedor] = await connection.query(`
      INSERT INTO fornecedores (nome, tipo, ativo)
      VALUES (?, 'PESSOA', 1)
    `, [`FORNECEDOR ${marcador}`]);
    fornecedorId = fornecedor.insertId;

    async function lancamento(sufixoLinha, tipo, valor, moeda, status, vinculo) {
      const [resultado] = await connection.query(`
        INSERT INTO lancamentos_financeiros
          (tipo, cliente_id, fornecedor_id, descricao, valor, moeda,
           data_competencia, vencimento, status, origem)
        VALUES (?, ?, ?, ?, ?, ?, CURDATE(), CURDATE(), ?, 'TESTE_RESUMO')
      `, [tipo, vinculo === 'CLIENTE' ? clienteId : null,
        vinculo === 'FORNECEDOR' ? fornecedorId : null,
        `${marcador}-${sufixoLinha}`, valor, moeda, status]);
      return resultado.insertId;
    }

    const receitaRecebida = await lancamento('R1', 'RECEITA', 100, 'BRL', 'RECEBIDO', 'CLIENTE');
    await lancamento('R2', 'RECEITA', 50, 'BRL', 'PENDENTE', 'CLIENTE');
    const receitaCancelada = await lancamento('R3', 'RECEITA', 30, 'BRL', 'CANCELADO', 'CLIENTE');
    const despesaPaga = await lancamento('D1', 'DESPESA', 20, 'BRL', 'PAGO', 'FORNECEDOR');
    await lancamento('D2', 'DESPESA', 10, 'BRL', 'PREVISTO', 'FORNECEDOR');
    await lancamento('D3', 'DESPESA', 5, 'BRL', 'CANCELADO', 'FORNECEDOR');
    const receitaUsd = await lancamento('U1', 'RECEITA', 200, 'USD', 'RECEBIDO', 'CLIENTE');
    await lancamento('U2', 'DESPESA', 40, 'USD', 'PENDENTE', 'FORNECEDOR');

    async function pagamento(lancamentoId, valor, moeda, referencia) {
      await connection.query(`
        INSERT INTO pagamentos
          (lancamento_id, valor, moeda, data_pagamento, meio_pagamento,
           referencia_externa)
        VALUES (?, ?, ?, NOW(), 'PIX', ?)
      `, [lancamentoId, valor, moeda, `${marcador}-${referencia}`]);
    }
    await pagamento(receitaRecebida, 100, 'BRL', 'P1');
    await pagamento(receitaCancelada, 30, 'BRL', 'P2');
    await pagamento(despesaPaga, 20, 'BRL', 'P3');
    await pagamento(receitaUsd, 200, 'USD', 'P4');

    async function fatura(
      sufixoFatura,
      moeda,
      valor,
      status,
      vencimentoSql,
      deslocamento
    ) {
      await connection.query(`
        INSERT INTO faturas_clientes
          (cliente_id, periodo_inicio, periodo_fim, vencimento,
           moeda, valor_total, status, observacao)
        VALUES (?, DATE_SUB(CURDATE(), INTERVAL ? DAY),
                DATE_SUB(CURDATE(), INTERVAL ? DAY),
                ${vencimentoSql}, ?, ?, ?, ?)
      `, [clienteId, deslocamento, deslocamento, moeda, valor, status,
        `${marcador}-${sufixoFatura}`]);
    }
    await fatura('F1', 'BRL', 80, 'ABERTA', 'DATE_ADD(CURDATE(), INTERVAL 5 DAY)', 0);
    await fatura('F2', 'BRL', 70, 'FECHADA', 'DATE_SUB(CURDATE(), INTERVAL 5 DAY)', 1);
    await fatura('F3', 'BRL', 60, 'PAGA', 'CURDATE()', 2);
    await fatura('F4', 'BRL', 40, 'VENCIDA', 'DATE_SUB(CURDATE(), INTERVAL 10 DAY)', 3);
    await fatura('F5', 'USD', 300, 'ABERTA', 'DATE_ADD(CURDATE(), INTERVAL 5 DAY)', 0);

    const resumoResposta = await requisitar(resumoUrl);
    assert.strictEqual(resumoResposta.resposta.status, 200);
    const antesBrl = porMoeda(baselineResposta.corpo.lancamentos, 'BRL');
    const depoisBrl = porMoeda(resumoResposta.corpo.lancamentos, 'BRL');
    assert.deepStrictEqual(
      diferenca(depoisBrl, antesBrl, [
        'quantidade_receitas', 'quantidade_despesas', 'receitas_realizadas',
        'despesas_realizadas', 'contas_receber', 'contas_pagar'
      ]),
      [3, 3, 100, 20, 50, 10]
    );
    const antesUsd = porMoeda(baselineResposta.corpo.lancamentos, 'USD');
    const depoisUsd = porMoeda(resumoResposta.corpo.lancamentos, 'USD');
    assert.deepStrictEqual(
      diferenca(depoisUsd, antesUsd, [
        'quantidade_receitas', 'quantidade_despesas', 'receitas_realizadas',
        'despesas_realizadas', 'contas_receber', 'contas_pagar'
      ]),
      [1, 1, 200, 0, 0, 40]
    );

    const faturasAntes = porMoeda(baselineResposta.corpo.faturas, 'BRL');
    const faturasDepois = porMoeda(resumoResposta.corpo.faturas, 'BRL');
    assert.deepStrictEqual(
      diferenca(faturasDepois, faturasAntes, [
        'total', 'abertas', 'fechadas', 'pagas', 'vencidas',
        'valor_em_aberto', 'valor_pago'
      ]),
      [4, 1, 1, 1, 2, 190, 60]
    );
    const hojeAntes = porMoeda(baselineResposta.corpo.pagamentos_hoje, 'BRL');
    const hojeDepois = porMoeda(resumoResposta.corpo.pagamentos_hoje, 'BRL');
    assert.deepStrictEqual(
      diferenca(hojeDepois, hojeAntes, ['quantidade', 'valor']),
      [1, 100],
      'Pagamento cancelado e pagamento de despesa não entram no recebido hoje'
    );

    const lista = await requisitar(
      `${api.url}/api/lancamentos-financeiros?busca=${marcador}&moeda=BRL`
    );
    assert.strictEqual(lista.resposta.status, 200);
    assert.strictEqual(lista.corpo.total, 6);
    const recebida = await requisitar(
      `${api.url}/api/lancamentos-financeiros?busca=${marcador}` +
      '&moeda=BRL&tipo=RECEITA&status=RECEBIDO'
    );
    assert.strictEqual(recebida.corpo.total, 1);
    for (const filtro of ['tipo=AJUSTE', 'status=INVALIDO', 'moeda=EUR']) {
      const invalido = await requisitar(
        `${api.url}/api/lancamentos-financeiros?${filtro}`
      );
      assert.strictEqual(invalido.resposta.status, 400);
    }

    const faturasBrl = await requisitar(
      `${api.url}/api/faturas?cliente_id=${clienteId}&moeda=BRL`
    );
    assert.strictEqual(faturasBrl.resposta.status, 200);
    assert.strictEqual(faturasBrl.corpo.total, 4);
    const vencidas = await requisitar(
      `${api.url}/api/faturas?cliente_id=${clienteId}&moeda=BRL&status=VENCIDA`
    );
    assert.strictEqual(vencidas.corpo.total, 2);
    const faturaMoedaInvalida = await requisitar(`${api.url}/api/faturas?moeda=EUR`);
    assert.strictEqual(faturaMoedaInvalida.resposta.status, 400);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(`
        SELECT
          (SELECT COUNT(*) FROM clientes WHERE id=?) AS clientes,
          (SELECT COUNT(*) FROM fornecedores WHERE id=?) AS fornecedores,
          (SELECT COUNT(*) FROM lancamentos_financeiros WHERE descricao LIKE ?) AS lancamentos,
          (SELECT COUNT(*) FROM pagamentos WHERE referencia_externa LIKE ?) AS pagamentos,
          (SELECT COUNT(*) FROM faturas_clientes WHERE observacao LIKE ?) AS faturas
      `, [clienteId || 0, fornecedorId || 0, `${marcador}%`,
        `${marcador}%`, `${marcador}%`]);
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0, 0, 0, 0]);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: resumo financeiro, filtros e moedas reconciliam (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: resumo financeiro: ${erro.message}`);
  process.exitCode = 1;
});
