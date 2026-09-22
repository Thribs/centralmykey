'use strict';

function numeroMonetario(valor, campo) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) {
    throw new Error(`${campo} inválido no catálogo de serviços`);
  }
  return numero;
}

function calcularPrecoPedido(servico, cliente) {
  const precoBase = numeroMonetario(servico?.preco_base ?? 0, 'Preço base');
  const possuiPrecoVip = servico?.preco_vip !== null &&
    servico?.preco_vip !== undefined && servico?.preco_vip !== '';
  const precoVip = possuiPrecoVip
    ? numeroMonetario(servico.preco_vip, 'Preço VIP')
    : null;
  const vipAplicado = Number(cliente?.vip_elegivel) === 1 && precoVip !== null;

  return {
    valor: vipAplicado ? precoVip : precoBase,
    tabela: vipAplicado ? 'VIP' : 'BASE',
    vip_aplicado: vipAplicado
  };
}

module.exports = { calcularPrecoPedido };
