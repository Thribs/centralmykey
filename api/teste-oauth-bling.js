'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { descriptografarToken } = require('./bling-oauth');

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

async function prepararTabelas(connection) {
  await connection.query(`CREATE TEMPORARY TABLE integracao_oauth_estados (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, provedor ENUM('BLING') NOT NULL,
    state_hash CHAR(64) NOT NULL, usuario_id BIGINT, expira_em DATETIME NOT NULL,
    usado_em DATETIME, criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_estado (provedor, state_hash)
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TEMPORARY TABLE integracao_oauth_tokens (
    provedor ENUM('BLING') PRIMARY KEY, access_token_cifrado MEDIUMTEXT NOT NULL,
    refresh_token_cifrado MEDIUMTEXT NOT NULL, token_tipo VARCHAR(40) NOT NULL,
    escopos TEXT, access_expira_em DATETIME NOT NULL,
    refresh_expira_em DATETIME NOT NULL, atualizado_por BIGINT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
}

async function iniciarApi(connection) {
  const chamadas = [];
  const chave = Buffer.alloc(32, 7).toString('base64');
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = { id: null }; next();
  };
  app.locals.exigirPermissao = (modulo, acao) => (req, res, next) => {
    if (req.headers['x-negar'] === `${modulo}:${acao}`) {
      return res.status(403).json({ ok: false, error: 'Permissão negada' });
    }
    next();
  };
  require('./rotas-integracoes')(app, poolTransacional(connection), {
    configuracaoBling: {
      clientId: 'client-id-ficticio', clientSecret: 'client-secret-ficticio',
      redirectUri: 'https://central.invalid/api/integracoes/bling/oauth/callback',
      encryptionKey: chave, habilitado: true
    },
    authorizationUrlBling: 'https://bling.invalid/Api/v3/oauth/authorize',
    tokenUrlBling: 'https://bling.invalid/Api/v3/oauth/token',
    transporteBlingOAuth: async (url, opcoes) => {
      chamadas.push({ url: String(url), opcoes });
      const renovacao = new URLSearchParams(opcoes.body).get('grant_type') === 'refresh_token';
      return new Response(JSON.stringify({
        access_token: renovacao ? 'access-token-renovado-ficticio' : 'access-token-ficticio',
        refresh_token: renovacao ? 'refresh-token-renovado-ficticio' : 'refresh-token-ficticio',
        token_type: 'Bearer', expires_in: 3600, scope: 'pedidos.read'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}`,
    chamadas, chave };
}

