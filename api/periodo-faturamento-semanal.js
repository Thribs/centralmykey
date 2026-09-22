'use strict';

function dataIso(data) {
  return data.toISOString().slice(0, 10);
}

function inteiroNoIntervalo(valor, nome, minimo, maximo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
    throw new Error(`${nome} inválido`);
  }
  return numero;
}

function calcularPeriodoFaturamentoSemanal(
  hojeIso,
  diaFechamento,
  prazoPagamentoDias
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hojeIso || ''))) {
    throw new Error('Data de referência inválida');
  }
  const fechamento = inteiroNoIntervalo(
    diaFechamento,
    'Dia de fechamento',
    0,
    6
  );
  const prazo = inteiroNoIntervalo(
    prazoPagamentoDias,
    'Prazo de pagamento',
    0,
    60
  );
  const referencia = new Date(`${hojeIso}T00:00:00.000Z`);
  if (Number.isNaN(referencia.getTime()) || dataIso(referencia) !== hojeIso) {
    throw new Error('Data de referência inválida');
  }
  const diasAteFechamento = (fechamento - referencia.getUTCDay() + 7) % 7;
  const fim = new Date(referencia);
  fim.setUTCDate(fim.getUTCDate() + diasAteFechamento);
  const inicio = new Date(fim);
  inicio.setUTCDate(inicio.getUTCDate() - 6);
  const vencimento = new Date(fim);
  vencimento.setUTCDate(vencimento.getUTCDate() + prazo);
  return {
    inicio: dataIso(inicio),
    fim: dataIso(fim),
    vencimento: dataIso(vencimento),
    diaFechamento: fechamento,
    prazoPagamentoDias: prazo
  };
}

module.exports = { calcularPeriodoFaturamentoSemanal };
