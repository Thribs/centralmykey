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
  sicoobCertPath: ['SICOOB_CERT_PATH'],
  sicoobKeyPath: ['SICOOB_KEY_PATH'],
  sicoobCaPath: ['SICOOB_CA_PATH'],
  sicoobChavePix: ['SICOOB_CHAVE_PIX'],
  sicoobAmbiente: ['SICOOB_AMBIENTE'],
  sicoobCobrancaHabilitada: ['SICOOB_COBRANCA_HABILITADA'],
  sicoobWebhookHabilitado: ['SICOOB_WEBHOOK_HABILITADO'],
  plugPayToken: ['PLUGPAY_TOKEN', 'PLUGPAY_API_KEY'],
  wbuyUsuario: ['WBUY_USUARIO', 'WBUY_USERNAME'],
  wbuySenha: ['WBUY_SENHA', 'WBUY_PASSWORD'],
  wbuyLojaUrl: ['WBUY_LOJA_URL'],
  wbuyCredencialLegada: ['WBUY_TOKEN', 'WBUY_API_KEY'],
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
  const sicoobCobrancaHabilitada = verdadeiro(config.sicoobCobrancaHabilitada);
  const sicoobWebhookHabilitado = verdadeiro(config.sicoobWebhookHabilitado);
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
        implementado: true,
        requisitos: [Boolean(config.sicoobClientId), Boolean(config.sicoobClientSecret),
          Boolean(config.sicoobCertPath), Boolean(config.sicoobKeyPath),
          Boolean(config.sicoobChavePix)],
        habilitado: sicoobCobrancaHabilitada && sicoobWebhookHabilitado
      }),
      componentes: { cobranca: true, conciliacao: true,
        cobranca_habilitada: sicoobCobrancaHabilitada,
        webhook_publico_mtls: sicoobWebhookHabilitado }
    },
    {
      codigo: 'PLUGPAY',
      nome: 'PlugPay',
      ...estadoConector({ implementado: false, requisitos: [Boolean(config.plugPayToken)] })
    },
    {
      codigo: 'WBUY',
      nome: 'WBuy',
      ...estadoConector({
        implementado: true,
        requisitos: [Boolean(config.wbuyUsuario), Boolean(config.wbuySenha)]
      }),
      ...(config.wbuyCredencialLegada && !(config.wbuyUsuario && config.wbuySenha)
        ? { configurado: false, status: 'CREDENCIAIS_SEM_CONECTOR' }
        : {}),
      componentes: { mapeamento_produtos: true, consulta_pedido: true,
        conversao_pedido: false, webhook: false,
        credencial_legada: Boolean(config.wbuyCredencialLegada) }
    },
    {
      codigo: 'BLING',
      nome: 'Bling',
      implementado: true,
      configurado: Boolean(config.blingClientSecret),
      habilitado: null,
      status: config.blingClientSecret ? 'PARCIAL' : 'PENDENTE',
      componentes: {
        webhook_assinado: true,
        oauth: false,
        sincronizacao: false
      }
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

async function obterConfiguracaoSicoob(pool) {
  const config = await carregarConfiguracoesIntegracoes(pool);
  const producao = String(config.sicoobAmbiente).toLowerCase() === 'producao';
  const webhookHabilitado = verdadeiro(config.sicoobWebhookHabilitado);
  const cobrancaHabilitada = verdadeiro(config.sicoobCobrancaHabilitada);
  const credenciaisConfiguradas = Boolean(
    config.sicoobClientId && config.sicoobClientSecret &&
    config.sicoobCertPath && config.sicoobKeyPath && config.sicoobChavePix
  );
  return {
    clientId: config.sicoobClientId, clientSecret: config.sicoobClientSecret,
    certPath: config.sicoobCertPath, keyPath: config.sicoobKeyPath,
    caPath: config.sicoobCaPath, chavePix: config.sicoobChavePix,
    webhookHabilitado,
    // A criação só pode ser ativada junto com o webhook autenticado por mTLS.
    habilitado: credenciaisConfiguradas && cobrancaHabilitada && webhookHabilitado,
    tokenUrl: producao
      ? 'https://apis.sisbr.com.br/cooperado/pix/token'
      : 'https://api-homol.sicoob.com.br/cooperado/pix/token',
    apiUrl: producao
      ? 'https://apis.sisbr.com.br/cooperado/pix/api/v2'
      : 'https://api-homol.sicoob.com.br/cooperado/pix/api/v2',
    scope: 'cob.write cob.read pix.read'
  };
}

async function obterConfiguracaoBling(pool) {
  const config = await carregarConfiguracoesIntegracoes(pool);
  return {
    clientId: config.blingClientId,
    clientSecret: config.blingClientSecret
  };
}

async function obterConfiguracaoWBuy(pool) {
  const config = await carregarConfiguracoesIntegracoes(pool);
  return {
    usuario: config.wbuyUsuario,
    senha: config.wbuySenha,
    apiUrl: 'https://sistema.sistemawbuy.com.br/api/v1'
  };
}

module.exports = {
  carregarConfiguracoesIntegracoes,
  obterConfiguracaoBling,
  obterConfiguracaoWhatsapp,
  obterConfiguracaoSicoob,
  obterConfiguracaoWBuy,
  resumirIntegracoes,
  verdadeiro
};
