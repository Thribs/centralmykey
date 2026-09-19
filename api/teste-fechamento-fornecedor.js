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

function proximaSemana() {
  const hoje = new Date();
  const base = new Date(Date.UTC(
    hoje.getUTCFullYear(),
    hoje.getUTCMonth(),
    hoje.getUTCDate()
  ));
  const diasAteSegunda = ((8 - base.getUTCDay()) % 7) || 7;
  const inicio = new Date(base);
  inicio.setUTCDate(base.getUTCDate() + diasAteSegunda);
  const fim = new Date(inicio);
  fim.setUTCDate(inicio.getUTCDate() + 6);
  return {
    inicio: inicio.toISOString().slice(0, 10),
    fim: fim.toISOString().slice(0, 10)
  };
}

async function criarTabelasTemporarias(connection) {
  await connection.query(
    `CREATE TEMPORARY TABLE fechamentos_fornecedores (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       fornecedor_id BIGINT NOT NULL,
       periodo_inicio DATE NOT NULL,
       periodo_fim DATE NOT NULL,
       moeda VARCHAR(3) NOT NULL DEFAULT 'BRL',
       quantidade_itens INT NOT NULL DEFAULT 0,
       valor_total DECIMAL(12,2) NOT NULL DEFAULT 0,
       status ENUM('RASCUNHO','FECHADO','PAGO','CANCELADO')
         NOT NULL DEFAULT 'RASCUNHO',
       lancamento_financeiro_id BIGINT NULL,
       gerado_por BIGINT NULL,
       fechado_por BIGINT NULL,
       pago_por BIGINT NULL,
       fechado_em DATETIME NULL,
       pago_em DATETIME NULL,
       criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uk_periodo
         (fornecedor_id, periodo_inicio, periodo_fim, moeda)
     ) ENGINE=InnoDB`
  );
  await connection.query(
    `CREATE TEMPORARY TABLE fechamento_fornecedor_itens (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       fechamento_id BIGINT NOT NULL,
       pedido_senha_id BIGINT NOT NULL,
       resultado_id BIGINT NOT NULL UNIQUE,
       custo DECIMAL(12,2) NOT NULL,
       criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`
  );
}

