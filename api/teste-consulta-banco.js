'use strict';
const assert = require('assert');
const { normalizarChassi } = require('./consulta-banco-senhas');
assert.strictEqual(normalizarChassi(' 9bgeb48a0mg164639 '), '9BGEB48A0MG164639');
assert.strictEqual(normalizarChassi('MG164639'), 'MG164639');
assert.strictEqual(normalizarChassi('9BG-EB48A0-MG164639'), '9BGEB48A0MG164639');
assert.throws(() => normalizarChassi('1234567'));
console.log('OK: normalizacao de chassi');
