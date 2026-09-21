'use strict';

const fs = require('fs');
const https = require('https');

function falha(mensagem, codigo, status = 502) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = status;
  return erro;
}

function validarUrlSicoob(url) {
  let destino;
  try { destino = new URL(url); } catch { throw falha('URL Sicoob inválida', 'SICOOB_URL_INVALIDA', 500); }
  const hosts = ['api-homol.sicoob.com.br', 'apis.sisbr.com.br'];
  if (destino.protocol !== 'https:' || !hosts.includes(destino.hostname)) {
    throw falha('Destino Sicoob não permitido', 'SICOOB_DESTINO_NAO_PERMITIDO', 500);
  }
  return destino;
}

function requisitarMtls({ url, method, headers, body, certPath, keyPath, caPath }) {
  const destino = validarUrlSicoob(url);
  return new Promise((resolve, reject) => {
    let cert;
    let key;
    let ca;
    try {
      cert = fs.readFileSync(certPath);
      key = fs.readFileSync(keyPath);
      ca = caPath ? fs.readFileSync(caPath) : undefined;
    } catch {
      reject(falha('Certificado Sicoob indisponível', 'SICOOB_CERTIFICADO_INDISPONIVEL', 503));
      return;
    }
    const req = https.request(destino, {
      method, headers, cert, key, ca, minVersion: 'TLSv1.2', timeout: 20000
    }, res => {
      const partes = [];
      res.on('data', parte => partes.push(parte));
      res.on('end', () => resolve({ status: res.statusCode,
        body: Buffer.concat(partes).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(falha('Sicoob não respondeu no prazo', 'SICOOB_TIMEOUT', 504)));
    req.on('error', erro => reject(erro.codigo
      ? erro : falha('Falha de comunicação com Sicoob', 'SICOOB_INDISPONIVEL', 503)));
    req.end(body);
  });
}

function interpretarResposta(resposta, codigo) {
  let corpo;
  try { corpo = JSON.parse(resposta.body || '{}'); } catch {
    throw falha('Sicoob retornou conteúdo inválido', 'SICOOB_RESPOSTA_INVALIDA');
  }
  if (resposta.status < 200 || resposta.status >= 300) {
    throw falha(`Sicoob recusou a operação (HTTP ${resposta.status})`, codigo,
      resposta.status >= 500 ? 503 : 422);
  }
  return corpo;
}

async function obterToken(config, transporte = requisitarMtls) {
  const form = new URLSearchParams({
    grant_type: 'client_credentials', client_id: config.clientId,
    client_secret: config.clientSecret, scope: config.scope || 'cob.write cob.read pix.read'
  }).toString();
  const resposta = await transporte({
    url: config.tokenUrl, method: 'POST', certPath: config.certPath,
    keyPath: config.keyPath, caPath: config.caPath,
    headers: { 'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(form) }, body: form
  });
  const corpo = interpretarResposta(resposta, 'SICOOB_TOKEN_RECUSADO');
  if (!corpo.access_token || typeof corpo.access_token !== 'string') {
    throw falha('Sicoob não retornou token de acesso', 'SICOOB_TOKEN_INVALIDO');
  }
  return corpo.access_token;
}

async function criarCobranca(config, dados, transporte = requisitarMtls) {
  if (!config.habilitado) throw falha('Integração Sicoob está desabilitada', 'SICOOB_DESABILITADO', 503);
  const obrigatorios = ['clientId', 'clientSecret', 'certPath', 'keyPath', 'chavePix',
    'tokenUrl', 'apiUrl'];
  if (obrigatorios.some(chave => !String(config[chave] || '').trim())) {
    throw falha('Configuração Sicoob incompleta', 'SICOOB_CONFIGURACAO_INCOMPLETA', 503);
  }
  const token = await obterToken(config, transporte);
  const payload = JSON.stringify({
    calendario: { expiracao: dados.expiracaoSegundos },
    valor: { original: Number(dados.valor).toFixed(2) },
    chave: config.chavePix,
    solicitacaoPagador: dados.solicitacaoPagador
  });
  const resposta = await transporte({
    url: `${config.apiUrl.replace(/\/$/, '')}/cob/${dados.txid}`,
    method: 'PUT', certPath: config.certPath, keyPath: config.keyPath, caPath: config.caPath,
    headers: { authorization: `Bearer ${token}`, client_id: config.clientId,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    body: payload
  });
  const corpo = interpretarResposta(resposta, 'SICOOB_COBRANCA_RECUSADA');
  if (corpo.txid !== dados.txid || !corpo.location) {
    throw falha('Resposta da cobrança Sicoob está incompleta', 'SICOOB_COBRANCA_INVALIDA');
  }
  return corpo;
}

module.exports = { criarCobranca, obterToken, requisitarMtls, validarUrlSicoob };
