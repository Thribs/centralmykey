'use strict';

const assert = require('assert');
const express = require('express');
const {
  registrarContextoRequisicao,
  registrarTratamentoFinal,
  idInformadoValido
} = require('./middleware-erros');

async function iniciarApi() {
  const app = express();
  registrarContextoRequisicao(app);
  app.get('/api/sucesso', (req, res) => res.json({ ok: true }));
  app.get('/api/validacao', (req, res) => res.status(422).json({
    ok: false,
    error: 'Dado inválido',
    codigo: 'DADO_INVALIDO_TESTE'
  }));
  app.get('/api/falha', async () => {
    throw new Error('DETALHE_INTERNO_SIGILOSO');
  });
  registrarTratamentoFinal(app);
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function fecharServidor(servidor) {
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

async function requisitar(url, headers = {}) {
  const resposta = await fetch(url, { headers });
  return { resposta, corpo: await resposta.json() };
}

async function executar() {
  assert.equal(idInformadoValido('proxy_12345678'), true);
  assert.equal(idInformadoValido('inválido com espaço'), false);
  const { servidor, url } = await iniciarApi();
  try {
    const sucesso = await requisitar(`${url}/api/sucesso`);
    assert.strictEqual(sucesso.resposta.status, 200);
    assert.match(sucesso.resposta.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
    assert.strictEqual(sucesso.corpo.request_id, undefined);

    const idProxy = 'proxy-requisicao-123';
    const validacao = await requisitar(`${url}/api/validacao`, {
      'x-request-id': idProxy
    });
    assert.strictEqual(validacao.resposta.status, 422);
    assert.strictEqual(validacao.resposta.headers.get('x-request-id'), idProxy);
    assert.strictEqual(validacao.corpo.request_id, idProxy);
    assert.strictEqual(validacao.corpo.codigo, 'DADO_INVALIDO_TESTE');

    const falha = await requisitar(`${url}/api/falha`);
    assert.strictEqual(falha.resposta.status, 500);
    assert.strictEqual(falha.corpo.codigo, 'ERRO_INTERNO');
    assert.strictEqual(falha.corpo.request_id,
      falha.resposta.headers.get('x-request-id'));
    assert.ok(!JSON.stringify(falha.corpo).includes('DETALHE_INTERNO_SIGILOSO'));

    const ausente = await requisitar(`${url}/api/inexistente`);
    assert.strictEqual(ausente.resposta.status, 404);
    assert.strictEqual(ausente.corpo.codigo, 'ROTA_NAO_ENCONTRADA');
    assert.ok(ausente.corpo.request_id);
    console.log('OK: erros HTTP possuem correlação sem expor detalhes internos');
  } finally {
    await fecharServidor(servidor);
  }
}

executar().catch(erro => {
  console.error(`FALHA: contrato de erros HTTP: ${erro.message}`);
  process.exitCode = 1;
});
