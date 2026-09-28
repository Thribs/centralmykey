'use strict';

const fs = require('fs');

const CHAVES = {
  whatsappProvedor: ['WHATSAPP_PROVEDOR'],
  sendpulseClientId: ['SENDPULSE_CLIENT_ID'],
  sendpulseClientSecret: ['SENDPULSE_CLIENT_SECRET'],
  sendpulseBotId: ['SENDPULSE_WHATSAPP_BOT_ID', 'SENDPULSE_BOT_ID'],
  sendpulseWebhookToken: ['SENDPULSE_WEBHOOK_TOKEN'],
  fornecedorMarcioWhatsapp: ['WHATSAPP_FORNECEDOR_MARCIO'],
  fornecedorEmersonWhatsapp: ['WHATSAPP_FORNECEDOR_EMERSON'],
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
  automacaoGmWhatsappHabilitada: ['AUTOMACAO_GM_WHATSAPP_HABILITADA'],
  whatsappMediaDir: ['WHATSAPP_MEDIA_DIR'],
  whatsappMediaMaxBytes: ['WHATSAPP_MEDIA_MAX_BYTES'],
  joelPiresChave: ['CHAVE_API_JOELPIRES'],
  joelPiresUsuario: ['ID_USUARIO_API_JOELPIRES'],
  joelPiresGravacaoHomologada: ['APIJOELPIRES_GRAVACAO_HOMOLOGADA'],
  sicoobClientId: ['SICOOB_CLIENT_ID'],
  sicoobClientSecret: ['SICOOB_CLIENT_SECRET'],
  sicoobCertPath: ['SICOOB_CERT_PATH'],
  sicoobKeyPath: ['SICOOB_KEY_PATH'],
  sicoobCaPath: ['SICOOB_CA_PATH'],
  sicoobWebhookCaPath: ['SICOOB_WEBHOOK_CA_PATH'],
  sicoobChavePix: ['SICOOB_CHAVE_PIX'],
  sicoobAmbiente: ['SICOOB_AMBIENTE'],
  sicoobCobrancaHabilitada: ['SICOOB_COBRANCA_HABILITADA'],
  sicoobWebhookHabilitado: ['SICOOB_WEBHOOK_HABILITADO'],
  sicoobWebhookMtlsConfigurado: ['SICOOB_WEBHOOK_MTLS_CONFIGURADO'],
  sicoobWebhookUrl: ['SICOOB_WEBHOOK_URL'],
  sicoobWebhookCadastrado: ['SICOOB_WEBHOOK_CADASTRADO'],
  plugPayToken: ['PLUGPAY_TOKEN', 'PLUGPAY_API_KEY'],
  wbuyUsuario: ['WBUY_USUARIO', 'WBUY_USERNAME'],
  wbuySenha: ['WBUY_SENHA', 'WBUY_PASSWORD'],
  wbuyLojaUrl: ['WBUY_LOJA_URL'],
  wbuyCredencialLegada: ['WBUY_TOKEN', 'WBUY_API_KEY'],
  blingClientId: ['BLING_CLIENT_ID'],
  blingClientSecret: ['BLING_CLIENT_SECRET'],
  blingRedirectUri: ['BLING_REDIRECT_URI'],
  blingOAuthHabilitado: ['BLING_OAUTH_HABILITADO']
};

const SOMENTE_AMBIENTE = new Set([
  'whatsappProvedor', 'sendpulseClientId', 'sendpulseClientSecret',
  'sendpulseBotId', 'sendpulseWebhookToken', 'fornecedorMarcioWhatsapp',
  'fornecedorEmersonWhatsapp', 'sicoobClientId', 'sicoobClientSecret',
  'sicoobCertPath', 'sicoobKeyPath', 'sicoobCaPath',
  'sicoobWebhookCaPath', 'sicoobChavePix'
]);

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
  const configuracoes = Object.fromEntries(
    Object.entries(CHAVES).map(([nome, aliases]) => [nome, primeiroValor(mapa, aliases)])
  );
  for (const nome of SOMENTE_AMBIENTE) {
    configuracoes[nome] = primeiroValor({}, CHAVES[nome]);
  }
  // A chave que cifra tokens deve existir apenas no ambiente do processo.
  configuracoes.blingTokenEncryptionKey =
    String(process.env.BLING_TOKEN_ENCRYPTION_KEY || '').trim();
  return configuracoes;
}

