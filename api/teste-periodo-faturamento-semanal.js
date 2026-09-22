'use strict';

const assert = require('assert');
const {
  calcularPeriodoFaturamentoSemanal
} = require('./periodo-faturamento-semanal');

assert.deepStrictEqual(
  calcularPeriodoFaturamentoSemanal('2026-09-19', 0, 3),
  {
    inicio: '2026-09-14',
    fim: '2026-09-20',
    vencimento: '2026-09-23',
    diaFechamento: 0,
    prazoPagamentoDias: 3
  }
);
assert.deepStrictEqual(
  calcularPeriodoFaturamentoSemanal('2026-09-19', 3, 3),
  {
    inicio: '2026-09-17',
    fim: '2026-09-23',
    vencimento: '2026-09-26',
    diaFechamento: 3,
    prazoPagamentoDias: 3
  }
);
assert.deepStrictEqual(
  calcularPeriodoFaturamentoSemanal('2026-09-19', 6, 0),
  {
    inicio: '2026-09-13',
    fim: '2026-09-19',
    vencimento: '2026-09-19',
    diaFechamento: 6,
    prazoPagamentoDias: 0
  }
);
assert.throws(
  () => calcularPeriodoFaturamentoSemanal('2026-02-30', 0, 3),
  /Data de referência inválida/
);
assert.throws(
  () => calcularPeriodoFaturamentoSemanal('2026-09-19', 7, 3),
  /Dia de fechamento inválido/
);
assert.throws(
  () => calcularPeriodoFaturamentoSemanal('2026-09-19', 0, 61),
  /Prazo de pagamento inválido/
);

console.log('OK: período semanal respeita o dia de fechamento do cliente');
