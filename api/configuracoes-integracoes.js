'use strict';

const CHAVES = {
  whatsappAccessToken: ['WHATSAPP_ACCESS_TOKEN', 'META_ACCESS_TOKEN'],
  whatsappPhoneNumberId: ['WHATSAPP_PHONE_NUMBER_ID', 'META_PHONE_NUMBER_ID'],
  whatsappApiVersion: ['WHATSAPP_API_VERSION'],
  metaVerifyToken: ['META_VERIFY_TOKEN'],
  metaAppSecret: ['META_APP_SECRET'],
  modeloFornecedor: ['WHATSAPP_MODELO_CONSULTA_FORNECEDOR'],
  idiomaModeloFornecedor: ['WHATSAPP_MODELO_CONSULTA_FORNECEDOR_IDIOMA'],
  modeloEntrega: ['WHATSAPP_MODELO_ENTREGA_RESULTADO'],
  idiomaModeloEntrega: ['WHATSAPP_MODELO_ENTREGA_RESULTADO_IDIOMA'],
  outboxHabilitada: ['COMUNICACOES_OUTBOX_HABILITADO'],
  whatsappMediaDir: ['WHATSAPP_MEDIA_DIR'],
  whatsappMediaMaxBytes: ['WHATSAPP_MEDIA_MAX_BYTES'],
  joelPiresChave: ['CHAVE_API_JOELPIRES'],
  joelPiresUsuario: ['ID_USUARIO_API_JOELPIRES'],
  sicoobClientId: ['SICOOB_CLIENT_ID'],
  sicoobClientSecret: ['SICOOB_CLIENT_SECRET'],
  plugPayToken: ['PLUGPAY_TOKEN', 'PLUGPAY_API_KEY'],
  wbuyToken: ['WBUY_TOKEN', 'WBUY_API_KEY'],
  blingClientId: ['BLING_CLIENT_ID'],
  blingClientSecret: ['BLING_CLIENT_SECRET']
};

function primeiroValor(mapa, aliases) {
  for (const chave of aliases) {
    const ambiente = process.env[chave];
    if (ambiente !== undefined && String(ambiente).trim() !== '') {
      return String(ambiente).trim();
    }
  }
  for (const chave of aliases) {
    const banco = mapa[chave];
    if (banco !== undefined && banco !== null && String(banco).trim() !== '') {
      return String(banco).trim();
    }
  }
  return '';
}

async function carregarConfiguracoesIntegracoes(pool) {
  const nomes = [...new Set(Object.values(CHAVES).flat())];
  const [linhas] = await pool.query(
    'SELECT chave, valor FROM configuracoes WHERE chave IN (?)',
    [nomes]
  );
  const mapa = Object.fromEntries(linhas.map(item => [item.chave, item.valor]));
  return Object.fromEntries(
    Object.entries(CHAVES).map(([nome, aliases]) => [nome, primeiroValor(mapa, aliases)])
  );
}

function verdadeiro(valor) {
  return ['1', 'true', 'sim', 'yes', 'on'].includes(
    String(valor || '').trim().toLowerCase()
  );
}

function estadoConector({ implementado, requisitos, habilitado = null }) {
  const preenchidos = requisitos.filter(Boolean).length;
  const credenciaisConfiguradas = requisitos.length > 0 &&
    preenchidos === requisitos.length;
  let status = 'PENDENTE';
  if (!implementado && preenchidos > 0) status = 'CREDENCIAIS_SEM_CONECTOR';
  else if (implementado && credenciaisConfiguradas) {
    status = habilitado === false ? 'CONFIGURADO_DESABILITADO' : 'CONFIGURADO';
  } else if (preenchidos > 0) status = 'PARCIAL';
  return { implementado, configurado: credenciaisConfiguradas, habilitado, status };
}

function resumirIntegracoes(config) {
  const whatsappTransporte = Boolean(
    config.whatsappAccessToken && config.whatsappPhoneNumberId &&
    config.whatsappApiVersion && /^v\d+\.\d+$/.test(config.whatsappApiVersion)
  );
  const whatsappWebhook = Boolean(config.metaVerifyToken && config.metaAppSecret);
  const whatsappModelos = Boolean(config.modeloFornecedor && config.modeloEntrega);
  const whatsappHabilitado = verdadeiro(config.outboxHabilitada);
  return [
    {
      codigo: 'WHATSAPP',
      nome: 'WhatsApp Cloud API',
      ...estadoConector({
        implementado: true,
        requisitos: [whatsappTransporte, whatsappWebhook, whatsappModelos],
        habilitado: whatsappHabilitado
      }),
      componentes: {
        transporte: whatsappTransporte,
        webhook: whatsappWebhook,
        modelos: whatsappModelos,
        outbox: whatsappHabilitado
      }
    },
    {
      codigo: 'API_JOELPIRES',
      nome: 'API Joel Pires',
      ...estadoConector({
        implementado: true,
        requisitos: [Boolean(config.joelPiresChave), Boolean(config.joelPiresUsuario)]
      })
    },
    {
      codigo: 'SICOOB',
      nome: 'Sicoob',
      ...estadoConector({
        implementado: false,
        requisitos: [Boolean(config.sicoobClientId), Boolean(config.sicoobClientSecret)]
      })
    },
    {
      codigo: 'PLUGPAY',
      nome: 'PlugPay',
      ...estadoConector({ implementado: false, requisitos: [Boolean(config.plugPayToken)] })
    },
    {
      codigo: 'WBUY',
      nome: 'WBuy',
      ...estadoConector({ implementado: false, requisitos: [Boolean(config.wbuyToken)] })
    },
    {
      codigo: 'BLING',
      nome: 'Bling',
      ...estadoConector({
        implementado: false,
        requisitos: [Boolean(config.blingClientId), Boolean(config.blingClientSecret)]
      })
    }
  ];
}

async function obterConfiguracaoWhatsapp(pool) {
  const config = await carregarConfiguracoesIntegracoes(pool);
  return {
    accessToken: config.whatsappAccessToken,
    phoneNumberId: config.whatsappPhoneNumberId,
    apiVersion: config.whatsappApiVersion,
    verifyToken: config.metaVerifyToken,
    appSecret: config.metaAppSecret,
    modeloFornecedor: config.modeloFornecedor,
    idiomaModeloFornecedor: config.idiomaModeloFornecedor || 'pt_BR',
    modeloEntrega: config.modeloEntrega,
    idiomaModeloEntrega: config.idiomaModeloEntrega || 'pt_BR',
    outboxHabilitada: verdadeiro(config.outboxHabilitada),
    mediaDir: config.whatsappMediaDir,
    mediaMaxBytes: Number(config.whatsappMediaMaxBytes) || null
  };
}

module.exports = {
  carregarConfiguracoesIntegracoes,
  obterConfiguracaoWhatsapp,
  resumirIntegracoes,
  verdadeiro
};
