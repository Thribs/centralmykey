'use strict';

const BASES = Object.freeze({
  sandbox: 'https://apisandbox.plugpayapi.com',
  producao: 'https://api.plugpayapi.com'
});
const CACHE_TOKENS = new Map();
const MARGEM_RENOVACAO_MS = 60 * 1000;
const VALIDADE_TOKEN_PADRAO_MS = 55 * 60 * 1000;
const VALIDADE_REFRESH_MS = 24 * 60 * 60 * 1000;

function falha(mensagem, codigo, status = 502) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = status;
  return erro;
}

function basePermitida(config) {
  const ambiente = String(config?.ambiente || 'sandbox').trim().toLowerCase();
  const esperada = BASES[ambiente];
  if (!esperada || (config.apiUrl && config.apiUrl !== esperada)) {
    throw falha('Ambiente PlugPay inválido', 'PLUGPAY_AMBIENTE_INVALIDO', 503);
  }
  return esperada;
}

async function requisitar(config, caminho, opcoes = {}, transporte = fetch) {
  const url = new URL(caminho, `${basePermitida(config)}/`);
  if (!Object.values(BASES).includes(url.origin)) {
    throw falha('Destino PlugPay não permitido', 'PLUGPAY_DESTINO_INVALIDO', 503);
  }
  const controlador = new AbortController();
  const timeout = setTimeout(() => controlador.abort(), Number(config.timeoutMs) || 15000);
  timeout.unref?.();
  try {
    const resposta = await transporte(url.toString(), {
      method: opcoes.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opcoes.token ? { Authorization: `Bearer ${opcoes.token}` } : {})
      },
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
      signal: controlador.signal
    });
    let corpo = {};
    try { corpo = await resposta.json(); } catch { /* resposta inválida tratada abaixo */ }
    if (!resposta.ok) {
      const erro = falha('PlugPay recusou a solicitação',
        `PLUGPAY_HTTP_${resposta.status}`, resposta.status >= 500 ? 502 : 422);
      erro.httpExterno = resposta.status;
      throw erro;
    }
    return corpo;
  } catch (error) {
    if (error.codigo) throw error;
    throw falha(error.name === 'AbortError' ? 'Tempo limite na PlugPay' :
      'Não foi possível comunicar com a PlugPay',
    error.name === 'AbortError' ? 'PLUGPAY_TIMEOUT' : 'PLUGPAY_INDISPONIVEL');
  } finally {
    clearTimeout(timeout);
  }
}

function expiracaoJwt(token, agora = Date.now()) {
  try {
    const partes = String(token).split('.');
    if (partes.length !== 3) return agora + VALIDADE_TOKEN_PADRAO_MS;
    const payload = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
    const expiraEm = Number(payload.exp) * 1000;
    return Number.isFinite(expiraEm) ? expiraEm : agora + VALIDADE_TOKEN_PADRAO_MS;
  } catch {
    return agora + VALIDADE_TOKEN_PADRAO_MS;
  }
}

function chaveCache(config) {
  return `${basePermitida(config)}:${String(config.clientId || '')}`;
}

function guardarTokens(chave, corpo, anterior = null) {
  const agora = Date.now();
  const token = String(corpo.token || '').trim();
  if (!token) throw falha('Token PlugPay ausente', 'PLUGPAY_RESPOSTA_INVALIDA');
  const refreshRecebido = String(corpo.refresh_token || '').trim();
  const refreshToken = refreshRecebido || anterior?.refreshToken || '';
  const refreshExpiraEm = refreshRecebido
    ? agora + VALIDADE_REFRESH_MS
    : Number(anterior?.refreshExpiraEm || 0);
  const tokens = {
    token,
    tokenExpiraEm: expiracaoJwt(token, agora),
    refreshToken,
    refreshExpiraEm
  };
  if (tokens.tokenExpiraEm <= agora) {
    throw falha('Token PlugPay recebido expirado', 'PLUGPAY_RESPOSTA_INVALIDA');
  }
  CACHE_TOKENS.set(chave, tokens);
  return tokens;
}

