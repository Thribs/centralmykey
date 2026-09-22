'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

dotenv.config({ path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'), quiet: true });
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

const configBanco = {
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME
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

async function criarTabelaEventos(connection) {
  await connection.query(`CREATE TEMPORARY TABLE integracao_eventos (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provedor VARCHAR(40) NOT NULL, evento_externo_id VARCHAR(160) NOT NULL,
    tipo VARCHAR(80) NOT NULL, referencia_externa VARCHAR(120),
    entidade VARCHAR(40), entidade_id BIGINT, lancamento_id BIGINT, pagamento_id BIGINT,
    payload_hash CHAR(64) NOT NULL, payload JSON NOT NULL,
    status ENUM('RECEBIDO','PROCESSADO','IGNORADO','FALHOU') DEFAULT 'RECEBIDO',
    tentativas SMALLINT UNSIGNED DEFAULT 1, erro_codigo VARCHAR(80),
    erro_detalhe VARCHAR(500), recebido_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    processado_em DATETIME,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_evento (provedor, evento_externo_id)
  ) ENGINE=InnoDB`);
}

function pedido(id, total = '22.00') {
  return {
    id: String(id), identificacao: `WBUY-${id}`,
    status: { id: '2', nome: 'Pagamento confirmado' },
    cliente: { id: '55', nome: 'Cliente Fictício WBuy',
      email: 'cliente.ficticio@example.invalid', telefone1: '(00) 00000-0000',
      doc1: '000.000.000-00' },
    produtos: [{ produto_id: '10', produto: 'Consulta GM fictícia',
      sku: 'GM-TESTE', qtd: '1', valor: total }],
    valor_total: { subtotal: total, desconto: '0', total }
  };
}

async function iniciarApi(connection) {
  let total = '22.00';
  const chamadas = [];
  const transporte = async (url, opcoes) => {
    chamadas.push({ url: String(url), opcoes });
    const id = String(url).split('/').pop();
    if (id === '404') return new Response(JSON.stringify({ data: [] }), { status: 404 });
    if (id === '500') return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ code: '010', message: 'success',
      responseCode: '200', total: '1', data: [pedido(id, total)] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => { req.usuario = { id: null }; next(); };
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-integracoes')(app, poolTransacional(connection), {
    configuracaoWBuy: { usuario: 'usuario-wbuy-ficticio', senha: 'senha-wbuy-ficticia',
      apiUrl: 'https://wbuy.invalid/api/v1' },
    transporteWBuy: transporte
  });
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}`, chamadas,
    alterarTotal: valor => { total = valor; } };
}

async function fechar(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => servidor.close(e => e ? reject(e) : resolve()));
}

async function post(url) {
  const resposta = await fetch(url, { method: 'POST' });
  return { status: resposta.status, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  let servidor;
  let erro;
  const pedidoId = String(Date.now()).slice(-10);
  try {
    await connection.beginTransaction();
    await criarTabelaEventos(connection);
    const api = await iniciarApi(connection);
    servidor = api.servidor;

    const invalido = await post(`${api.url}/api/integracoes/wbuy/pedidos/abc/sincronizar`);
    assert.strictEqual(invalido.status, 400);
    assert.strictEqual(invalido.corpo.codigo, 'PEDIDO_WBUY_INVALIDO');

    const primeira = await post(`${api.url}/api/integracoes/wbuy/pedidos/${pedidoId}/sincronizar`);
    assert.strictEqual(primeira.status, 201);
    assert.strictEqual(primeira.corpo.idempotente, false);
    assert.strictEqual(primeira.corpo.status, 'RECEBIDO');
    assert.strictEqual(primeira.corpo.pedido_externo_id, pedidoId);

    const chamada = api.chamadas.at(-1);
    assert.strictEqual(chamada.url, `https://wbuy.invalid/api/v1/order/${pedidoId}`);
    assert.strictEqual(chamada.opcoes.method, 'GET');
    assert.strictEqual(chamada.opcoes.headers.Authorization,
      `Bearer ${Buffer.from('usuario-wbuy-ficticio:senha-wbuy-ficticia').toString('base64')}`);
    assert.match(chamada.opcoes.headers['User-Agent'], /^CentralMyKey\//);

    const repetida = await post(`${api.url}/api/integracoes/wbuy/pedidos/${pedidoId}/sincronizar`);
    assert.strictEqual(repetida.status, 200);
    assert.strictEqual(repetida.corpo.idempotente, true);
    assert.strictEqual(repetida.corpo.evento_id, primeira.corpo.evento_id);
    assert.strictEqual(repetida.corpo.tentativas, 2);

    api.alterarTotal('25.00');
    const atualizado = await post(`${api.url}/api/integracoes/wbuy/pedidos/${pedidoId}/sincronizar`);
    assert.strictEqual(atualizado.status, 201);
    assert.strictEqual(atualizado.corpo.idempotente, false);
    assert.notStrictEqual(atualizado.corpo.evento_id, primeira.corpo.evento_id);

    const ausente = await post(`${api.url}/api/integracoes/wbuy/pedidos/404/sincronizar`);
    assert.strictEqual(ausente.status, 404);
    assert.strictEqual(ausente.corpo.codigo, 'PEDIDO_WBUY_NAO_ENCONTRADO');
    const indisponivel = await post(`${api.url}/api/integracoes/wbuy/pedidos/500/sincronizar`);
    assert.strictEqual(indisponivel.status, 503);
    assert.strictEqual(indisponivel.corpo.codigo, 'WBUY_INDISPONIVEL');

    const [[estado]] = await connection.query(
      `SELECT COUNT(*) AS eventos, SUM(referencia_externa=?) AS referencias,
              SUM(tipo='ORDER.SNAPSHOT' AND status='RECEBIDO') AS recebidos
         FROM integracao_eventos WHERE provedor='WBUY'`, [pedidoId]
    );
    assert.deepStrictEqual(Object.values(estado).map(Number), [2, 2, 2]);
    const [[auditoria]] = await connection.query(
      `SELECT COUNT(*) AS total,
              SUM(CAST(dados_depois AS CHAR) LIKE '%cliente.ficticio%'
                OR CAST(dados_depois AS CHAR) LIKE '%000.000.000-00%'
                OR CAST(dados_depois AS CHAR) LIKE '%senha-wbuy%') AS sensiveis
         FROM auditoria
        WHERE modulo='INTEGRACOES' AND acao='SINCRONIZAR_PEDIDO_WBUY'
          AND JSON_UNQUOTE(JSON_EXTRACT(dados_depois, '$.pedido_externo_id'))=?`, [pedidoId]
    );
    assert.strictEqual(Number(auditoria.total), 3);
    assert.strictEqual(Number(auditoria.sensiveis), 0);

    const lista = await fetch(`${api.url}/api/integracoes/eventos?provedor=WBUY`);
    const listaCorpo = await lista.json();
    assert.strictEqual(lista.status, 200);
    assert.strictEqual(listaCorpo.total, 2);
    assert.ok(listaCorpo.dados.every(item => !Object.hasOwn(item, 'payload')));
  } catch (falha) {
    erro = falha;
  } finally {
    try { await fechar(servidor); await connection.rollback(); } catch (limpeza) {
      erro = erro || limpeza;
    } finally { await connection.end(); }
  }
  if (erro) throw erro;
  console.log('OK: WBuy consulta mockada, snapshots idempotentes e rollback integral');
}

executar().catch(erro => {
  console.error(`FALHA: integração WBuy: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
