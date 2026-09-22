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
      implementado: false,
      configurado: false,
      habilitado: false,
      status: 'CONTRATO_NAO_IDENTIFICADO',
      componentes: {
        identidade_provedor: false,
        contrato_assinatura: false,
        conector: false
      }
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

function destinatarioWhatsappValido(valor) {
  const digitos = String(valor || '').replace(/\D/g, '');
  return digitos.length >= 10 && digitos.length <= 15;
}

async function diagnosticarProntidaoWhatsapp(pool, config) {
  const resumo = resumirIntegracoes(config).find(item => item.codigo === 'WHATSAPP');
  const modeloFornecedor = config.modeloFornecedor || '';
  const idiomaFornecedor = config.idiomaModeloFornecedor || 'pt_BR';
  const modeloEntrega = config.modeloEntrega || '';
  const idiomaEntrega = config.idiomaModeloEntrega || 'pt_BR';

  const [resultadoModelos, resultadoFornecedores, resultadoFila] =
    await Promise.all([
      pool.query(
        `SELECT nome, idioma, status, ativo
           FROM whatsapp_modelos
          WHERE (nome = ? AND idioma = ?)
             OR (nome = ? AND idioma = ?)`,
        [modeloFornecedor, idiomaFornecedor, modeloEntrega, idiomaEntrega]
      ),
      pool.query(
        `SELECT DISTINCT f.id, f.whatsapp, f.telefone
           FROM fornecedores f
           INNER JOIN fornecedor_servicos fs ON fs.fornecedor_id = f.id
          WHERE f.ativo = 1
            AND fs.ativo = 1
            AND fs.codigo_servico = 'GM_SENHA'`
      ),
      pool.query(
        `SELECT
           SUM(status = 'PENDENTE') AS pendentes,
           SUM(status = 'PROCESSANDO') AS processando,
           SUM(status = 'FALHOU') AS falhas,
           SUM(status = 'INCERTA') AS incertas
         FROM comunicacoes_outbox`
      )
    ]);

  const modelos = resultadoModelos[0];
  const fornecedores = resultadoFornecedores[0];
  const fila = resultadoFila[0][0] || {};
  const modeloOperacional = (nome, idioma) => Boolean(nome) && modelos.some(item =>
    item.nome === nome && item.idioma === idioma &&
    item.status === 'APROVADO' && Number(item.ativo) === 1
  );
  const fornecedorAprovado = modeloOperacional(modeloFornecedor, idiomaFornecedor);
  const entregaAprovada = modeloOperacional(modeloEntrega, idiomaEntrega);
  const fornecedoresValidos = fornecedores.filter(item =>
    destinatarioWhatsappValido(item.whatsapp || item.telefone)
  ).length;
  const filaSegura = Number(fila.processando || 0) === 0 &&
    Number(fila.incertas || 0) === 0;
  const bloqueios = [];

  if (!resumo.componentes.transporte) bloqueios.push('TRANSPORTE_WHATSAPP_INCOMPLETO');
  if (!resumo.componentes.webhook) bloqueios.push('WEBHOOK_WHATSAPP_INCOMPLETO');
  if (!fornecedorAprovado) bloqueios.push('MODELO_CONSULTA_FORNECEDOR_NAO_HOMOLOGADO');
  if (!entregaAprovada) bloqueios.push('MODELO_ENTREGA_CLIENTE_NAO_HOMOLOGADO');
  if (!fornecedores.length) bloqueios.push('FORNECEDOR_GM_NAO_CADASTRADO');
  else if (fornecedoresValidos !== fornecedores.length) {
    bloqueios.push('FORNECEDORES_GM_SEM_DESTINATARIO_VALIDO');
  }
  if (!filaSegura) bloqueios.push('FILA_WHATSAPP_REQUER_REVISAO');

  return {
    pronto_para_homologar: bloqueios.length === 0,
    worker_habilitado: resumo.componentes.outbox,
    bloqueios,
    modelos: {
      consulta_fornecedor: {
        configurado: Boolean(modeloFornecedor), aprovado_e_ativo: fornecedorAprovado
      },
      entrega_cliente: {
        configurado: Boolean(modeloEntrega), aprovado_e_ativo: entregaAprovada
      }
    },
    fornecedores_gm: {
      total: fornecedores.length,
      destinatarios_validos: fornecedoresValidos,
      destinatarios_invalidos: fornecedores.length - fornecedoresValidos
    },
    fila: {
      pendentes: Number(fila.pendentes || 0),
      processando: Number(fila.processando || 0),
      falhas: Number(fila.falhas || 0),
      incertas: Number(fila.incertas || 0)
    }
  };
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
  diagnosticarProntidaoWhatsapp,
  obterConfiguracaoBling,
  obterConfiguracaoWhatsapp,
  obterConfiguracaoSicoob,
  obterConfiguracaoWBuy,
  resumirIntegracoes,
  verdadeiro
};
