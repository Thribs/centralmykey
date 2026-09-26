'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { cifrarToken } = require('./bling-oauth');

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

async function prepararTabelas(connection, chave) {
  await connection.query(`CREATE TEMPORARY TABLE configuracoes (
    chave VARCHAR(120) NOT NULL PRIMARY KEY, valor TEXT,
    descricao VARCHAR(255), atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TEMPORARY TABLE integracao_oauth_tokens (
    provedor ENUM('BLING') PRIMARY KEY, access_token_cifrado MEDIUMTEXT NOT NULL,
    refresh_token_cifrado MEDIUMTEXT NOT NULL, token_tipo VARCHAR(40) NOT NULL,
    escopos TEXT, access_expira_em DATETIME NOT NULL,
    refresh_expira_em DATETIME NOT NULL, atualizado_por BIGINT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TEMPORARY TABLE integracao_eventos (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, provedor VARCHAR(40) NOT NULL,
    evento_externo_id VARCHAR(160) NOT NULL, tipo VARCHAR(80) NOT NULL,
    referencia_externa VARCHAR(120), entidade VARCHAR(40), entidade_id BIGINT,
    lancamento_id BIGINT, pagamento_id BIGINT, payload_hash CHAR(64) NOT NULL,
    payload JSON NOT NULL,
    status ENUM('RECEBIDO','PROCESSADO','IGNORADO','FALHOU') DEFAULT 'RECEBIDO',
    tentativas SMALLINT UNSIGNED DEFAULT 1, erro_codigo VARCHAR(80),
    erro_detalhe VARCHAR(500), recebido_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    processado_em DATETIME, atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_evento (provedor, evento_externo_id)
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TEMPORARY TABLE integracao_produto_mapeamentos (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, provedor ENUM('WBUY','BLING') NOT NULL,
    produto_externo_id VARCHAR(160), sku VARCHAR(120), nome_externo VARCHAR(255),
    servico_id BIGINT NOT NULL, ativo TINYINT(1) DEFAULT 1,
    UNIQUE KEY uk_produto (provedor, produto_externo_id),
    UNIQUE KEY uk_sku (provedor, sku)
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TEMPORARY TABLE integracao_autoridades (
    dominio ENUM('PEDIDO','PAGAMENTO','CLIENTE','COMPRADOR','PAGADOR','FISCAL','ESTOQUE')
      PRIMARY KEY,
    autoridade ENUM('CENTRAL','WBUY','BLING','MANUAL') NOT NULL
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TEMPORARY TABLE integracao_status_mapeamentos (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, provedor ENUM('WBUY','BLING') NOT NULL,
    dominio ENUM('PEDIDO','PAGAMENTO') NOT NULL, status_externo_id VARCHAR(80) NOT NULL,
    situacao ENUM('PENDENTE','CONFIRMADO','CANCELADO','IGNORADO') NOT NULL,
    ativo TINYINT(1) DEFAULT 1
  ) ENGINE=InnoDB`);
  const [[servico]] = await connection.query(
    'SELECT id FROM servicos WHERE ativo=1 ORDER BY id LIMIT 1'
  );
  assert.ok(servico, 'É necessário ao menos um serviço ativo');
  await connection.query(
    `INSERT INTO integracao_produto_mapeamentos
       (provedor, produto_externo_id, sku, nome_externo, servico_id)
     VALUES ('BLING', '10', 'GM-BLING-TESTE', 'Produto fictício', ?)`,
    [servico.id]
  );
  await connection.query(
    `INSERT INTO integracao_status_mapeamentos
       (provedor, dominio, status_externo_id, situacao, ativo)
     VALUES ('BLING', 'PAGAMENTO', '9', 'CONFIRMADO', 1)`
  );
  await connection.query(
    `INSERT INTO integracao_oauth_tokens
       (provedor, access_token_cifrado, refresh_token_cifrado, token_tipo,
        access_expira_em, refresh_expira_em)
     VALUES ('BLING', ?, ?, 'Bearer', DATE_SUB(NOW(), INTERVAL 1 MINUTE),
             DATE_ADD(NOW(), INTERVAL 20 DAY))`,
    [cifrarToken('access-expirado-ficticio', chave),
      cifrarToken('refresh-inicial-ficticio', chave)]
  );
}

