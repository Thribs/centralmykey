'use strict';

const { obterConfiguracaoApiJoelPires } = require('./config-api-joelpires');
const { normalizarChassi } = require('./consulta-banco-senhas');
const { obterMontadoraId } = require('./consulta-api-joelpires');

function valor(valorEntrada) {
  const texto = String(valorEntrada ?? '').trim();
  return texto || null;
}

async function salvarSenhaApiJoelPires(entrada, opcoes = {}) {
  const config = obterConfiguracaoApiJoelPires();
  const fetchImpl = opcoes.fetchImpl || global.fetch;
  const montadoraId = obterMontadoraId({
    marca: entrada.marca,
    montadoraId: entrada.montadoraId
  });
  const chassi = normalizarChassi(entrada.chassi);
  if (!montadoraId || !chassi || typeof fetchImpl !== 'function') {
    const erro = new Error('Dados insuficientes para salvar na API Joel Pires');
    erro.codigo = 'DADOS_PUBLICACAO_JOELPIRES_INVALIDOS';
    throw erro;
  }
  const senha = {
    montadoraId,
    chassi,
    codMecanico: valor(entrada.codigo_mecanico),
    codImmo: valor(entrada.codigo_imobilizador),
    codRadio: valor(entrada.codigo_radio),
    codAlarme: valor(entrada.codigo_alarme),
    pin: valor(entrada.pin)
  };
  if (!Object.entries(senha).some(([chave, conteudo]) =>
    !['montadoraId', 'chassi'].includes(chave) && conteudo)) {
    const erro = new Error('Resultado técnico vazio');
    erro.codigo = 'RESULTADO_PUBLICACAO_VAZIO';
    throw erro;
  }
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), config.timeoutMs);
  try {
    const resposta = await fetchImpl(`${config.urlBase}/senhas/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'chave-api': config.chave,
        'id-dispositivo-mykey': config.idDispositivo,
        'x-app-version': config.versaoApp,
        'versao-app-mykey': config.versaoApp
      },
      body: JSON.stringify({ userId: config.idUsuario, senha }),
      signal: controlador.signal
    });
    const texto = await resposta.text();
    let corpo = null;
    try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = texto; }
    if (!resposta.ok) {
      const erro = new Error('API Joel Pires recusou a gravação da senha');
      erro.codigo = 'GRAVACAO_JOELPIRES_RECUSADA';
      erro.httpStatus = resposta.status;
      erro.resposta = corpo;
      throw erro;
    }
    return { status: 'SALVO', montadoraId, chassi, resposta: corpo };
  } catch (erro) {
    if (!erro.codigo) {
      erro.codigo = erro?.name === 'AbortError'
        ? 'TIMEOUT_GRAVACAO_JOELPIRES' : 'API_JOELPIRES_INDISPONIVEL';
    }
    throw erro;
  } finally { clearTimeout(temporizador); }
}

module.exports = { salvarSenhaApiJoelPires };
