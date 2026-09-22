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
    getConnection: async () => ({
      query: (...args) => connection.query(...args),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {}
    }),
    query: (...args) => connection.query(...args)
  };
}

async function iniciarApi(connection, usuario) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = usuario;
    next();
  };
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-financeiro')(app, poolTransacional(connection));
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

async function requisicaoJson(url, opcoes = {}) {
  const resposta = await fetch(url, opcoes);
  return { resposta, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const marcador = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const protocolo = `FAT${process.pid}${String(Date.now()).slice(-7)}`;
  const observacao = `FATURA SEMANAL TESTE ${marcador}`;
  const observacaoPeriodoAberto = `FATURA PERIODO ABERTO ${marcador}`;
  const referencia = `PIX-FATURA-${marcador}`;
  let servidor;
  let faturaId;
  let erro;

  try {
    await connection.beginTransaction();
    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[usuario]] = await connection.query(
      "SELECT id, nome FROM usuarios WHERE status='ATIVO' ORDER BY id LIMIT 1"
    );
    const [[cliente]] = await connection.query(
      'SELECT id FROM clientes WHERE ativo=1 ORDER BY id LIMIT 1'
    );
    assert.ok(servico && usuario && cliente, 'Base ativa é obrigatória');

    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda)
       VALUES (?, ?, ?, ?, 'GM', 'FATURA TESTE', 2026,
               'CONCLUIDO', 75.50, 0, 'BRL')`,
      [
        protocolo,
        cliente.id,
        servico.id,
        `9BGFT1A0${String(Date.now()).slice(-8)}`
      ]
    );
    const [fatura] = await connection.query(
      `INSERT INTO faturas_clientes
         (cliente_id, periodo_inicio, periodo_fim, vencimento, moeda,
          valor_total, status, observacao)
       VALUES (?, '2026-09-14', '2026-09-20', '2026-09-23', 'BRL',
               1, 'ABERTA', ?)`,
      [cliente.id, observacao]
    );
    faturaId = fatura.insertId;
    await connection.query(
      `INSERT INTO fatura_itens (fatura_id, pedido_senha_id, valor)
       VALUES (?, ?, 75.50)`,
      [faturaId, pedido.insertId]
    );
    const [faturaPeriodoAberto] = await connection.query(
      `INSERT INTO faturas_clientes
         (cliente_id, periodo_inicio, periodo_fim, vencimento, moeda,
          valor_total, status, observacao)
       VALUES (?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 6 DAY),
               DATE_ADD(CURDATE(), INTERVAL 9 DAY), 'USD', 10,
               'ABERTA', ?)`,
      [cliente.id, observacaoPeriodoAberto]
    );

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;
    const cabecalhos = { 'Content-Type': 'application/json' };
    const urlPagamento =
      `${api.url}/api/faturas/${faturaId}/pagamento/confirmar-manual`;
    const corpoPagamento = {
      meio_pagamento: 'PIX',
      referencia_externa: referencia
    };

    const pagamentoAntesDoFechamento = await requisicaoJson(urlPagamento, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify(corpoPagamento)
    });
    assert.strictEqual(pagamentoAntesDoFechamento.resposta.status, 409);
    assert.strictEqual(
      pagamentoAntesDoFechamento.corpo.codigo,
      'FATURA_NAO_FECHADA'
    );

    const urlFechamento = `${api.url}/api/faturas/${faturaId}/fechar`;
    const periodoAindaAberto = await requisicaoJson(
      `${api.url}/api/faturas/${faturaPeriodoAberto.insertId}/fechar`,
      { method: 'POST', headers: cabecalhos, body: '{}' }
    );
    assert.strictEqual(periodoAindaAberto.resposta.status, 409);
    assert.strictEqual(
      periodoAindaAberto.corpo.codigo,
      'PERIODO_AINDA_ABERTO'
    );

    const fechada = await requisicaoJson(urlFechamento, {
      method: 'POST', headers: cabecalhos, body: '{}'
    });
    assert.strictEqual(fechada.resposta.status, 200);
    assert.strictEqual(fechada.corpo.fatura.status, 'FECHADA');
    assert.strictEqual(Number(fechada.corpo.fatura.valor_total), 75.5);

    const fechamentoRepetido = await requisicaoJson(urlFechamento, {
      method: 'POST', headers: cabecalhos, body: '{}'
    });
    assert.strictEqual(fechamentoRepetido.resposta.status, 200);
    assert.strictEqual(fechamentoRepetido.corpo.idempotente, true);

    const pago = await requisicaoJson(urlPagamento, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify(corpoPagamento)
    });
    assert.strictEqual(pago.resposta.status, 200);
    assert.strictEqual(pago.corpo.fatura.status, 'PAGA');
    const pagamentoId = pago.corpo.pagamento.id;
    const lancamentoId = pago.corpo.pagamento.lancamento_id;

    const pagamentoRepetido = await requisicaoJson(urlPagamento, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify(corpoPagamento)
    });
    assert.strictEqual(pagamentoRepetido.resposta.status, 200);
    assert.strictEqual(pagamentoRepetido.corpo.idempotente, true);
    assert.strictEqual(pagamentoRepetido.corpo.pagamento.id, pagamentoId);
    assert.strictEqual(
      pagamentoRepetido.corpo.pagamento.lancamento_id,
      lancamentoId
    );

    const referenciaDivergente = await requisicaoJson(urlPagamento, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify({
        meio_pagamento: 'PIX',
        referencia_externa: `${referencia}-OUTRA`
      })
    });
    assert.strictEqual(referenciaDivergente.resposta.status, 409);

    const [[estado]] = await connection.query(
      `SELECT f.status, f.valor_total,
        (SELECT COUNT(*) FROM lancamentos_financeiros l
          WHERE l.fatura_id=f.id AND l.tipo='RECEITA'
            AND l.status='RECEBIDO') lancamentos,
        (SELECT COUNT(*) FROM pagamentos p
          WHERE p.lancamento_id=?) pagamentos,
        (SELECT COUNT(*) FROM auditoria a
          WHERE a.entidade='faturas_clientes'
            AND a.entidade_id=CAST(f.id AS CHAR)) auditorias
       FROM faturas_clientes f WHERE f.id=?`,
      [lancamentoId, faturaId]
    );
    assert.strictEqual(estado.status, 'PAGA');
    assert.strictEqual(Number(estado.valor_total), 75.5);
    assert.strictEqual(Number(estado.lancamentos), 1);
    assert.strictEqual(Number(estado.pagamentos), 1);
    assert.strictEqual(Number(estado.auditorias), 2);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
          (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo=?) pedidos,
          (SELECT COUNT(*) FROM faturas_clientes
            WHERE observacao IN (?, ?)) faturas,
          (SELECT COUNT(*) FROM pagamentos WHERE referencia_externa=?) pagamentos`,
        [protocolo, observacao, observacaoPeriodoAberto, referencia]
      );
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0, 0]);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: fatura semanal fecha e recebe pagamento idempotente (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste da fatura semanal: ${erro.message}`);
  process.exitCode = 1;
});
