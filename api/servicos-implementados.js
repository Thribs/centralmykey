'use strict';

const PROCESSADORES = Object.freeze({
  GM_SENHA: 'API_JOELPIRES_GM'
});

const CODIGOS = Object.freeze(Object.keys(PROCESSADORES));

function obterProcessadorServico(codigo) {
  return PROCESSADORES[String(codigo || '').trim().toUpperCase()] || null;
}

function servicoImplementado(codigo) {
  return Boolean(obterProcessadorServico(codigo));
}

module.exports = {
  CODIGOS_SERVICOS_IMPLEMENTADOS: CODIGOS,
  obterProcessadorServico,
  servicoImplementado
};
