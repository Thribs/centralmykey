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

async function enviarFalhaSendPulse(url, token, botId, telefone, mensagemId) {
  return fetch(`${url}/webhooks/sendpulse/whatsapp/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      service: 'whatsapp', title: 'failed_delivery',
      bot: { id: botId }, contact: { phone: telefone },
      info: {
        timestamp: Math.floor(Date.now() / 1000),
        error_message: 'Falha fictícia de entrega',
        error_code: 470,
        message_id: mensagemId
      }
    }])
  });
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const segredoOriginal = process.env.META_APP_SECRET;
  const provedorOriginal = process.env.WHATSAPP_PROVEDOR;
  const botOriginal = process.env.SENDPULSE_WHATSAPP_BOT_ID;
  const tokenOriginal = process.env.SENDPULSE_WEBHOOK_TOKEN;
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

    const tokenSendPulse = 'token_sendpulse_status_1234567890123456';
    const botSendPulse = 'bot-sendpulse-status-ficticio';
    const telefoneSendPulse = '5511555555555';
    const [atendimento] = await connection.query(
      `INSERT INTO atendimentos
         (protocolo, cliente_id, telefone, telefone_normalizado, canal,
          modo, status, prioridade, assunto, ultima_mensagem_em)
       VALUES (?, ?, ?, ?, 'WHATSAPP', 'ELETRONICO', 'EM_ATENDIMENTO',
               'NORMAL', 'Teste falha SendPulse', NOW())`,
      [`ATD-SP-${marcador}`, cliente.id, telefoneSendPulse, telefoneSendPulse]
    );
    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, tipo, descricao, dados)
       VALUES (?, 'ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO', 'Teste',
               JSON_OBJECT('atendimento_id', ?))`,
      [pedido.insertId, atendimento.insertId]
    );
    await connection.query(
      `UPDATE comunicacoes_outbox
          SET status='ENVIADA', mensagem_externa_id='sendpulse:referencia-local',
              destinatario=?, enviado_em=NOW(), erro_codigo=NULL, erro_detalhe=NULL
        WHERE pedido_id=?`,
      [telefoneSendPulse, pedido.insertId]
    );
    process.env.WHATSAPP_PROVEDOR = 'SENDPULSE';
    process.env.SENDPULSE_WHATSAPP_BOT_ID = botSendPulse;
    process.env.SENDPULSE_WEBHOOK_TOKEN = tokenSendPulse;

    resposta = await enviarFalhaSendPulse(
      api.url, tokenSendPulse, botSendPulse, telefoneSendPulse,
      'mensagem-sendpulse-sem-correlacao-direta'
    );
    assert.strictEqual(resposta.status, 200);
    const [[falhaSendPulse]] = await connection.query(
      `SELECT co.status, co.erro_codigo, a.modo, a.prioridade,
              (SELECT COUNT(*) FROM atendimento_mensagens m
                WHERE m.atendimento_id=a.id AND m.direcao='INTERNA'
                  AND m.texto LIKE 'Encaminhado para atendimento humano:%') AS avisos
         FROM comunicacoes_outbox co
         JOIN pedido_historico ph ON ph.pedido_id=co.pedido_id
          AND ph.tipo='ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO'
         JOIN atendimentos a ON a.id=CAST(JSON_UNQUOTE(
           JSON_EXTRACT(ph.dados, '$.atendimento_id')) AS UNSIGNED)
        WHERE co.pedido_id=? LIMIT 1`,
      [pedido.insertId]
    );
    assert.deepStrictEqual({
      status: falhaSendPulse.status,
      erro: falhaSendPulse.erro_codigo,
      modo: falhaSendPulse.modo,
      prioridade: falhaSendPulse.prioridade,
      avisos: Number(falhaSendPulse.avisos)
    }, {
      status: 'INCERTA', erro: 'SENDPULSE_470',
      modo: 'HUMANO', prioridade: 'ALTA', avisos: 1
    });

    resposta = await enviarFalhaSendPulse(
      api.url, tokenSendPulse, botSendPulse, telefoneSendPulse,
      'mensagem-sendpulse-sem-correlacao-direta'
    );
    assert.strictEqual(resposta.status, 200);
    const [[duplicada]] = await connection.query(
      `SELECT COUNT(*) AS avisos FROM atendimento_mensagens
        WHERE atendimento_id=? AND direcao='INTERNA'
          AND texto LIKE 'Encaminhado para atendimento humano:%'`,
      [atendimento.insertId]
    );
    assert.strictEqual(Number(duplicada.avisos), 1);
  } catch (falha) {
    erro = falha;
  } finally {
    if (segredoOriginal === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = segredoOriginal;
    if (provedorOriginal === undefined) delete process.env.WHATSAPP_PROVEDOR;
    else process.env.WHATSAPP_PROVEDOR = provedorOriginal;
    if (botOriginal === undefined) delete process.env.SENDPULSE_WHATSAPP_BOT_ID;
    else process.env.SENDPULSE_WHATSAPP_BOT_ID = botOriginal;
    if (tokenOriginal === undefined) delete process.env.SENDPULSE_WEBHOOK_TOKEN;
    else process.env.SENDPULSE_WEBHOOK_TOKEN = tokenOriginal;
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
    'OK: webhooks Meta e SendPulse atualizam entrega e escalam falha (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de status do WhatsApp: ${erro.message}`);
  process.exitCode = 1;
});
