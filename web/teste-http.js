import assert from 'node:assert/strict';
import { requisitar, TIMEOUT_PADRAO_MS } from './src/http.js';

const fetchOriginal = globalThis.fetch;

try {
  assert.equal(TIMEOUT_PADRAO_MS, 30000);

  globalThis.fetch = async (url, opcoes) => {
    assert.equal(url, 'https://central.invalid/sucesso');
    assert.equal(opcoes.method, 'POST');
    assert.ok(opcoes.signal);
    return { ok: true, status: 200 };
  };
  const resposta = await requisitar(
    'https://central.invalid/sucesso',
    { method: 'POST' },
    { timeoutMs: 50 }
  );
  assert.equal(resposta.status, 200);

  globalThis.fetch = async () => {
    throw new TypeError('falha simulada');
  };
  await assert.rejects(
    requisitar('https://central.invalid/rede', {}, { timeoutMs: 50 }),
    erro => erro.codigo === 'REDE_INDISPONIVEL' &&
      /conectar à Central MyKey/.test(erro.message)
  );

  globalThis.fetch = async (url, opcoes) => new Promise((resolve, reject) => {
    opcoes.signal.addEventListener('abort', () => {
      const erro = new Error('abortado');
      erro.name = 'AbortError';
      reject(erro);
    }, { once: true });
  });
  await assert.rejects(
    requisitar('https://central.invalid/timeout', {}, { timeoutMs: 5 }),
    erro => erro.codigo === 'TEMPO_ESGOTADO' && /1 segundos/.test(erro.message)
  );

  const controlador = new AbortController();
  globalThis.fetch = async (url, opcoes) => new Promise((resolve, reject) => {
    opcoes.signal.addEventListener('abort', () => {
      const erro = new Error('abortado externamente');
      erro.name = 'AbortError';
      reject(erro);
    }, { once: true });
  });
  const externa = requisitar(
    'https://central.invalid/externo',
    { signal: controlador.signal },
    { timeoutMs: 5 }
  );
  controlador.abort();
  await assert.rejects(externa, erro => erro.name === 'AbortError');

  console.log('OK: timeout e falhas de rede do frontend são padronizados');
} finally {
  globalThis.fetch = fetchOriginal;
}
