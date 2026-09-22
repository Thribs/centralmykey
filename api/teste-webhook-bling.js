'use strict';

const assert = require('assert');
const crypto = require('crypto');
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

function poolComSavepoint(connection) {
  let sequencia = 0;
  return {
    query: (...args) => connection.query(...args),
    getConnection: async () => {
      const nome = `webhook_bling_${++sequencia}`;
      return {
        query: (...args) => connection.query(...args),
        beginTransaction: () => connection.query(`SAVEPOINT ${nome}`),
        commit: () => connection.query(`RELEASE SAVEPOINT ${nome}`),
        rollback: async () => {
          await connection.query(`ROLLBACK TO SAVEPOINT ${nome}`);
          await connection.query(`RELEASE SAVEPOINT ${nome}`);
        },
        release: () => {}
      };
    }
  };
}

async function criarTabelaEventos(connection) {
  await connection.query(`
    CREATE TEMPORARY TABLE integracao_eventos (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      provedor VARCHAR(40) NOT NULL,
      evento_externo_id VARCHAR(160) NOT NULL,
      tipo VARCHAR(80) NOT NULL,
      referencia_externa VARCHAR(120),
      entidade VARCHAR(40),
      entidade_id BIGINT,
      lancamento_id BIGINT,
      pagamento_id BIGINT,
      payload_hash CHAR(64) NOT NULL,
      payload JSON NOT NULL,
      status ENUM('RECEBIDO','PROCESSADO','IGNORADO','FALHOU') DEFAULT 'RECEBIDO',
      tentativas SMALLINT UNSIGNED DEFAULT 1,
      erro_codigo VARCHAR(80),
      erro_detalhe VARCHAR(500),
      recebido_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      processado_em DATETIME,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_evento (provedor, evento_externo_id)
    ) ENGINE=InnoDB
  `);
}

async function iniciarApi(connection, segredo) {
  const app = express();
  app.use(express.json({
    verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); }
  }));
  app.locals.autenticarToken = (req, res, next) => next();
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-integracoes')(app, poolComSavepoint(connection), {
    configuracaoBling: { clientSecret: segredo }
  });
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function fechar(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

function assinar(segredo, corpo) {
  return `sha256=${crypto.createHmac('sha256', segredo)
    .update(Buffer.from(corpo)).digest('hex')}`;
}

async function enviar(url, segredo, payload, opcoes = {}) {
  const corpo = JSON.stringify(payload);
  const assinatura = opcoes.assinatura === false
    ? 'sha256='.padEnd(71, '0')
    : assinar(segredo, corpo);
  const resposta = await fetch(`${url}/webhooks/bling`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bling-Signature-256': assinatura
    },
    body: corpo
  });
  return { resposta, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const segredo = 'client-secret-ficticio-bling';
  const marcador = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const eventoId = `evt-bling-${marcador}`;
  let servidor;
  let erro;
  try {
    await connection.beginTransaction();
    await criarTabelaEventos(connection);
    const api = await iniciarApi(connection, segredo);
    servidor = api.servidor;
    const evento = {
      eventId: eventoId,
      date: new Date().toISOString(),
      version: 'v1',
      event: 'order.created',
      companyId: 123456,
      data: {
        id: 987654,
        numero: 123,
        numeroLoja: `LOJA-${marcador}`,
        total: 50,
        contato: { id: 111 },
        situacao: { id: 222, valor: 1 }
      }
    };

    const assinaturaInvalida = await enviar(api.url, segredo, evento, {
      assinatura: false
    });
    assert.strictEqual(assinaturaInvalida.resposta.status, 401);

    const primeira = await enviar(api.url, segredo, evento);
    assert.strictEqual(primeira.resposta.status, 202);
    assert.strictEqual(primeira.corpo.status, 'RECEBIDO');
    assert.strictEqual(primeira.corpo.idempotente, false);

    const repetida = await enviar(api.url, segredo, evento);
    assert.strictEqual(repetida.resposta.status, 200);
    assert.strictEqual(repetida.corpo.idempotente, true);
    assert.strictEqual(repetida.corpo.evento_id, primeira.corpo.evento_id);
    assert.strictEqual(repetida.corpo.tentativas, 2);

    const colisao = await enviar(api.url, segredo, {
      ...evento,
      data: { ...evento.data, total: 999 }
    });
    assert.strictEqual(colisao.resposta.status, 409);
    assert.strictEqual(colisao.corpo.codigo, 'COLISAO_EVENTO_BLING');

    const ignorado = await enviar(api.url, segredo, {
      ...evento,
      eventId: `${eventoId}-produto`,
      event: 'product.updated',
      data: { id: 555, nome: 'Produto fictício' }
    });
    assert.strictEqual(ignorado.resposta.status, 202);
    assert.strictEqual(ignorado.corpo.status, 'IGNORADO');

    const [[estado]] = await connection.query(
      `SELECT
         SUM(status='RECEBIDO') AS recebidos,
         SUM(status='IGNORADO') AS ignorados,
         MAX(CASE WHEN evento_externo_id=? THEN tentativas END) AS tentativas,
         COUNT(*) AS total
       FROM integracao_eventos WHERE provedor='BLING'`,
      [eventoId]
    );
    assert.deepStrictEqual(Object.values(estado).map(Number), [1, 1, 2, 2]);

    const lista = await fetch(
      `${api.url}/api/integracoes/eventos?provedor=BLING`
    );
    const listaCorpo = await lista.json();
    assert.strictEqual(lista.status, 200);
    assert.strictEqual(listaCorpo.total, 2);
    assert.ok(listaCorpo.dados.every(item => !Object.hasOwn(item, 'payload')));
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fechar(servidor);
      await connection.rollback();
    } catch (limpeza) {
      erro = erro || limpeza;
    } finally {
      await connection.end();
    }
  }
  if (erro) throw erro;
  console.log(
    'OK: webhook Bling valida HMAC, persiste eventos idempotentes e não cria pedidos'
  );
}

executar().catch(erro => {
  console.error(`FALHA: webhook Bling: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
