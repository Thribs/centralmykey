'use strict';

const assert = require('assert');
const { calcularPrecoPedido } = require('./preco-pedido');

const servico = { preco_base: '100.00', preco_vip: '75.00' };

assert.deepStrictEqual(calcularPrecoPedido(servico, { vip_elegivel: 1 }), {
  valor: 75,
  tabela: 'VIP',
  vip_aplicado: true
});
assert.deepStrictEqual(calcularPrecoPedido(servico, { vip_elegivel: 0 }), {
  valor: 100,
  tabela: 'BASE',
  vip_aplicado: false
});
assert.deepStrictEqual(
  calcularPrecoPedido({ preco_base: 100, preco_vip: null }, { vip_elegivel: 1 }),
  { valor: 100, tabela: 'BASE', vip_aplicado: false }
);
assert.deepStrictEqual(
  calcularPrecoPedido({ preco_base: 100, preco_vip: 0 }, { vip_elegivel: 1 }),
  { valor: 0, tabela: 'VIP', vip_aplicado: true }
);
assert.throws(
  () => calcularPrecoPedido({ preco_base: -1 }, {}),
  /Preço base inválido/
);

console.log('OK: preço do pedido respeita elegibilidade VIP');