async function fechar(servidor) {
  if (servidor) await new Promise(resolve => servidor.close(resolve));
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  let api;
  let erro;
  try {
    await connection.beginTransaction();
    await prepararTabelas(connection);
    api = await iniciarApi(connection);

    const antes = await fetch(`${api.url}/api/integracoes/bling/oauth/status`);
    const statusAntes = await antes.json();
    assert.strictEqual(antes.status, 200);
    assert.strictEqual(statusAntes.configurado, true);
    assert.strictEqual(statusAntes.habilitado, true);
    assert.strictEqual(statusAntes.conectado, false);

    const negada = await fetch(`${api.url}/api/integracoes/bling/oauth/iniciar`, {
      method: 'POST', headers: { 'x-negar': 'INTEGRACOES:editar' }
    });
    assert.strictEqual(negada.status, 403);

    const inicio = await fetch(`${api.url}/api/integracoes/bling/oauth/iniciar`, {
      method: 'POST'
    });
    const corpoInicio = await inicio.json();
    assert.strictEqual(inicio.status, 201);
    const autorizacao = new URL(corpoInicio.autorizacao_url);
    assert.strictEqual(autorizacao.origin, 'https://bling.invalid');
    assert.strictEqual(autorizacao.searchParams.get('response_type'), 'code');
    assert.strictEqual(autorizacao.searchParams.get('client_id'), 'client-id-ficticio');
    const state = autorizacao.searchParams.get('state');
    assert.ok(state && state.length >= 40);
    assert.ok(!corpoInicio.autorizacao_url.includes('client-secret-ficticio'));

    const [[estado]] = await connection.query(
      'SELECT state_hash, usado_em FROM integracao_oauth_estados LIMIT 1'
    );
    assert.strictEqual(estado.usado_em, null);
    assert.ok(!estado.state_hash.includes(state));

    const callback = await fetch(
      `${api.url}/api/integracoes/bling/oauth/callback?code=codigo-ficticio&state=${encodeURIComponent(state)}`
    );
    const pagina = await callback.text();
    assert.strictEqual(callback.status, 200);
    assert.match(pagina, /Bling conectado/);
    assert.ok(!pagina.includes('access-token-ficticio'));
    assert.strictEqual(api.chamadas.length, 1);
    const chamada = api.chamadas[0];
    assert.strictEqual(chamada.url, 'https://bling.invalid/Api/v3/oauth/token');
    assert.strictEqual(chamada.opcoes.headers['enable-jwt'], '1');
    assert.ok(chamada.opcoes.headers.Authorization.startsWith('Basic '));
    assert.strictEqual(chamada.opcoes.body,
      'grant_type=authorization_code&code=codigo-ficticio');

    const [[token]] = await connection.query(
      `SELECT access_token_cifrado, refresh_token_cifrado, token_tipo,
              access_expira_em, refresh_expira_em
         FROM integracao_oauth_tokens WHERE provedor='BLING'`
    );
    assert.ok(token);
    assert.ok(!token.access_token_cifrado.includes('access-token-ficticio'));
    assert.ok(!token.refresh_token_cifrado.includes('refresh-token-ficticio'));
    assert.strictEqual(descriptografarToken(token.access_token_cifrado, api.chave),
      'access-token-ficticio');
    assert.strictEqual(descriptografarToken(token.refresh_token_cifrado, api.chave),
      'refresh-token-ficticio');

    const repetida = await fetch(
      `${api.url}/api/integracoes/bling/oauth/callback?code=codigo-ficticio&state=${encodeURIComponent(state)}`
    );
    assert.strictEqual(repetida.status, 400);
    assert.strictEqual(api.chamadas.length, 1,
      'State reutilizado não pode trocar o mesmo código novamente');

    const depois = await fetch(`${api.url}/api/integracoes/bling/oauth/status`);
    const statusDepois = await depois.json();
    assert.strictEqual(statusDepois.conectado, true);
    assert.strictEqual(statusDepois.access_token_valido, true);
    assert.ok(!Object.hasOwn(statusDepois, 'access_token'));
    assert.ok(!Object.hasOwn(statusDepois, 'refresh_token'));

    const renovacao = await fetch(`${api.url}/api/integracoes/bling/oauth/renovar`, {
      method: 'POST'
    });
    assert.strictEqual(renovacao.status, 200);
    assert.strictEqual((await renovacao.json()).conectado, true);
    assert.strictEqual(api.chamadas.length, 2);
    assert.strictEqual(api.chamadas[1].opcoes.body,
      'grant_type=refresh_token&refresh_token=refresh-token-ficticio');
    const [[renovado]] = await connection.query(
      `SELECT access_token_cifrado, refresh_token_cifrado
         FROM integracao_oauth_tokens WHERE provedor='BLING'`
    );
    assert.strictEqual(descriptografarToken(renovado.access_token_cifrado, api.chave),
      'access-token-renovado-ficticio');
    assert.strictEqual(descriptografarToken(renovado.refresh_token_cifrado, api.chave),
      'refresh-token-renovado-ficticio');

    const [[auditoria]] = await connection.query(
      `SELECT COUNT(*) AS total,
              SUM(CAST(dados_depois AS CHAR) LIKE '%access-token-ficticio%'
                OR CAST(dados_depois AS CHAR) LIKE '%refresh-token-ficticio%'
                OR CAST(dados_depois AS CHAR) LIKE '%token-renovado-ficticio%'
                OR CAST(dados_depois AS CHAR) LIKE '%client-secret-ficticio%') AS segredos
         FROM auditoria
        WHERE modulo='INTEGRACOES'
          AND acao IN ('INICIAR_OAUTH_BLING','CONECTAR_OAUTH_BLING',
                       'RENOVAR_OAUTH_BLING')`
    );
    assert.strictEqual(Number(auditoria.total), 3);
    assert.strictEqual(Number(auditoria.segredos), 0);
  } catch (falha) {
    erro = falha;
  } finally {
    try { await fechar(api?.servidor); await connection.rollback(); } catch (limpeza) {
      erro = erro || limpeza;
    } finally { await connection.end(); }
  }
  if (erro) throw erro;
  console.log('OK: OAuth Bling usa state único, JWT e tokens cifrados (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: OAuth Bling: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
