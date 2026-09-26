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
  let auditoriasStatusAntes = 0;
  let auditoriasPoliticaAntes = 0;
  try {
    const [[base]] = await connection.query(
      "SELECT COUNT(*) AS total FROM auditoria WHERE entidade='integracao_autoridades'"
    );
    auditoriasAntes = Number(base.total);
    const [[baseStatus]] = await connection.query(
      "SELECT COUNT(*) AS total FROM auditoria WHERE entidade='integracao_status_mapeamentos'"
    );
    auditoriasStatusAntes = Number(baseStatus.total);
    const [[basePolitica]] = await connection.query(
      "SELECT COUNT(*) AS total FROM auditoria WHERE entidade='configuracoes_integracoes_comercio'"
    );
    auditoriasPoliticaAntes = Number(basePolitica.total);
    await connection.beginTransaction();
    await connection.query(`CREATE TEMPORARY TABLE integracao_autoridades (
      dominio ENUM('PEDIDO','PAGAMENTO','CLIENTE','COMPRADOR','PAGADOR','FISCAL','ESTOQUE')
        NOT NULL PRIMARY KEY,
      autoridade ENUM('CENTRAL','WBUY','BLING','MANUAL') NOT NULL,
      atualizado_por BIGINT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    await connection.query(`CREATE TEMPORARY TABLE integracao_status_mapeamentos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      provedor ENUM('WBUY','BLING') NOT NULL,
      dominio ENUM('PEDIDO','PAGAMENTO') NOT NULL,
      status_externo_id VARCHAR(80) NOT NULL,
      status_externo_nome VARCHAR(160),
      situacao ENUM('PENDENTE','CONFIRMADO','CANCELADO','IGNORADO') NOT NULL,
      ativo TINYINT(1) DEFAULT 1,
      criado_por BIGINT, atualizado_por BIGINT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_status (provedor, dominio, status_externo_id)
    ) ENGINE=InnoDB`);
    await connection.query(`CREATE TEMPORARY TABLE configuracoes (
      chave VARCHAR(120) NOT NULL PRIMARY KEY, valor TEXT,
      descricao VARCHAR(255), atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP
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

    resposta = await requisitar(`${api.url}/api/integracoes/mapeamentos-status`);
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(resposta.corpo.total, 0);

    resposta = await requisitar(`${api.url}/api/integracoes/politicas-comercio`);
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(resposta.corpo.dados.length, 2);
    assert.ok(resposta.corpo.dados.every(item => !item.moeda_definida));
    resposta = await requisitar(
      `${api.url}/api/integracoes/politicas-comercio/WBUY`, 'PUT',
      { moeda: 'EUR', identidades: { cliente: 'ORIGEM_EXTERNA',
        comprador: 'ORIGEM_EXTERNA', pagador: 'ORIGEM_EXTERNA' } }
    );
    assert.strictEqual(resposta.status, 400);
    const politica = { moeda: 'BRL', identidades: {
      cliente: 'CADASTRO_CENTRAL', comprador: 'ORIGEM_EXTERNA', pagador: 'MANUAL'
    } };
    resposta = await requisitar(
      `${api.url}/api/integracoes/politicas-comercio/WBUY`, 'PUT', politica,
      { 'x-negar': 'INTEGRACOES:editar' }
    );
    assert.strictEqual(resposta.status, 403);
    resposta = await requisitar(
      `${api.url}/api/integracoes/politicas-comercio/WBUY`, 'PUT', politica
    );
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(resposta.corpo.alterada, true);
    assert.strictEqual(resposta.corpo.dados.moeda, 'BRL');
    assert.strictEqual(resposta.corpo.dados.identidades.pagador, 'MANUAL');
    resposta = await requisitar(
      `${api.url}/api/integracoes/politicas-comercio/WBUY`, 'PUT', politica
    );
    assert.strictEqual(resposta.corpo.alterada, false);
    resposta = await requisitar(`${api.url}/api/integracoes/prontidao-comercio`);
    assert.strictEqual(resposta.status, 200);
    assert.ok(!resposta.corpo.bloqueios.includes('MOEDA_WBUY_NAO_DEFINIDA'));
    assert.ok(!resposta.corpo.bloqueios.includes('RECONCILIACAO_IDENTIDADES_NAO_DEFINIDA'));
    assert.strictEqual(resposta.corpo.politica_wbuy.identidades_definidas, true);
    resposta = await requisitar(
      `${api.url}/api/integracoes/mapeamentos-status`, 'POST',
      { provedor: 'WBUY', dominio: 'PAGAMENTO', status_externo_id: '2',
        status_externo_nome: 'Pagamento confirmado', situacao: 'CONFIRMADO' }
    );
    assert.strictEqual(resposta.status, 201);
    const statusId = resposta.corpo.dados.id;
    resposta = await requisitar(
      `${api.url}/api/integracoes/mapeamentos-status`, 'POST',
      { provedor: 'WBUY', dominio: 'PAGAMENTO', status_externo_id: '2',
        status_externo_nome: 'Pagamento confirmado', situacao: 'CONFIRMADO' }
    );
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(resposta.corpo.alterada, false);
    assert.strictEqual(resposta.corpo.dados.id, statusId);

    const [[estado]] = await connection.query(
      `SELECT COUNT(*) AS autoridades,
              (SELECT COUNT(*) FROM auditoria
                WHERE entidade='integracao_autoridades') AS auditorias
         FROM integracao_autoridades`
    );
    assert.strictEqual(Number(estado.autoridades), 1);
    assert.strictEqual(Number(estado.auditorias), auditoriasAntes + 2);
    const [[estadoStatus]] = await connection.query(
      `SELECT COUNT(*) AS mapeamentos,
              (SELECT COUNT(*) FROM auditoria
                WHERE entidade='integracao_status_mapeamentos') AS auditorias
         FROM integracao_status_mapeamentos`
    );
    assert.strictEqual(Number(estadoStatus.mapeamentos), 1);
    assert.strictEqual(Number(estadoStatus.auditorias), auditoriasStatusAntes + 1);
    const [[politicaPersistida]] = await connection.query(
      `SELECT COUNT(*) AS configuracoes,
              (SELECT COUNT(*) FROM auditoria
                WHERE entidade='configuracoes_integracoes_comercio') AS auditorias
         FROM configuracoes WHERE chave LIKE 'INTEGRACAO_WBUY_%'`
    );
    assert.strictEqual(Number(politicaPersistida.configuracoes), 4);
    assert.strictEqual(Number(politicaPersistida.auditorias), auditoriasPoliticaAntes + 1);
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
      const [[residuosStatus]] = await connection.query(
        "SELECT COUNT(*) AS total FROM auditoria WHERE entidade='integracao_status_mapeamentos'"
      );
      assert.strictEqual(Number(residuosStatus.total), auditoriasStatusAntes);
      const [[residuosPolitica]] = await connection.query(
        "SELECT COUNT(*) AS total FROM auditoria WHERE entidade='configuracoes_integracoes_comercio'"
      );
      assert.strictEqual(Number(residuosPolitica.total), auditoriasPoliticaAntes);
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
