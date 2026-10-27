'use strict';

const assert = require('assert');
const express = require('express');

async function executar() {
  const processados = [];
  const sincronizados = [];
  const atualizacoes = [];
  const pool = {
    query: async (sql, params) => {
      if (/SELECT entidade_id AS pedido_id/.test(sql)) {
        return [[{ pedido_id: 321 }]];
      }
      if (/UPDATE integracao_referencias_pagamento/.test(sql)) {
        atualizacoes.push(params);
        return [{ affectedRows: 1 }];
      }
      return [[]];
    }
  };
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => next();
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-integracoes')(app, pool, {
    configuracaoPlugPay: {
      webhookHabilitado: true,
      webhookToken: 'segredo-webhook-ficticio-1234567890',
      documentMerchant: '12345678000199'
    },
    webhookPlugPay: {
      processarEvento: async (poolRecebido, dados) => {
        assert.strictEqual(poolRecebido, pool);
        processados.push(dados);
        return { ok: true, idempotente: false, status: 'PROCESSADO' };
      },
      sincronizarAtendimento: async (poolRecebido, pedidoId) => {
        assert.strictEqual(poolRecebido, pool);
        sincronizados.push(pedidoId);
      }
    }
  });
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  const url = `http://127.0.0.1:${servidor.address().port}/webhooks/plugpay`;
  try {
    const payload = {
      IdTransacao: 978,
      referenciaInterna: 'referencia-plugpay-ficticia',
      paymentMethod: 'PIX',
      status: 1,
      documentMerchant: '12.345.678/0001-99',
      value: 10,
      valueBRL: 50,
      currency: 'USD',
      transactionCode: 'transacao-plugpay-ficticia'
    };
    let resposta = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.strictEqual(resposta.status, 401);

    resposta = await fetch(url, { method: 'POST', headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer segredo-webhook-ficticio-1234567890'
    }, body: JSON.stringify({ ...payload, status: 5 }) });
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual((await resposta.json()).processado, false);
    assert.strictEqual(processados.length, 0);

    resposta = await fetch(url, { method: 'POST', headers: {
      'Content-Type': 'application/json',
      'x-webhook-token': 'segredo-webhook-ficticio-1234567890'
    }, body: JSON.stringify(payload) });
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual((await resposta.json()).status, 'PROCESSADO');
    assert.strictEqual(processados.length, 1);
    assert.deepStrictEqual([
      processados[0].pedido_id, processados[0].valor, processados[0].moeda
    ], [321, 50, 'BRL']);
    assert.deepStrictEqual(sincronizados, [321]);
    assert.deepStrictEqual(atualizacoes[0], [
      'transacao-plugpay-ficticia', 'referencia-plugpay-ficticia'
    ]);

    resposta = await fetch(url, { method: 'POST', headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'segredo-webhook-ficticio-1234567890'
    }, body: JSON.stringify({ ...payload, documentMerchant: '00000000000100' }) });
    assert.strictEqual(resposta.status, 401);
  } finally {
    await new Promise((resolve, reject) =>
      servidor.close(error => error ? reject(error) : resolve()));
  }
  console.log('OK: webhook PlugPay autentica, ignora pendente e confirma Pix aprovado');
}

executar().catch(error => { console.error(error); process.exitCode = 1; });
