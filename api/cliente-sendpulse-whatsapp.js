'use strict';

let tokenCache = null;

function erro(codigo, mensagem, status = null) {
  const falha = new Error(mensagem);
  falha.codigo = codigo;
  falha.statusMeta = status;
  return falha;
}

function telefoneInternacional(valor) {
  const digitos = String(valor || '').replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 15) {
    throw erro('WHATSAPP_DADOS_INVALIDOS', 'Telefone WhatsApp inválido');
  }
  return `+${digitos}`;
}

async function requisicao(url, opcoes, timeoutMs = 15000) {
  const controlador = new AbortController();
  const limite = setTimeout(() => controlador.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opcoes, signal: controlador.signal });
  } finally {
    clearTimeout(limite);
  }
}

async function obterToken(config) {
  if (!config.sendpulseClientId || !config.sendpulseClientSecret) {
    throw erro('WHATSAPP_NAO_CONFIGURADO', 'Credenciais SendPulse não configuradas');
  }
  if (tokenCache && tokenCache.clientId === config.sendpulseClientId &&
      tokenCache.expiraEm > Date.now() + 60000) {
    return tokenCache.valor;
  }
  const resposta = await requisicao('https://api.sendpulse.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: config.sendpulseClientId,
      client_secret: config.sendpulseClientSecret
    })
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok || !dados.access_token) {
    throw erro('WHATSAPP_AUTENTICACAO_FALHOU',
      'A SendPulse recusou a autenticação', resposta.status);
  }
  tokenCache = {
    clientId: config.sendpulseClientId,
    valor: dados.access_token,
    expiraEm: Date.now() + Math.max(Number(dados.expires_in || 3600) - 60, 60) * 1000
  };
  return tokenCache.valor;
}

function idEnvio(dados) {
  return dados?.message_id || dados?.id || dados?.data?.message_id ||
    dados?.data?.id || dados?.result?.message_id || dados?.result?.id || null;
}

async function enviar(config, caminho, corpo) {
  if (!config.sendpulseBotId) {
    throw erro('WHATSAPP_NAO_CONFIGURADO', 'Bot WhatsApp da SendPulse não configurado');
  }
  const token = await obterToken(config);
  const resposta = await requisicao(`https://api.sendpulse.com/whatsapp/${caminho}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(corpo)
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok || dados.success === false) {
    throw erro('WHATSAPP_ENVIO_FALHOU',
      dados.message || 'A SendPulse recusou o envio da mensagem', resposta.status);
  }
  return {
    mensagem_externa_id: String(idEnvio(dados) || `sendpulse:${cryptoId(corpo)}`),
    contato: String(corpo.phone || '').replace(/\D/g, '')
  };
}

function cryptoId(corpo) {
  // Identificador apenas para correlação quando a API aceita o envio sem retornar ID.
  return require('crypto').createHash('sha256')
    .update(JSON.stringify(corpo)).digest('hex').slice(0, 24);
}

async function enviarMensagemSendPulse(config, { telefone, texto }) {
  const mensagem = String(texto || '').trim();
  if (!mensagem || mensagem.length > 1024) {
    throw erro('WHATSAPP_DADOS_INVALIDOS', 'Mensagem WhatsApp inválida');
  }
  return enviar(config, 'contacts/sendByPhone', {
    bot_id: config.sendpulseBotId,
    phone: telefoneInternacional(telefone),
    message: { type: 'text', text: { body: mensagem } }
  });
}

async function enviarModeloSendPulse(config, { telefone, nome, idioma, parametros = [] }) {
  const nomeModelo = String(nome || '').trim();
  const idiomaModelo = String(idioma || '').trim();
  if (!/^[a-z0-9_]+$/.test(nomeModelo) ||
      !/^[a-zA-Z]{2,3}(?:_[a-zA-Z]{2})?$/.test(idiomaModelo) ||
      !Array.isArray(parametros) || parametros.length > 10) {
    throw erro('WHATSAPP_DADOS_INVALIDOS', 'Dados do modelo inválidos');
  }
  const parameters = parametros.map(valor => ({
    type: 'text', text: String(valor ?? '').trim().slice(0, 1024)
  }));
  if (parameters.some(item => !item.text)) {
    throw erro('WHATSAPP_DADOS_INVALIDOS', 'Parâmetro do modelo inválido');
  }
  const template = {
    name: nomeModelo,
    language: { code: idiomaModelo },
    components: parameters.length
      ? [{ type: 'body', parameters }]
      : []
  };
  return enviar(config, 'contacts/sendTemplateByPhone', {
    bot_id: config.sendpulseBotId,
    phone: telefoneInternacional(telefone),
    template
  });
}

function limparCacheTokenParaTeste() {
  tokenCache = null;
}

module.exports = {
  enviarMensagemSendPulse,
  enviarModeloSendPulse,
  limparCacheTokenParaTeste
};
