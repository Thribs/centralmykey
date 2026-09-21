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

async function iniciarApi(connection) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = { id: null };
    next();
  };
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-mapeamentos-integracoes')(app, poolTransacional(connection));
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function requisitar(url, metodo = 'GET', corpo) {
  const resposta = await fetch(url, {
    method: metodo,
    headers: corpo ? { 'content-type': 'application/json' } : undefined,
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
    const [[baseAuditoria]] = await connection.query(
      "SELECT COUNT(*) AS total FROM auditoria WHERE entidade='integracao_produto_mapeamentos'"
    );
    auditoriasAntes = Number(baseAuditoria.total);
    await connection.beginTransaction();
    await connection.query(`CREATE TEMPORARY TABLE integracao_produto_mapeamentos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      provedor ENUM('WBUY','BLING') NOT NULL,
      produto_externo_id VARCHAR(160), sku VARCHAR(120), nome_externo VARCHAR(255),
      servico_id BIGINT NOT NULL, ativo TINYINT(1) NOT NULL DEFAULT 1,
      criado_por BIGINT, atualizado_por BIGINT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_produto (provedor, produto_externo_id),
      UNIQUE KEY uk_sku (provedor, sku)) ENGINE=InnoDB`);
    const [servicos] = await connection.query(
      'SELECT id FROM servicos WHERE ativo=1 ORDER BY id LIMIT 2'
    );
    assert.ok(servicos.length, 'É necessário ao menos um serviço ativo');
    const api = await iniciarApi(connection);
    servidor = api.servidor;

    let resposta = await requisitar(`${api.url}/api/integracoes/mapeamentos-produtos`, 'POST', {
      provedor: 'WBUY', produto_externo_id: 'produto-wbuy-teste-1',
      sku: 'sku-wbuy-teste-1', nome_externo: 'Produto WBuy de teste',
      servico_id: servicos[0].id
    });
    assert.strictEqual(resposta.status, 201);
    const primeiroId = resposta.corpo.dados.id;
    assert.strictEqual(resposta.corpo.dados.sku, 'SKU-WBUY-TESTE-1');

    resposta = await requisitar(`${api.url}/api/integracoes/mapeamentos-produtos`, 'POST', {
      provedor: 'WBUY', produto_externo_id: 'produto-wbuy-teste-1',
      sku: 'sku-wbuy-teste-1', nome_externo: 'Produto WBuy atualizado',
      servico_id: servicos[0].id
    });
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(resposta.corpo.dados.id, primeiroId);

    resposta = await requisitar(`${api.url}/api/integracoes/mapeamentos-produtos`, 'POST', {
      provedor: 'WBUY', produto_externo_id: 'produto-wbuy-teste-2',
      sku: 'sku-wbuy-teste-2', nome_externo: 'Segundo produto WBuy',
      servico_id: (servicos[1] || servicos[0]).id
    });
    assert.strictEqual(resposta.status, 201);

    resposta = await requisitar(`${api.url}/api/integracoes/mapeamentos-produtos`, 'POST', {
      provedor: 'BLING', produto_externo_id: 'produto-bling-teste-1',
      sku: 'sku-wbuy-teste-1', nome_externo: 'Produto Bling de transição',
      servico_id: servicos[0].id
    });
    assert.strictEqual(resposta.status, 201,
      'O mesmo SKU pode existir em provedores diferentes');

    resposta = await requisitar(`${api.url}/api/integracoes/mapeamentos-produtos`, 'POST', {
      provedor: 'WBUY', produto_externo_id: 'produto-wbuy-teste-1',
      sku: 'sku-wbuy-teste-2', servico_id: servicos[0].id
    });
    assert.strictEqual(resposta.status, 409);

    resposta = await requisitar(
      `${api.url}/api/integracoes/mapeamentos-produtos?provedor=WBUY`
    );
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(resposta.corpo.total, 2);

    resposta = await requisitar(
      `${api.url}/api/integracoes/mapeamentos-produtos/${primeiroId}/status`,
      'PATCH', { ativo: false }
    );
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(Number(resposta.corpo.dados.ativo), 0);

    const [[estado]] = await connection.query(
      `SELECT COUNT(*) AS mapeamentos,
              (SELECT COUNT(*) FROM auditoria
                WHERE entidade='integracao_produto_mapeamentos') AS auditorias
         FROM integracao_produto_mapeamentos`
    );
    assert.strictEqual(Number(estado.mapeamentos), 3);
    assert.strictEqual(Number(estado.auditorias), auditoriasAntes + 5);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      if (servidor) await new Promise((resolve, reject) =>
        servidor.close(e => e ? reject(e) : resolve()));
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT (SELECT COUNT(*) FROM integracao_produto_mapeamentos) AS mapeamentos,
                (SELECT COUNT(*) FROM auditoria
                  WHERE entidade='integracao_produto_mapeamentos') AS auditorias`
      );
      assert.strictEqual(Number(residuos.mapeamentos), 0);
      assert.strictEqual(Number(residuos.auditorias), auditoriasAntes);
    } catch (limpeza) {
      erro = erro || limpeza;
    } finally {
      await connection.end();
    }
  }
  if (erro) throw erro;
  console.log('OK: mapeamentos WBuy/Bling são idempotentes, auditados e revertidos');
}

executar().catch(erro => {
  console.error(`FALHA: mapeamentos de integrações: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