async function iniciarApi(connection) {
  const chave = Buffer.alloc(32, 9).toString('base64');
  await prepararTabelas(connection, chave);
  const chamadasOauth = [];
  const chamadasApi = [];
  let total = '22.00';
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => { req.usuario = { id: null }; next(); };
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-integracoes')(app, poolTransacional(connection), {
    configuracaoBling: {
      clientId: 'bling-client-ficticio', clientSecret: 'bling-secret-ficticio',
      redirectUri: 'https://central.invalid/api/integracoes/bling/oauth/callback',
      encryptionKey: chave, habilitado: true,
      apiUrl: 'https://api-bling.invalid/Api/v3'
    },
    tokenUrlBling: 'https://api-bling.invalid/Api/v3/oauth/token',
    transporteBlingOAuth: async (url, opcoes) => {
      chamadasOauth.push({ url: String(url), opcoes });
      return new Response(JSON.stringify({
        access_token: 'access-renovado-ficticio',
        refresh_token: 'refresh-renovado-ficticio',
        token_type: 'Bearer', expires_in: 3600, scope: 'pedidos.read'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    transporteBlingApi: async (url, opcoes) => {
      chamadasApi.push({ url: String(url), opcoes });
      const id = String(url).split('/').pop();
      if (id === '404') return new Response('{}', { status: 404 });
      if (id === '500') return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ data: {
        id: Number(id), numero: 123,
        situacao: { id: 9, valor: 1 },
        contato: { id: 55, nome: 'Cliente Bling Fictício',
          numeroDocumento: '00000000000', email: 'bling@example.invalid' },
        itens: [{ id: 1, codigo: 'GM-BLING-TESTE', quantidade: 1,
          produto: { id: 10 }, valor: total }], total
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}`,
    chamadasOauth, chamadasApi, alterarTotal: valor => { total = valor; } };
}

async function post(url) {
  const resposta = await fetch(url, { method: 'POST' });
  let corpo = {};
  try { corpo = await resposta.json(); } catch { /* sem corpo JSON */ }
  return { status: resposta.status, corpo };
}

async function fechar(servidor) {
  if (servidor) await new Promise(resolve => servidor.close(resolve));
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  let api;
  let erro;
  const pedidoId = String(Date.now()).slice(-10);
  try {
    await connection.beginTransaction();
    api = await iniciarApi(connection);

    const invalido = await post(`${api.url}/api/integracoes/bling/pedidos/abc/sincronizar`);
    assert.strictEqual(invalido.status, 400);
    assert.strictEqual(invalido.corpo.codigo, 'PEDIDO_BLING_INVALIDO');

    const primeira = await post(
      `${api.url}/api/integracoes/bling/pedidos/${pedidoId}/sincronizar`
    );
    assert.strictEqual(primeira.status, 201, JSON.stringify(primeira.corpo));
    assert.strictEqual(primeira.corpo.idempotente, false);
    assert.strictEqual(primeira.corpo.resumo.itens_total, 1);
    assert.strictEqual(primeira.corpo.resumo.possui_contato, true);
    assert.strictEqual(primeira.corpo.resumo.pronto_para_processar, false);
    assert.strictEqual(primeira.corpo.analise.produtos_total, 1);
    assert.strictEqual(primeira.corpo.analise.produtos_mapeados, 1);
    assert.strictEqual(primeira.corpo.analise.pagamento.situacao, 'CONFIRMADO');
    assert.strictEqual(primeira.corpo.analise.pronto_para_converter, false);
    assert.ok(primeira.corpo.analise.pendencias.includes('MOEDA_NAO_INFORMADA'));
    assert.ok(!JSON.stringify(primeira.corpo).includes('Cliente Bling Fictício'));
    assert.ok(!JSON.stringify(primeira.corpo).includes('00000000000'));
    assert.ok(!JSON.stringify(primeira.corpo).includes('bling@example.invalid'));
    assert.strictEqual(api.chamadasOauth.length, 1,
      'Access expirado deve renovar uma única vez');
    assert.strictEqual(api.chamadasOauth[0].opcoes.headers['enable-jwt'], '1');
    assert.strictEqual(api.chamadasOauth[0].opcoes.body,
      'grant_type=refresh_token&refresh_token=refresh-inicial-ficticio');
    assert.strictEqual(api.chamadasApi.length, 1);
    assert.strictEqual(api.chamadasApi[0].opcoes.headers.Authorization,
      'Bearer access-renovado-ficticio');
    assert.strictEqual(api.chamadasApi[0].opcoes.headers['enable-jwt'], '1');

    const previa = await fetch(
      `${api.url}/api/integracoes/bling/snapshots/${primeira.corpo.evento_id}/analise`
    );
    const previaCorpo = await previa.json();
    assert.strictEqual(previa.status, 200);
    assert.strictEqual(previaCorpo.provedor, 'BLING');
    assert.strictEqual(previaCorpo.analise.produtos_mapeados, 1);
    assert.ok(!JSON.stringify(previaCorpo).includes('Cliente Bling Fictício'));
    assert.ok(!JSON.stringify(previaCorpo).includes('00000000000'));
    assert.ok(!JSON.stringify(previaCorpo).includes('bling@example.invalid'));

    const previaInvalida = await fetch(
      `${api.url}/api/integracoes/bling/snapshots/abc/analise`
    );
    assert.strictEqual(previaInvalida.status, 400);
    const previaAusente = await fetch(
      `${api.url}/api/integracoes/bling/snapshots/999999999999/analise`
    );
    assert.strictEqual(previaAusente.status, 404);

    const repetida = await post(
      `${api.url}/api/integracoes/bling/pedidos/${pedidoId}/sincronizar`
    );
    assert.strictEqual(repetida.status, 200);
    assert.strictEqual(repetida.corpo.idempotente, true);
    assert.strictEqual(repetida.corpo.evento_id, primeira.corpo.evento_id);
    assert.strictEqual(api.chamadasOauth.length, 1);

    api.alterarTotal('25.00');
    const atualizada = await post(
      `${api.url}/api/integracoes/bling/pedidos/${pedidoId}/sincronizar`
    );
    assert.strictEqual(atualizada.status, 201);
    assert.notStrictEqual(atualizada.corpo.evento_id, primeira.corpo.evento_id);

    const ausente = await post(`${api.url}/api/integracoes/bling/pedidos/404/sincronizar`);
    assert.strictEqual(ausente.status, 404);
    assert.strictEqual(ausente.corpo.codigo, 'PEDIDO_BLING_NAO_ENCONTRADO');
    const indisponivel = await post(`${api.url}/api/integracoes/bling/pedidos/500/sincronizar`);
    assert.strictEqual(indisponivel.status, 503);
    assert.strictEqual(indisponivel.corpo.codigo, 'BLING_INDISPONIVEL');

    const [[eventos]] = await connection.query(
      `SELECT COUNT(*) AS total, SUM(referencia_externa=?) AS referencias,
              SUM(CAST(payload AS CHAR) LIKE '%Cliente Bling Fictício%') AS payloads_internos
         FROM integracao_eventos WHERE provedor='BLING'`, [BigInt(pedidoId).toString()]
    );
    assert.deepStrictEqual(Object.values(eventos).map(Number), [2, 2, 2]);
    const [[auditoria]] = await connection.query(
      `SELECT COUNT(*) AS total,
              SUM(CAST(dados_depois AS CHAR) LIKE '%Cliente Bling Fictício%'
                OR CAST(dados_depois AS CHAR) LIKE '%00000000000%'
                OR CAST(dados_depois AS CHAR) LIKE '%access-renovado-ficticio%') AS sensiveis
         FROM auditoria
        WHERE modulo='INTEGRACOES'
          AND acao IN ('RENOVAR_OAUTH_BLING','SINCRONIZAR_PEDIDO_BLING')`
    );
    assert.strictEqual(Number(auditoria.total), 4);
    assert.strictEqual(Number(auditoria.sensiveis), 0);

    const lista = await fetch(`${api.url}/api/integracoes/eventos?provedor=BLING`);
    const listaCorpo = await lista.json();
    assert.strictEqual(lista.status, 200);
    assert.strictEqual(listaCorpo.total, 2);
    assert.ok(listaCorpo.dados.every(item => !Object.hasOwn(item, 'payload')));
  } catch (falha) {
    erro = falha;
  } finally {
    try { await fechar(api?.servidor); await connection.rollback(); } catch (limpeza) {
      erro = erro || limpeza;
    } finally { await connection.end(); }
  }
  if (erro) throw erro;
  console.log('OK: Bling renova JWT, lê pedido e persiste snapshot idempotente (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: pedidos Bling: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
