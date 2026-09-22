'use strict';

function chaveSensivel(chave) {
  return /(TOKEN|SECRET|PASSWORD|SENHA|API_KEY|ACCESS_KEY|PRIVATE_KEY|CHAVE|(^|_)KEY($|_))/i
    .test(String(chave || ''));
}

function mascararConfiguracao(item) {
  const sensivel = chaveSensivel(item?.chave);
  return {
    ...item,
    valor: sensivel ? (item?.valor ? '••••••••' : '') : item?.valor,
    configurado: Boolean(item?.valor),
    sensivel
  };
}

module.exports = { chaveSensivel, mascararConfiguracao };