async function autenticar(config, transporte) {
  if (!config?.clientId || !config?.password) {
    throw falha('Credenciais PlugPay incompletas', 'PLUGPAY_CREDENCIAIS_INCOMPLETAS', 503);
  }
  const chave = chaveCache(config);
  const agora = Date.now();
  const existente = CACHE_TOKENS.get(chave);
  if (existente && existente.tokenExpiraEm > agora + MARGEM_RENOVACAO_MS) {
    return existente.token;
  }
  if (existente?.refreshToken && existente.refreshExpiraEm > agora) {
    try {
      const renovado = await requisitar(config, '/v1/partners/auth/refresh', {
        method: 'POST', body: { refresh_token: existente.refreshToken }
      }, transporte);
      return guardarTokens(chave, renovado, existente).token;
    } catch {
      CACHE_TOKENS.delete(chave);
    }
  }
  const corpo = await requisitar(config, '/v1/partners/auth/token', {
    method: 'POST', body: { client_id: config.clientId, password: config.password }
  }, transporte);
  return guardarTokens(chave, corpo).token;
}

async function criarPix(config, dados, transporte) {
  const token = await autenticar(config, transporte);
  const corpo = await requisitar(config, '/v1/partners/transactionPix/create', {
    method: 'POST', token, body: {
      originCurrencie: dados.moeda,
      value: Number(dados.valor),
      customerCPF: dados.cpf,
      documentMerchant: config.documentMerchant
    }
  }, transporte);
  const referencia = String(corpo.referenciaInterna || '').trim();
  const pix = String(corpo.qrCodeCopiaCola || '').trim();
  if (!referencia || !pix || !corpo.IdTransacao) {
    throw falha('Resposta de criação PlugPay incompleta', 'PLUGPAY_RESPOSTA_INVALIDA');
  }
  return { referencia, pixCopiaECola: pix,
    transacaoId: String(corpo.IdTransacao), qrCodeId: String(corpo.qrCodeId || '') };
}

async function consultarPix(config, referencia, transporte) {
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(String(referencia || ''))) {
    throw falha('Referência PlugPay inválida', 'PLUGPAY_REFERENCIA_INVALIDA', 400);
  }
  const token = await autenticar(config, transporte);
  const referenciaCodificada = encodeURIComponent(referencia);
  let corpo;
  try {
    corpo = await requisitar(config,
      `/v1/partners/transactionPix/qrcode/${referenciaCodificada}`,
      { token }, transporte);
  } catch (error) {
    if (error.httpExterno !== 404) throw error;
    corpo = await requisitar(config,
      `/v1/partners/transactionPix/status/${referenciaCodificada}`,
      { token }, transporte);
  }
  const transacao = corpo?.transaction || corpo;
  const status = Number(transacao?.Status ?? transacao?.status ?? corpo?.status);
  if (!Number.isInteger(status)) {
    throw falha('Status PlugPay ausente', 'PLUGPAY_RESPOSTA_INVALIDA');
  }
  return {
    status,
    IdTransacao: transacao?.IdTransacao ?? transacao?.id ?? corpo?.IdTransacao,
    transactionCode: transacao?.TRANSACTION_NUMBER ??
      transacao?.transactionCode ?? corpo?.transactionCode,
    valueBRL: transacao?.Value_BRL ?? transacao?.valueBRL ?? corpo?.valueBRL,
    value: transacao?.Value_Gross ?? transacao?.value ?? corpo?.value,
    currency: transacao?.Currency ?? transacao?.currency ?? corpo?.currency,
    resposta: corpo
  };
}

function limparCacheTokens() { CACHE_TOKENS.clear(); }

module.exports = {
  BASES, autenticar, criarPix, consultarPix, requisitar, limparCacheTokens
};
