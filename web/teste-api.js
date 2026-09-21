import assert from 'node:assert/strict';
import { lerResposta } from './src/api.js';

const sucesso = await lerResposta(new Response(JSON.stringify({
  ok: true,
  valor: 42
}), {
  status: 200,
  headers: { 'Content-Type': 'application/json' }
}));
assert.deepEqual(sucesso, { ok: true, valor: 42 });

await assert.rejects(
  lerResposta(new Response(JSON.stringify({
    ok: false,
    error: 'Dados inválidos',
    codigo: 'DADOS_INVALIDOS',
    request_id: 'req-corpo-123456'
  }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' }
  })),
  erro => erro.status === 422 &&
    erro.codigo === 'DADOS_INVALIDOS' &&
    erro.requestId === 'req-corpo-123456' &&
    /referência: req-corpo-123456/.test(erro.message)
);

await assert.rejects(
  lerResposta(new Response('', {
    status: 503,
    headers: { 'X-Request-ID': 'req-cabecalho-789' }
  })),
  erro => erro.status === 503 &&
    erro.codigo === null &&
    erro.requestId === 'req-cabecalho-789' &&
    /Não foi possível concluir/.test(erro.message)
);

console.log('OK: frontend preserva código e referência dos erros da API');