async function iniciarApi(connection, usuario) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = usuario;
    next();
  };
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-fechamentos-fornecedores')(
    app,
    poolTransacional(connection)
  );
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return {
    servidor,
    url: `http://127.0.0.1:${servidor.address().port}`
  };
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
  const prefixo = `TF${process.pid}${String(Date.now()).slice(-5)}`;
  const referencia = `REF-FORN-${marcador}`;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    await criarTabelasTemporarias(connection);
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

    const [fornecedor] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, '5511333333333', 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [`FORNECEDOR FECHAMENTO ${marcador}`]
    );
    await connection.query(
      `INSERT INTO fornecedor_servicos
         (fornecedor_id, codigo_servico, descricao, marca, custo, moeda, ativo)
       VALUES (?, 'GM_SENHA', 'TESTE FECHAMENTO', 'GM', 22, 'BRL', 1)`,
      [fornecedor.insertId]
    );

    const resultados = [];
    for (let indice = 0; indice < 2; indice += 1) {
      const [pedido] = await connection.query(
        `INSERT INTO pedidos_senha
           (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
            status, valor_venda, custo, moeda, fornecedor_id, origem_id)
         VALUES (?, ?, ?, ?, 'GM', 'TESTE FECHAMENTO', 2026,
                 'CONCLUIDO', 50, 22, 'BRL', ?, 2)`,
        [
          `${prefixo}-${indice}`,
          cliente.id,
          servico.id,
          `9BGFF${indice}1A0${String(Date.now() + indice).slice(-8)}`,
          fornecedor.insertId
        ]
      );
      const [resultado] = await connection.query(
        `INSERT INTO pedido_resultados
           (pedido_id, origem_id, fornecedor_id, codigo_mecanico,
            resultado, custo, status, criado_em)
         VALUES (?, 2, ?, ?, JSON_OBJECT(), 22, 'CONFIRMADO', ?)`,
        [
          pedido.insertId,
          fornecedor.insertId,
          `MC-FECHAMENTO-${indice}`,
          `2026-09-${8 + indice} 12:00:00`
        ]
      );
      resultados.push(resultado.insertId);
    }

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;
    const gerarUrl = `${api.url}/api/fornecedores/${fornecedor.insertId}/fechamentos/gerar`;
    const cabecalhos = { 'Content-Type': 'application/json' };

    const opcoesFornecedor = await requisicaoJson(
      `${api.url}/api/fechamentos-fornecedores/fornecedores`
    );
    assert.strictEqual(opcoesFornecedor.resposta.status, 200);
    assert.ok(opcoesFornecedor.corpo.dados.some(
      item => Number(item.id) === Number(fornecedor.insertId)
    ));

    const periodoInvalido = await requisicaoJson(gerarUrl, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify({
        periodo_inicio: '2026-09-08',
        periodo_fim: '2026-09-13'
      })
    });
    assert.strictEqual(periodoInvalido.resposta.status, 400);

    const gerado = await requisicaoJson(gerarUrl, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify({
        periodo_inicio: '2026-09-07',
        periodo_fim: '2026-09-13',
        moeda: 'BRL'
      })
    });
    assert.strictEqual(gerado.resposta.status, 201);
    assert.strictEqual(Number(gerado.corpo.fechamento.quantidade_itens), 2);
    assert.strictEqual(Number(gerado.corpo.fechamento.valor_total), 44);
    const fechamentoId = gerado.corpo.fechamento.id;

    const regerado = await requisicaoJson(gerarUrl, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify({
        periodo_inicio: '2026-09-07',
        periodo_fim: '2026-09-13',
        moeda: 'BRL'
      })
    });
    assert.strictEqual(regerado.resposta.status, 201);
    assert.strictEqual(regerado.corpo.fechamento.id, fechamentoId);

    const fechado = await requisicaoJson(
      `${api.url}/api/fechamentos-fornecedores/${fechamentoId}/fechar`,
      { method: 'POST', headers: cabecalhos, body: '{}' }
    );
    assert.strictEqual(fechado.resposta.status, 200);
    assert.strictEqual(fechado.corpo.fechamento.status, 'FECHADO');
    const lancamentoId = fechado.corpo.fechamento.lancamento_financeiro_id;

    const fechamentoRepetido = await requisicaoJson(
      `${api.url}/api/fechamentos-fornecedores/${fechamentoId}/fechar`,
      { method: 'POST', headers: cabecalhos, body: '{}' }
    );
    assert.strictEqual(fechamentoRepetido.corpo.idempotente, true);
    assert.strictEqual(
      fechamentoRepetido.corpo.fechamento.lancamento_financeiro_id,
      lancamentoId
    );

    const corpoPagamento = {
      meio_pagamento: 'PIX',
      referencia_externa: referencia
    };
    const pago = await requisicaoJson(
      `${api.url}/api/fechamentos-fornecedores/${fechamentoId}/pagar`,
      {
        method: 'POST',
        headers: cabecalhos,
        body: JSON.stringify(corpoPagamento)
      }
    );
    assert.strictEqual(pago.resposta.status, 200);
    assert.strictEqual(pago.corpo.fechamento.status, 'PAGO');

    const pagamentoRepetido = await requisicaoJson(
      `${api.url}/api/fechamentos-fornecedores/${fechamentoId}/pagar`,
      {
        method: 'POST',
        headers: cabecalhos,
        body: JSON.stringify(corpoPagamento)
      }
    );
    assert.strictEqual(pagamentoRepetido.corpo.idempotente, true);

    const listagem = await requisicaoJson(
      `${api.url}/api/fechamentos-fornecedores` +
      `?fornecedor_id=${fornecedor.insertId}&status=PAGO`
    );
    assert.strictEqual(listagem.resposta.status, 200);
    assert.strictEqual(listagem.corpo.total, 1);
    assert.strictEqual(Number(listagem.corpo.dados[0].id), Number(fechamentoId));

    const semanaFutura = proximaSemana();
    const [pedidoFuturo] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda, fornecedor_id, origem_id)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE PERIODO ABERTO', 2026,
               'CONCLUIDO', 50, 22, 'BRL', ?, 2)`,
      [
        `${prefixo}-FUTURO`,
        cliente.id,
        servico.id,
        `9BGFU1A0${String(Date.now()).slice(-8)}`,
        fornecedor.insertId
      ]
    );
    await connection.query(
      `INSERT INTO pedido_resultados
         (pedido_id, origem_id, fornecedor_id, codigo_mecanico,
          resultado, custo, status, criado_em)
       VALUES (?, 2, ?, 'MC-FUTURO', JSON_OBJECT(), 22, 'CONFIRMADO', ?)`,
      [
        pedidoFuturo.insertId,
        fornecedor.insertId,
        `${semanaFutura.inicio} 12:00:00`
      ]
    );
    const futuro = await requisicaoJson(gerarUrl, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify({
        periodo_inicio: semanaFutura.inicio,
        periodo_fim: semanaFutura.fim,
        moeda: 'BRL'
      })
    });
    assert.strictEqual(futuro.resposta.status, 201);
    const aprovacaoAntecipada = await requisicaoJson(
      `${api.url}/api/fechamentos-fornecedores/${futuro.corpo.fechamento.id}/fechar`,
      { method: 'POST', headers: cabecalhos, body: '{}' }
    );
    assert.strictEqual(aprovacaoAntecipada.resposta.status, 409);
    assert.strictEqual(aprovacaoAntecipada.corpo.codigo, 'PERIODO_AINDA_ABERTO');

    const detalhe = await requisicaoJson(
      `${api.url}/api/fechamentos-fornecedores/${fechamentoId}`
    );
    assert.strictEqual(detalhe.resposta.status, 200);
    assert.strictEqual(detalhe.corpo.itens.length, 2);

    const [[estado]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM fechamento_fornecedor_itens
           WHERE fechamento_id = ?) AS itens,
         (SELECT COUNT(*) FROM lancamentos_financeiros
           WHERE id = ? AND tipo = 'DESPESA' AND status = 'PAGO'
             AND fornecedor_id = ? AND valor = 44) AS lancamentos,
         (SELECT COUNT(*) FROM pagamentos
           WHERE lancamento_id = ? AND referencia_externa = ?) AS pagamentos,
         (SELECT COUNT(*) FROM auditoria
           WHERE entidade = 'fechamentos_fornecedores'
             AND entidade_id = ?) AS auditorias`,
      [
        fechamentoId,
        lancamentoId,
        fornecedor.insertId,
        lancamentoId,
        referencia,
        String(fechamentoId)
      ]
    );
    assert.deepStrictEqual(
      Object.values(estado).map(Number),
      [2, 1, 1, 4]
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo LIKE ?) AS pedidos,
           (SELECT COUNT(*) FROM fornecedores WHERE nome = ?) AS fornecedores,
           (SELECT COUNT(*) FROM pagamentos WHERE referencia_externa = ?) AS pagamentos`,
        [
          `${prefixo}%`,
          `FORNECEDOR FECHAMENTO ${marcador}`,
          referencia
        ]
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
    'OK: fechamento semanal de fornecedor é apurado e pago uma única vez (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de fechamento do fornecedor: ${erro.message}`);
  process.exitCode = 1;
});
