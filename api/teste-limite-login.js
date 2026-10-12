'use strict';

const assert = require('assert');
const { criarLimitadorLogin } = require('./limite-login');

let instante = 1000;
const limitador = criarLimitadorLogin({
  agora: () => instante,
  janelaMs: 1000,
  bloqueioMs: 500,
  limiteConta: 3,
  limiteIp: 5
});

const tentativa = { login: 'usuario', ip: '192.0.2.10' };
assert.strictEqual(limitador.verificar(tentativa).permitido, true);
limitador.registrarFalha(tentativa);
limitador.registrarFalha(tentativa);
assert.strictEqual(limitador.verificar(tentativa).permitido, true);
limitador.registrarFalha(tentativa);
assert.strictEqual(limitador.verificar(tentativa).permitido, false);
assert.strictEqual(limitador.verificar(tentativa).tentarNovamenteEm, 1);

instante += 501;
assert.strictEqual(limitador.verificar(tentativa).permitido, true);
limitador.registrarSucesso(tentativa);
assert.strictEqual(limitador.verificar(tentativa).permitido, true);

instante += 1001;
for (let i = 0; i < 5; i += 1) {
  limitador.registrarFalha({ login: `usuario-${i}`, ip: tentativa.ip });
}
assert.strictEqual(limitador.verificar({
  login: 'outra-conta', ip: tentativa.ip
}).permitido, false);

console.log('OK: limite de login bloqueia conta e origem sem armazenar identificadores');