function verdadeiro(valor) {
  return ['1', 'true', 'sim', 'yes', 'on'].includes(
    String(valor || '').trim().toLowerCase()
  );
}

function tokenWebhookSendPulseValido(valor) {
  return /^[A-Za-z0-9_-]{32,128}$/.test(String(valor || ''));
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
  const provedorWhatsapp = String(config.whatsappProvedor || 'META').toUpperCase();
  const usandoSendPulse = provedorWhatsapp === 'SENDPULSE';
  const whatsappTransporte = usandoSendPulse
    ? Boolean(config.sendpulseClientId && config.sendpulseClientSecret &&
      config.sendpulseBotId)
    : Boolean(config.whatsappAccessToken && config.whatsappPhoneNumberId &&
      config.whatsappApiVersion && /^v\d+\.\d+$/.test(config.whatsappApiVersion));
  const whatsappWebhook = usandoSendPulse
    ? Boolean(tokenWebhookSendPulseValido(config.sendpulseWebhookToken) &&
      config.sendpulseBotId)
    : Boolean(config.metaVerifyToken && config.metaAppSecret);
  const whatsappModelos = Boolean(config.modeloFornecedor && config.modeloEntrega);
  const whatsappHabilitado = verdadeiro(config.outboxHabilitada);
  const automacaoGmHabilitada = verdadeiro(config.automacaoGmWhatsappHabilitada);
  const sicoobCobrancaHabilitada = verdadeiro(config.sicoobCobrancaHabilitada);
  const sicoobWebhookHabilitado = verdadeiro(config.sicoobWebhookHabilitado);
  return [
    {
      codigo: 'WHATSAPP',
      nome: usandoSendPulse ? 'WhatsApp via SendPulse' : 'WhatsApp Cloud API',
      ...estadoConector({
        implementado: true,
        requisitos: [whatsappTransporte, whatsappWebhook, whatsappModelos],
        habilitado: whatsappHabilitado
      }),
      componentes: {
        provedor: provedorWhatsapp,
        transporte: whatsappTransporte,
        webhook: whatsappWebhook,
        modelos: whatsappModelos,
        outbox: whatsappHabilitado,
        automacao_gm: automacaoGmHabilitada
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
          Boolean(config.sicoobChavePix), Boolean(config.sicoobWebhookCaPath),
          verdadeiro(config.sicoobWebhookMtlsConfigurado),
          verdadeiro(config.sicoobWebhookCadastrado)],
        habilitado: sicoobCobrancaHabilitada && sicoobWebhookHabilitado
      }),
      componentes: { cobranca: true, conciliacao: true,
        cobranca_habilitada: sicoobCobrancaHabilitada,
        webhook_publico_mtls: sicoobWebhookHabilitado &&
          verdadeiro(config.sicoobWebhookMtlsConfigurado) }
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
      configurado: Boolean(config.blingClientId && config.blingClientSecret &&
        config.blingRedirectUri && config.blingTokenEncryptionKey),
      habilitado: verdadeiro(config.blingOAuthHabilitado),
      status: config.blingClientId && config.blingClientSecret
        ? 'PARCIAL' : 'PENDENTE',
      componentes: {
        webhook_assinado: true,
        webhook_configurado: Boolean(config.blingClientSecret),
        oauth_fundacao: true,
        oauth_configurado: Boolean(config.blingClientId && config.blingClientSecret &&
          config.blingRedirectUri && config.blingTokenEncryptionKey),
        oauth_habilitado: verdadeiro(config.blingOAuthHabilitado),
        consulta_pedido: true,
        processamento_pedido: false
      }
    }
  ];
}

function arquivoLegivel(caminho) {
  if (!caminho) return false;
  try {
    fs.accessSync(caminho, fs.constants.R_OK);
    return fs.statSync(caminho).isFile();
  } catch {
    return false;
  }
}

