'use strict';

const assert = require('assert');
const express = require('express');
const registrarRotasHealth = require('./rotas-health');

async function iniciar(pool) {
  const app = express();
  app.locals.autenticarToken = (req, res, next) => next();
  app.locals.exigirPermissao = () => (req, res, next) => next();
  registrarRotasHealth(app, pool);
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function fechar(servidor) {
  await new Promise((resolve, reject) =>
    servidor.close(erro => erro ? reject(erro) : resolve())
  );
}

async function executar() {
  const pronta = await iniciar({
    query: async sql => {
      assert.match(sql, /SELECT 1 AS ok/);
      return [[{ ok: 1 }]];
    }
  });
  try {
    const vida = await fetch(`${pronta.url}/health`);
    assert.strictEqual(vida.status, 200);
    assert.strictEqual((await vida.json()).ok, true);
    const readiness = await fetch(`${pronta.url}/health/ready`);
    const corpo = await readiness.json();
    assert.strictEqual(readiness.status, 200);
    assert.strictEqual(corpo.dependencies.database, 'ready');
  } finally {
    await fechar(pronta.servidor);
  }

  const indisponivel = await iniciar({
    query: async () => {
      const erro = new Error('simulado');
      erro.code = 'ECONNREFUSED';
      throw erro;
    }
  });
  try {
    const readiness = await fetch(`${indisponivel.url}/health/ready`);
    const corpo = await readiness.json();
    assert.strictEqual(readiness.status, 503);
    assert.strictEqual(corpo.ok, false);
    assert.strictEqual(corpo.dependencies.database, 'unavailable');
    assert.strictEqual(JSON.stringify(corpo).includes('simulado'), false);
  } finally {
    await fechar(indisponivel.servidor);
  }

  console.log('OK: health distingue processo ativo de banco pronto');
}

executar().catch(erro => {
  console.error(`FALHA: teste de health: ${erro.message}`);
  process.exitCode = 1;
});
