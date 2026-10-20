'use strict';

const BASES = Object.freeze({
  sandbox: 'https://apisandbox.plugpayapi.com',
  producao: 'https://api.plugpayapi.com'
});

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

async function autenticar(config, transporte) {
  if (!config?.clientId || !config?.password) {
    throw falha('Credenciais PlugPay incompletas', 'PLUGPAY_CREDENCIAIS_INCOMPLETAS', 503);
  }
  const corpo = await requisitar(config, '/v1/partners/auth/token', {
    method: 'POST', body: { client_id: config.clientId, password: config.password }
  }, transporte);
  const token = String(corpo.token || '').trim();
  if (!token) throw falha('Token PlugPay ausente', 'PLUGPAY_RESPOSTA_INVALIDA');
  return token;
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
  return requisitar(config,
    `/v1/partners/transactionPix/status/${encodeURIComponent(referencia)}`,
    { token }, transporte);
}

module.exports = { BASES, autenticar, criarPix, consultarPix, requisitar };
