'use strict';

const AMBIENTES = Object.freeze({
  teste: 'https://testes.api.joelpires.com.br',
  publico: 'https://api.joelpires.com.br'
});

function obterConfiguracaoApiJoelPires() {
  const ambiente = String(
    process.env.AMBIENTE_API_JOELPIRES || 'teste'
  ).trim().toLowerCase();

  if (!Object.hasOwn(AMBIENTES, ambiente)) {
    throw new Error(
      'AMBIENTE_API_JOELPIRES deve ser teste ou publico'
    );
  }

  const variavelUrl = ambiente === 'publico'
    ? 'URL_API_JOELPIRES_PUBLICO'
    : 'URL_API_JOELPIRES_TESTE';

  const urlBase =
    process.env[variavelUrl] ||
    AMBIENTES[ambiente];

  const chave =
    process.env.CHAVE_API_JOELPIRES || '';

  const idUsuario =
    process.env.ID_USUARIO_API_JOELPIRES || '';

  const idDispositivo =
    process.env.APIJOELPIRES_ID_DISPOSITIVO ||
    'centralmykey';

  if (!chave) {
    throw new Error(
      'CHAVE_API_JOELPIRES não configurada'
    );
  }

  if (!idUsuario) {
    throw new Error(
      'ID_USUARIO_API_JOELPIRES não configurado'
    );
  }

  return {
    ambiente,
    urlBase,
    chave,
    idUsuario,
    idDispositivo,
    versaoApp:
      process.env.APIJOELPIRES_VERSAO_APP ||
      '2.7.2%2Bcentralmykey',
    timeoutMs: Number(
      process.env.APIJOELPIRES_TIMEOUT_MS ||
      90000
    )
  };
}

module.exports = {
  AMBIENTES,
  obterConfiguracaoApiJoelPires
};