function webhookUrlValida(valor) {
  try {
    const url = new URL(String(valor || ''));
    return url.protocol === 'https:' && Boolean(url.hostname) &&
      !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function diagnosticarProntidaoSicoob(config, opcoes = {}) {
  const legivel = opcoes.arquivoLegivel || arquivoLegivel;
  const ambiente = String(config.sicoobAmbiente || 'homologacao')
    .trim().toLowerCase();
  const ambienteValido = ['homologacao', 'producao'].includes(ambiente);
  const credenciais = Boolean(
    config.sicoobClientId && config.sicoobClientSecret && config.sicoobChavePix
  );
  const certificadoLegivel = legivel(config.sicoobCertPath);
  const chaveLegivel = legivel(config.sicoobKeyPath);
  const caSaidaLegivel = !config.sicoobCaPath || legivel(config.sicoobCaPath);
  const caWebhookLegivel = legivel(config.sicoobWebhookCaPath);
  const proxyMtls = verdadeiro(config.sicoobWebhookMtlsConfigurado);
  const webhookUrlConfigurada = webhookUrlValida(config.sicoobWebhookUrl);
  const webhookCadastrado = verdadeiro(config.sicoobWebhookCadastrado);
  const cobrancaHabilitada = verdadeiro(config.sicoobCobrancaHabilitada);
  const webhookHabilitado = verdadeiro(config.sicoobWebhookHabilitado);
  const bloqueios = [];

  if (!ambienteValido) bloqueios.push('AMBIENTE_SICOOB_INVALIDO');
  if (!credenciais) bloqueios.push('CREDENCIAIS_SICOOB_INCOMPLETAS');
  if (!certificadoLegivel) bloqueios.push('CERTIFICADO_SICOOB_INACESSIVEL');
  if (!chaveLegivel) bloqueios.push('CHAVE_PRIVADA_SICOOB_INACESSIVEL');
  if (!caSaidaLegivel) bloqueios.push('CA_SICOOB_INACESSIVEL');
  if (!caWebhookLegivel) bloqueios.push('CA_WEBHOOK_SICOOB_INACESSIVEL');
  if (!proxyMtls) bloqueios.push('PROXY_MTLS_SICOOB_NAO_CONFIGURADO');
  if (!webhookUrlConfigurada) bloqueios.push('URL_WEBHOOK_SICOOB_INVALIDA');
  if (!webhookCadastrado) bloqueios.push('WEBHOOK_SICOOB_NAO_CADASTRADO');
  if (!cobrancaHabilitada) bloqueios.push('COBRANCA_SICOOB_DESABILITADA');
  if (!webhookHabilitado) bloqueios.push('WEBHOOK_SICOOB_DESABILITADO');

  return {
    pronto_para_teste: bloqueios.length === 0,
    ambiente: ambienteValido ? ambiente.toUpperCase() : 'INVALIDO',
    componentes: {
      credenciais,
      certificado_cliente_legivel: certificadoLegivel,
      chave_privada_legivel: chaveLegivel,
      ca_saida_legivel: caSaidaLegivel,
      ca_webhook_legivel: caWebhookLegivel,
      proxy_mtls: proxyMtls,
      webhook_url_configurada: webhookUrlConfigurada,
      webhook_cadastrado: webhookCadastrado,
      cobranca_habilitada: cobrancaHabilitada,
      webhook_habilitado: webhookHabilitado
    },
    bloqueios
  };
}

function diagnosticarProntidaoFluxoGm(config, prontidaoWhatsapp, prontidaoSicoob) {
  const leituraJoelPires = Boolean(config.joelPiresChave && config.joelPiresUsuario);
  const gravacaoJoelPires = verdadeiro(config.joelPiresGravacaoHomologada);
  const bloqueios = [
    ...(prontidaoWhatsapp?.bloqueios || []).map(codigo => `WHATSAPP:${codigo}`),
    ...(prontidaoSicoob?.bloqueios || []).map(codigo => `SICOOB:${codigo}`)
  ];
  if (!leituraJoelPires) bloqueios.push('JOELPIRES:CREDENCIAIS_INCOMPLETAS');
  if (!gravacaoJoelPires) bloqueios.push('JOELPIRES:GRAVACAO_NAO_HOMOLOGADA');
  return {
    pronto_para_teste: bloqueios.length === 0,
    componentes: {
      whatsapp: Boolean(prontidaoWhatsapp?.pronto_para_homologar),
      sicoob: Boolean(prontidaoSicoob?.pronto_para_teste),
      joel_pires_leitura: leituraJoelPires,
      joel_pires_gravacao: gravacaoJoelPires
    },
    bloqueios
  };
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
        `SELECT wm.nome, wm.idioma, wm.status, wm.ativo,
                EXISTS(
                  SELECT 1 FROM auditoria aud
                   WHERE aud.entidade='whatsapp_modelos'
                     AND aud.entidade_id=CAST(wm.id AS CHAR)
                     AND aud.acao='SINCRONIZAR_MODELO_SENDPULSE'
                ) AS confirmado_sendpulse
           FROM whatsapp_modelos
             wm
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
  const exigirConfirmacaoSendPulse = resumo.componentes.provedor === 'SENDPULSE';
  const modeloOperacional = (nome, idioma) => Boolean(nome) && modelos.some(item =>
    item.nome === nome && item.idioma === idioma &&
    item.status === 'APROVADO' && Number(item.ativo) === 1 &&
    (!exigirConfirmacaoSendPulse || Number(item.confirmado_sendpulse) === 1)
  );
  const fornecedorAprovado = modeloOperacional(modeloFornecedor, idiomaFornecedor);
  const entregaAprovada = modeloOperacional(modeloEntrega, idiomaEntrega);
  const numerosAmbiente = [
    config.fornecedorMarcioWhatsapp,
    config.fornecedorEmersonWhatsapp
  ];
  const fornecedoresValidos = numerosAmbiente.filter(destinatarioWhatsappValido).length;
  const filaSegura = Number(fila.processando || 0) === 0 &&
    Number(fila.incertas || 0) === 0;
  const bloqueios = [];

  if (!resumo.componentes.transporte) bloqueios.push('TRANSPORTE_WHATSAPP_INCOMPLETO');
  if (!resumo.componentes.webhook) bloqueios.push('WEBHOOK_WHATSAPP_INCOMPLETO');
  if (!resumo.componentes.automacao_gm) bloqueios.push('AUTOMACAO_GM_DESABILITADA');
  if (!fornecedorAprovado) bloqueios.push('MODELO_CONSULTA_FORNECEDOR_NAO_HOMOLOGADO');
  if (!entregaAprovada) bloqueios.push('MODELO_ENTREGA_CLIENTE_NAO_HOMOLOGADO');
  if (!fornecedores.length) bloqueios.push('FORNECEDOR_GM_NAO_CADASTRADO');
  else if (fornecedoresValidos !== 2) {
    bloqueios.push('FORNECEDORES_GM_SEM_DESTINATARIO_VALIDO');
  }
  if (!filaSegura) bloqueios.push('FILA_WHATSAPP_REQUER_REVISAO');

  return {
    pronto_para_homologar: bloqueios.length === 0,
    worker_habilitado: resumo.componentes.outbox,
    automacao_habilitada: resumo.componentes.automacao_gm,
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
      destinatarios_invalidos: 2 - fornecedoresValidos
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
    provedor: String(config.whatsappProvedor || 'META').trim().toUpperCase(),
    sendpulseClientId: config.sendpulseClientId,
    sendpulseClientSecret: config.sendpulseClientSecret,
    sendpulseBotId: config.sendpulseBotId,
    sendpulseWebhookToken: config.sendpulseWebhookToken,
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
    automacaoGmHabilitada: verdadeiro(config.automacaoGmWhatsappHabilitada),
    mediaDir: config.whatsappMediaDir,
    mediaMaxBytes: Number(config.whatsappMediaMaxBytes) || null
  };
}

async function obterConfiguracaoSicoob(pool, opcoes = {}) {
  const config = await carregarConfiguracoesIntegracoes(pool);
  const producao = String(config.sicoobAmbiente).toLowerCase() === 'producao';
  const prontidao = diagnosticarProntidaoSicoob(config, opcoes);
  return {
    clientId: config.sicoobClientId, clientSecret: config.sicoobClientSecret,
    certPath: config.sicoobCertPath, keyPath: config.sicoobKeyPath,
    caPath: config.sicoobCaPath, chavePix: config.sicoobChavePix,
    webhookHabilitado: prontidao.componentes.webhook_habilitado &&
      prontidao.componentes.proxy_mtls && prontidao.componentes.ca_webhook_legivel,
    // A criação só pode ser ativada junto com o webhook autenticado por mTLS.
    habilitado: prontidao.pronto_para_teste,
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
    clientSecret: config.blingClientSecret,
    redirectUri: config.blingRedirectUri,
    encryptionKey: config.blingTokenEncryptionKey,
    habilitado: verdadeiro(config.blingOAuthHabilitado),
    apiUrl: 'https://api.bling.com.br/Api/v3'
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
  diagnosticarProntidaoSicoob,
  diagnosticarProntidaoFluxoGm,
  diagnosticarProntidaoWhatsapp,
  obterConfiguracaoBling,
  obterConfiguracaoWhatsapp,
  obterConfiguracaoSicoob,
  obterConfiguracaoWBuy,
  resumirIntegracoes,
  verdadeiro
};
