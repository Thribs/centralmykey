'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'), quiet: true
});
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

const configBanco = {
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

function poolTransacional(connection) {
  return {
    query: (...args) => connection.query(...args),
    getConnection: async () => ({
      query: (...args) => connection.query(...args),
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
      release: () => {}
    })
  };
}

async function iniciarApi(connection) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = { id: null };
    next();
  };
  app.locals.exigirPermissao = (modulo, acao) => (req, res, next) => {
    if (req.headers['x-negar'] === `${modulo}:${acao}`) {
      return res.status(403).json({ ok: false, error: 'Permissão negada' });
    }
    next();
  };
  require('./rotas-mapeamentos-integracoes')(app, poolTransacional(connection));
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function requisitar(url, metodo = 'GET', corpo, headers = {}) {
  const resposta = await fetch(url, {
    method: metodo,
    headers: { ...(corpo ? { 'content-type': 'application/json' } : {}), ...headers },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  return { status: resposta.status, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  let servidor;
  let erro;
  let auditoriasAntes = 0;
  try {
    const [[base]] = await connection.query(
      "SELECT COUNT(*) AS total FROM auditoria WHERE entidade='integracao_autoridades'"
    );
    auditoriasAntes = Number(base.total);
    await connection.beginTransaction();
    await connection.query(`CREATE TEMPORARY TABLE integracao_autoridades (
      dominio ENUM('PEDIDO','PAGAMENTO','CLIENTE','COMPRADOR','PAGADOR','FISCAL','ESTOQUE')
        NOT NULL PRIMARY KEY,
      autoridade ENUM('CENTRAL','WBUY','BLING','MANUAL') NOT NULL,
      atualizado_por BIGINT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    const api = await iniciarApi(connection);
    servidor = api.servidor;

    let resposta = await requisitar(`${api.url}/api/integracoes/autoridades`);
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(resposta.corpo.completa, false);
    assert.strictEqual(resposta.corpo.dados.length, 7);
    assert.strictEqual(resposta.corpo.pendentes.length, 7);
    assert.ok(resposta.corpo.dados.every(item => item.autoridade === null));

    resposta = await requisitar(
      `${api.url}/api/integracoes/autoridades/PEDIDO`, 'PUT',
      { autoridade: 'WBUY' }, { 'x-negar': 'INTEGRACOES:editar' }
    );
    assert.strictEqual(resposta.status, 403);

    resposta = await requisitar(
      `${api.url}/api/integracoes/autoridades/INVALIDO`, 'PUT',
      { autoridade: 'WBUY' }
    );
    assert.strictEqual(resposta.status, 400);

    resposta = await requisitar(
      `${api.url}/api/integracoes/autoridades/PEDIDO`, 'PUT',
      { autoridade: 'WBUY' }
    );
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(resposta.corpo.alterada, true);

    resposta = await requisitar(
      `${api.url}/api/integracoes/autoridades/PEDIDO`, 'PUT',
      { autoridade: 'WBUY' }
    );
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(resposta.corpo.alterada, false);

    resposta = await requisitar(
      `${api.url}/api/integracoes/autoridades/PEDIDO`, 'PUT',
      { autoridade: 'CENTRAL' }
    );
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(resposta.corpo.alterada, true);

    resposta = await requisitar(`${api.url}/api/integracoes/autoridades`);
    assert.strictEqual(resposta.corpo.dados.find(item => item.dominio === 'PEDIDO').autoridade,
      'CENTRAL');
    assert.strictEqual(resposta.corpo.pendentes.length, 6);

    const [[estado]] = await connection.query(
      `SELECT COUNT(*) AS autoridades,
              (SELECT COUNT(*) FROM auditoria
                WHERE entidade='integracao_autoridades') AS auditorias
         FROM integracao_autoridades`
    );
    assert.strictEqual(Number(estado.autoridades), 1);
    assert.strictEqual(Number(estado.auditorias), auditoriasAntes + 2);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      if (servidor) await new Promise((resolve, reject) =>
        servidor.close(e => e ? reject(e) : resolve()));
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT (SELECT COUNT(*) FROM auditoria
                  WHERE entidade='integracao_autoridades') AS auditorias`
      );
      assert.strictEqual(Number(residuos.auditorias), auditoriasAntes);
    } catch (limpeza) {
      erro = erro || limpeza;
    } finally {
      await connection.end();
    }
  }
  if (erro) throw erro;
  console.log('OK: matriz de autoridade é restrita, idempotente, auditada e revertida');
}

executar().catch(erro => {
  console.error(`FALHA: autoridades de integração: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
