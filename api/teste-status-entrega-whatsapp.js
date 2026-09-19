'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  criarTabelaOutboxTemporaria
} = require('./teste-suporte-outbox');

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

async function iniciarApi(connection) {
  const app = express();
  app.use(express.json({
    verify: (req, res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    }
  }));
  require('./rotas-whatsapp')(app, poolTransacional(connection));
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

async function enviarEvento(url, segredo, mensagemId, status, timestamp) {
  const corpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          statuses: [{ id: mensagemId, status, timestamp: String(timestamp) }]
        }
      }]
    }]
  });
  const assinatura = `sha256=${crypto
    .createHmac('sha256', segredo)
    .update(Buffer.from(corpo))
    .digest('hex')}`;
  return fetch(`${url}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': assinatura
    },
    body: corpo
  });
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const segredoOriginal = process.env.META_APP_SECRET;
  const segredoTeste = 'segredo-ficticio-webhook';
  const marcador = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const protocolo = `TW${process.pid}${String(Date.now()).slice(-6)}`;
  const mensagemId = `wamid.mock.status.${marcador}`;
  let servidor;
  let erro;

  try {
    process.env.META_APP_SECRET = segredoTeste;
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);

    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[cliente]] = await connection.query(
      'SELECT id FROM clientes WHERE ativo=1 ORDER BY id LIMIT 1'
    );
    assert.ok(servico && cliente, 'Base ativa do fluxo é obrigatória');

    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE WEBHOOK', 2026,
               'CONCLUIDO', 50, 0, 'BRL')`,
      [protocolo, cliente.id, servico.id, `9BGTW11A0${String(Date.now()).slice(-8)}`]
    );
    const [resultado] = await connection.query(
      `INSERT INTO pedido_resultados
         (pedido_id, origem_id, codigo_mecanico, resultado, custo, status)
       VALUES (?, 1, 'MC-WEBHOOK', JSON_OBJECT(), 0, 'CONFIRMADO')`,
      [pedido.insertId]
    );
    await connection.query(
      `INSERT INTO comunicacoes_outbox
         (chave_idempotencia, canal, finalidade, pedido_id, resultado_id,
          destinatario, payload, status, tentativas,
          mensagem_externa_id, enviado_em)
       VALUES (?, 'WHATSAPP', 'ENTREGA_CLIENTE', ?, ?, '5511555555555',
               JSON_OBJECT(), 'ENVIADA', 1, ?, NOW())`,
      [
        `ENTREGA_CLIENTE:${pedido.insertId}:${resultado.insertId}`,
        pedido.insertId,
        resultado.insertId,
        mensagemId
      ]
    );

    const api = await iniciarApi(connection);
    servidor = api.servidor;
    const baseTempo = Math.floor(Date.now() / 1000) - 60;

    let resposta = await enviarEvento(
      api.url,
      segredoTeste,
      mensagemId,
      'delivered',
      baseTempo + 10
    );
    assert.strictEqual(resposta.status, 200);
    let [[estado]] = await connection.query(
      `SELECT status, entregue_em, lida_em
         FROM comunicacoes_outbox WHERE mensagem_externa_id = ?`,
      [mensagemId]
    );
    assert.strictEqual(estado.status, 'ENTREGUE');
    assert.ok(estado.entregue_em);

    resposta = await enviarEvento(
      api.url,
      segredoTeste,
      mensagemId,
      'sent',
      baseTempo
    );
    assert.strictEqual(resposta.status, 200);
    [[estado]] = await connection.query(
      `SELECT status FROM comunicacoes_outbox WHERE mensagem_externa_id = ?`,
      [mensagemId]
    );
    assert.strictEqual(estado.status, 'ENTREGUE');

    resposta = await enviarEvento(
      api.url,
      segredoTeste,
      mensagemId,
      'read',
      baseTempo + 20
    );
    assert.strictEqual(resposta.status, 200);
    [[estado]] = await connection.query(
      `SELECT status, lida_em FROM comunicacoes_outbox
        WHERE mensagem_externa_id = ?`,
      [mensagemId]
    );
    assert.strictEqual(estado.status, 'LIDA');
    assert.ok(estado.lida_em);

    resposta = await enviarEvento(
      api.url,
      segredoTeste,
      mensagemId,
      'failed',
      baseTempo + 30
    );
    assert.strictEqual(resposta.status, 200);
    [[estado]] = await connection.query(
      `SELECT status FROM comunicacoes_outbox WHERE mensagem_externa_id = ?`,
      [mensagemId]
    );
    assert.strictEqual(estado.status, 'LIDA');
  } catch (falha) {
    erro = falha;
  } finally {
    if (segredoOriginal === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = segredoOriginal;
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        'SELECT COUNT(*) AS total FROM pedidos_senha WHERE protocolo = ?',
        [protocolo]
      );
      assert.strictEqual(Number(residuos.total), 0);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: webhook comprova entrega e leitura sem regressão (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de status do WhatsApp: ${erro.message}`);
  process.exitCode = 1;
});
