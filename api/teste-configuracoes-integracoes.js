'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const {
  carregarConfiguracoesIntegracoes,
  diagnosticarProntidaoFluxoGm,
  diagnosticarProntidaoPrimeiroCenarioGm,
  diagnosticarProntidaoSicoob,
  diagnosticarProntidaoWhatsapp,
  obterConfiguracaoSicoob,
  obterConfiguracaoWhatsapp,
  resumirIntegracoes
} = require('./configuracoes-integracoes');
const {
  chaveSensivel,
  mascararConfiguracao
} = require('./seguranca-configuracoes');

const CHAVES_TESTE = [
  'WHATSAPP_PROVEDOR', 'SENDPULSE_CLIENT_ID', 'SENDPULSE_CLIENT_SECRET',
  'SENDPULSE_WHATSAPP_BOT_ID', 'SEGREDO_WEBHOOK_SENDPULSE',
  'WHATSAPP_GRUPO_FORNECEDOR_MARCIO_ID',
  'WHATSAPP_GRUPO_FORNECEDOR_EMERSON_ID',
  'WHATSAPP_GRUPOS_FORNECEDORES_HOMOLOGADOS',
  'WHATSAPP_MODELO_GRUPO_FORNECEDOR_HOMOLOGADO',
  'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_API_VERSION',
  'META_VERIFY_TOKEN', 'META_APP_SECRET',
  'WHATSAPP_MODELO_CONSULTA_FORNECEDOR',
  'WHATSAPP_MODELO_ENTREGA_RESULTADO', 'COMUNICACOES_OUTBOX_HABILITADO',
  'AUTOMACAO_GM_WHATSAPP_HABILITADA',
  'AUTOMACAO_GM_WHATSAPP_TELEFONES_TESTE',
  'APIJOELPIRES_GRAVACAO_HOMOLOGADA',
  'SICOOB_CLIENT_ID', 'SICOOB_CERT_PATH', 'SICOOB_KEY_PATH',
  'SICOOB_CERTIFICADO_SENHA', 'SICOOB_CA_PATH', 'SICOOB_WEBHOOK_CA_PATH',
  'SICOOB_CHAVE_PIX', 'SICOOB_AMBIENTE',
  'SICOOB_COBRANCA_HABILITADA', 'SICOOB_CONSULTA_HABILITADA',
  'SICOOB_WEBHOOK_HABILITADO',
  'SICOOB_WEBHOOK_MTLS_CONFIGURADO',
  'SICOOB_WEBHOOK_URL', 'SICOOB_WEBHOOK_CADASTRADO',
  'PAGAMENTO_PIX_PROVEDOR',
  'PLUGPAY_CLIENT_ID', 'PLUGPAY_PASSWORD', 'PLUGPAY_DOCUMENT_MERCHANT',
  'PLUGPAY_AMBIENTE', 'PLUGPAY_COBRANCA_HABILITADA',
  'PLUGPAY_CONSULTA_HABILITADA', 'PLUGPAY_WEBHOOK_HABILITADO',
  'WBUY_USUARIO', 'WBUY_USERNAME', 'WBUY_SENHA', 'WBUY_PASSWORD',
  'WBUY_LOJA_URL', 'WBUY_TOKEN', 'WBUY_API_KEY',
  'BLING_CLIENT_ID', 'BLING_CLIENT_SECRET', 'BLING_REDIRECT_URI',
  'BLING_OAUTH_HABILITADO', 'BLING_TOKEN_ENCRYPTION_KEY'
];

function poolFalso(valores) {
  return {
    query: async sql => {
      if (/FROM configuracoes/.test(sql)) {
        return [Object.entries(valores).map(([chave, valor]) => ({ chave, valor }))];
      }
      return [{ affectedRows: 0 }];
    }
  };
}

async function servidorWhatsapp(pool) {
  const app = express();
  app.use(express.json({ verify: (req, res, buffer) => { req.rawBody = buffer; } }));
  require('./rotas-whatsapp')(app, pool);
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}`, app };
}

async function fechar(servidor) {
  await new Promise((resolve, reject) => servidor.close(e => e ? reject(e) : resolve()));
}

async function executar() {
  const ambienteOriginal = Object.fromEntries(
    CHAVES_TESTE.map(chave => [chave, process.env[chave]])
  );
  const fetchOriginal = global.fetch;
  const valores = {
    WHATSAPP_ACCESS_TOKEN: 'token-ficticio-banco',
    WHATSAPP_PHONE_NUMBER_ID: 'phone-ficticio',
    WHATSAPP_API_VERSION: 'v99.0',
    META_VERIFY_TOKEN: 'verify-ficticio',
    META_APP_SECRET: 'secret-ficticio',
    WHATSAPP_MODELO_CONSULTA_FORNECEDOR: 'consulta_teste',
    WHATSAPP_MODELO_ENTREGA_RESULTADO: 'entrega_teste',
    COMUNICACOES_OUTBOX_HABILITADO: 'true',
    AUTOMACAO_GM_WHATSAPP_HABILITADA: 'true',
    AUTOMACAO_GM_WHATSAPP_TELEFONES_TESTE: '5535999999999, 5535888888888',
    WHATSAPP_GRUPO_FORNECEDOR_MARCIO_ID: 'grupo_meta_marcio_1234567890',
    WHATSAPP_GRUPO_FORNECEDOR_EMERSON_ID: 'grupo_meta_emerson_1234567890',
    WHATSAPP_GRUPOS_FORNECEDORES_HOMOLOGADOS: 'true',
    WHATSAPP_MODELO_GRUPO_FORNECEDOR_HOMOLOGADO: 'true',
    CHAVE_API_JOELPIRES: 'chave-joel-ficticia',
    ID_USUARIO_API_JOELPIRES: 'usuario-joel-ficticio',
    APIJOELPIRES_GRAVACAO_HOMOLOGADA: 'true',
    SICOOB_CLIENT_ID: 'id-ficticio',
    WBUY_TOKEN: 'token-legado-ficticio'
  };
  let servidor;
  try {
    for (const chave of [
      'CHAVE_API_JOELPIRES', 'JWT_SECRET', 'WBUY_SENHA',
      'WHATSAPP_ACCESS_TOKEN', 'SICOOB_KEY_PATH', 'SICOOB_CERTIFICADO_SENHA',
      'BLING_TOKEN_ENCRYPTION_KEY', 'AUTOMACAO_GM_WHATSAPP_TELEFONES_TESTE'
    ]) {
      assert.strictEqual(chaveSensivel(chave), true, `${chave} deve ser sensível`);
      const mascarada = mascararConfiguracao({ chave, valor: 'nao-expor' });
      assert.strictEqual(mascarada.valor, '••••••••');
      assert.strictEqual(mascarada.configurado, true);
      assert.strictEqual(mascarada.sensivel, true);
    }
    assert.deepStrictEqual(
      mascararConfiguracao({ chave: 'LIMITE_LOTE', valor: '10' }),
      { chave: 'LIMITE_LOTE', valor: '10', configurado: true, sensivel: false }
    );
    for (const chave of CHAVES_TESTE) delete process.env[chave];
    process.env.WHATSAPP_API_VERSION = 'v98.0';
    process.env.WHATSAPP_GRUPO_FORNECEDOR_MARCIO_ID =
      'grupo_meta_marcio_1234567890';
    process.env.WHATSAPP_GRUPO_FORNECEDOR_EMERSON_ID =
      'grupo_meta_emerson_1234567890';
    process.env.AUTOMACAO_GM_WHATSAPP_TELEFONES_TESTE =
      valores.AUTOMACAO_GM_WHATSAPP_TELEFONES_TESTE;
    const pool = poolFalso(valores);
    const carregada = await carregarConfiguracoesIntegracoes(pool);
    assert.strictEqual(carregada.whatsappApiVersion, 'v98.0',
      'O .env deve prevalecer sobre configuração do banco');
    const whatsapp = await obterConfiguracaoWhatsapp(pool);
    assert.strictEqual(whatsapp.accessToken, valores.WHATSAPP_ACCESS_TOKEN);
    assert.strictEqual(whatsapp.outboxHabilitada, true);
    assert.strictEqual(whatsapp.automacaoGmHabilitada, true);
    assert.deepStrictEqual(whatsapp.telefonesTeste,
      ['5535999999999', '5535888888888']);

    const resumo = resumirIntegracoes(carregada);
    const itemWhatsapp = resumo.find(item => item.codigo === 'WHATSAPP');
    const itemSicoob = resumo.find(item => item.codigo === 'SICOOB');
    const itemPlugPay = resumo.find(item => item.codigo === 'PLUGPAY');
    const itemBling = resumo.find(item => item.codigo === 'BLING');
    const itemWbuy = resumo.find(item => item.codigo === 'WBUY');
    assert.strictEqual(itemWhatsapp.status, 'CONFIGURADO');
    assert.strictEqual(itemWhatsapp.componentes.telefones_teste, 2);
    assert.strictEqual(itemSicoob.status, 'PENDENTE');
    assert.strictEqual(itemSicoob.habilitado, false);
    assert.strictEqual(itemSicoob.componentes.cobranca_habilitada, false);
    assert.strictEqual(itemSicoob.componentes.webhook_publico_mtls, false);
    assert.strictEqual(itemPlugPay.status, 'PENDENTE');
    assert.strictEqual(itemPlugPay.configurado, false);
    assert.strictEqual(itemPlugPay.componentes.identidade_provedor, true);
    assert.strictEqual(itemPlugPay.componentes.credenciamento_documentado, true);
    assert.strictEqual(itemPlugPay.componentes.ambiente_sandbox, true);
    assert.strictEqual(itemPlugPay.componentes.contrato_transacional, true);
    assert.strictEqual(itemPlugPay.componentes.conector, true);
    assert.strictEqual(itemPlugPay.componentes.webhook, false);
    assert.strictEqual(itemWbuy.status, 'CREDENCIAIS_SEM_CONECTOR');
    assert.strictEqual(itemWbuy.componentes.credencial_legada, true);
    assert.strictEqual(itemBling.status, 'PENDENTE');
    assert.strictEqual(itemBling.componentes.webhook_assinado, true);
    assert.strictEqual(itemBling.componentes.oauth_fundacao, true);
    assert.strictEqual(itemBling.componentes.oauth_configurado, false);
    assert.ok(resumo.every(item => !JSON.stringify(item).includes('ficticio')),
      'O resumo nunca pode expor valores de configuração');

    const poolProntidao = {
      query: async sql => {
        if (/FROM whatsapp_modelos/.test(sql)) return [[
          { nome: 'consulta_teste', idioma: 'pt_BR', status: 'APROVADO', ativo: 1 },
          { nome: 'entrega_teste', idioma: 'pt_BR', status: 'APROVADO', ativo: 1 }
        ]];
        if (/FROM fornecedores/.test(sql)) return [[
          { id: 1, whatsapp: '(11) 99999-9999', telefone: null },
          { id: 2, whatsapp: null, telefone: '11988887777' }
        ]];
        if (/FROM comunicacoes_outbox/.test(sql)) return [[{
          pendentes: 0, processando: 0, falhas: 1, incertas: 0
        }]];
        throw new Error('Consulta inesperada no diagnóstico');
      }
    };
    const prontidao = await diagnosticarProntidaoWhatsapp(poolProntidao, carregada);
    assert.strictEqual(prontidao.pronto_para_homologar, true);
    assert.deepStrictEqual(prontidao.bloqueios, []);
    assert.strictEqual(prontidao.fornecedores_gm.grupos_configurados, 2);
    assert.strictEqual(prontidao.fornecedores_gm.grupos_meta_homologados, true);
    assert.strictEqual(prontidao.fila.falhas, 1);
    assert.ok(!JSON.stringify(prontidao).includes('99999'),
      'O diagnóstico não deve expor telefones');

    const prontidaoSendPulseSemConfirmacao = await diagnosticarProntidaoWhatsapp(
      poolProntidao,
      {
        ...carregada,
        whatsappProvedor: 'SENDPULSE',
        sendpulseClientId: 'id-ficticio',
        sendpulseClientSecret: 'segredo-ficticio',
        sendpulseBotId: 'bot-ficticio',
        sendpulseWebhookSecret: 'segredo_ficticio_123456789012345678'
      }
    );
    assert.ok(!prontidaoSendPulseSemConfirmacao.bloqueios.includes(
      'MODELO_GRUPO_FORNECEDOR_NAO_HOMOLOGADO'));
    assert.ok(prontidaoSendPulseSemConfirmacao.bloqueios.includes(
      'MODELO_ENTREGA_CLIENTE_NAO_HOMOLOGADO'));

    const prontidaoBloqueada = await diagnosticarProntidaoWhatsapp({
      query: async sql => {
        if (/FROM whatsapp_modelos/.test(sql)) return [[]];
        if (/FROM fornecedores/.test(sql)) return [[
          { id: 1, whatsapp: 'invalido', telefone: '' }
        ]];
        if (/FROM comunicacoes_outbox/.test(sql)) return [[{
          pendentes: 2, processando: 1, falhas: 0, incertas: 1
        }]];
        throw new Error('Consulta inesperada no diagnóstico bloqueado');
      }
    }, { ...carregada, whatsappAccessToken: '', modeloEntrega: '',
      grupoFornecedorMarcioId: '', grupoFornecedorEmersonId: '',
      gruposFornecedoresHomologados: '' });
    assert.strictEqual(prontidaoBloqueada.pronto_para_homologar, false);
    assert.ok(prontidaoBloqueada.bloqueios.includes('TRANSPORTE_WHATSAPP_INCOMPLETO'));
    assert.ok(prontidaoBloqueada.bloqueios.includes(
      'MODELO_ENTREGA_CLIENTE_NAO_HOMOLOGADO'));
    assert.ok(prontidaoBloqueada.bloqueios.includes(
      'GRUPOS_FORNECEDORES_GM_NAO_CONFIGURADOS'));
    assert.ok(prontidaoBloqueada.bloqueios.includes('FILA_WHATSAPP_REQUER_REVISAO'));

    const prontidaoSemWorker = await diagnosticarProntidaoWhatsapp(
      poolProntidao,
      { ...carregada, outboxHabilitada: '' }
    );
    assert.strictEqual(prontidaoSemWorker.pronto_para_homologar, false);
    assert.strictEqual(prontidaoSemWorker.worker_habilitado, false);
    assert.ok(prontidaoSemWorker.bloqueios.includes(
      'OUTBOX_WHATSAPP_DESABILITADA'));

    const configuracaoSicoobCompleta = {
      SICOOB_CLIENT_ID: 'id-ficticio',
      SICOOB_CERT_PATH: '/certificado/ficticio',
      SICOOB_KEY_PATH: '/chave/ficticia',
      SICOOB_CERTIFICADO_SENHA: 'senha-ficticia',
      SICOOB_WEBHOOK_CA_PATH: '/ca-webhook/ficticia',
      SICOOB_CHAVE_PIX: 'pix-ficticia',
      SICOOB_AMBIENTE: 'producao',
      SICOOB_COBRANCA_HABILITADA: 'true',
      SICOOB_WEBHOOK_HABILITADO: 'true',
      SICOOB_WEBHOOK_MTLS_CONFIGURADO: 'true',
      SICOOB_WEBHOOK_URL: 'https://sicoob-webhook.teste.invalid/webhooks/sicoob',
      SICOOB_WEBHOOK_CADASTRADO: 'true'
    };
    Object.assign(process.env, configuracaoSicoobCompleta);
    const diagnosticoSicoob = diagnosticarProntidaoSicoob(
      await carregarConfiguracoesIntegracoes(poolFalso(configuracaoSicoobCompleta)),
      { arquivoLegivel: () => true }
    );
    assert.strictEqual(diagnosticoSicoob.pronto_para_teste, true);
    assert.deepStrictEqual(diagnosticoSicoob.bloqueios, []);
    assert.ok(!JSON.stringify(diagnosticoSicoob).includes('fictici'),
      'O diagnóstico Sicoob não deve expor valores de configuração');
    const sicoobHabilitado = await obterConfiguracaoSicoob(
      poolFalso(configuracaoSicoobCompleta), { arquivoLegivel: () => true }
    );
    assert.strictEqual(sicoobHabilitado.habilitado, true);
    assert.strictEqual(sicoobHabilitado.webhookHabilitado, true);
    assert.strictEqual(sicoobHabilitado.tokenUrl,
      'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token');
    assert.strictEqual(sicoobHabilitado.apiUrl,
      'https://api.sicoob.com.br/pix/api/v2');
    const configuracaoSicoobConsulta = {
      ...configuracaoSicoobCompleta,
      SICOOB_CONSULTA_HABILITADA: 'true',
      SICOOB_WEBHOOK_HABILITADO: 'false',
      SICOOB_WEBHOOK_MTLS_CONFIGURADO: 'false',
      SICOOB_WEBHOOK_URL: '',
      SICOOB_WEBHOOK_CADASTRADO: 'false',
      SICOOB_WEBHOOK_CA_PATH: ''
    };
    Object.assign(process.env, configuracaoSicoobConsulta);
    const diagnosticoConsulta = diagnosticarProntidaoSicoob(
      await carregarConfiguracoesIntegracoes(poolFalso(configuracaoSicoobConsulta)),
      { arquivoLegivel: caminho => Boolean(caminho) }
    );
    assert.strictEqual(diagnosticoConsulta.pronto_para_teste, true);
    assert.strictEqual(diagnosticoConsulta.componentes.consulta_habilitada, true);
    assert.ok(!diagnosticoConsulta.bloqueios.includes(
      'PROXY_MTLS_SICOOB_NAO_CONFIGURADO'));
    const sicoobConsulta = await obterConfiguracaoSicoob(
      poolFalso(configuracaoSicoobConsulta),
      { arquivoLegivel: caminho => Boolean(caminho) }
    );
    assert.strictEqual(sicoobConsulta.habilitado, true);
    assert.strictEqual(sicoobConsulta.consultaHabilitada, true);
    assert.strictEqual(sicoobConsulta.webhookHabilitado, false);
    for (const chave of CHAVES_TESTE.filter(item => item.startsWith('SICOOB_'))) {
      delete process.env[chave];
    }
    const sicoobSemCredencial = await obterConfiguracaoSicoob(poolFalso({
      SICOOB_COBRANCA_HABILITADA: 'true',
      SICOOB_WEBHOOK_HABILITADO: 'true'
    }));
    assert.strictEqual(sicoobSemCredencial.habilitado, false);
    const diagnosticoSicoobBloqueado = diagnosticarProntidaoSicoob({
      sicoobAmbiente: 'desconhecido',
      sicoobCobrancaHabilitada: 'true', sicoobWebhookHabilitado: 'true'
    });
    assert.strictEqual(diagnosticoSicoobBloqueado.pronto_para_teste, false);
    assert.ok(diagnosticoSicoobBloqueado.bloqueios.includes(
      'PROXY_MTLS_SICOOB_NAO_CONFIGURADO'));
    assert.ok(diagnosticoSicoobBloqueado.bloqueios.includes(
      'CA_WEBHOOK_SICOOB_INACESSIVEL'));
    assert.ok(diagnosticoSicoobBloqueado.bloqueios.includes(
      'WEBHOOK_SICOOB_NAO_CADASTRADO'));
    Object.assign(process.env, configuracaoSicoobCompleta);
    const fluxoGmPronto = diagnosticarProntidaoFluxoGm(
      await carregarConfiguracoesIntegracoes(poolFalso({
        ...valores, ...configuracaoSicoobCompleta
      })), prontidao, diagnosticoSicoob
    );
    assert.strictEqual(fluxoGmPronto.pronto_para_teste, true);
    assert.deepStrictEqual(fluxoGmPronto.bloqueios, []);
    const fluxoGmBloqueado = diagnosticarProntidaoFluxoGm(
      {}, prontidaoBloqueada, diagnosticoSicoobBloqueado
    );
    assert.strictEqual(fluxoGmBloqueado.pronto_para_teste, false);
    assert.ok(fluxoGmBloqueado.bloqueios.includes(
      'JOELPIRES:GRAVACAO_NAO_HOMOLOGADA'));

    const whatsappPrimeiroCenario = {
      ...prontidaoBloqueada,
      telefones_teste: 1,
      bloqueios: [
        'MODELO_GRUPO_FORNECEDOR_NAO_HOMOLOGADO',
        'FORNECEDOR_GM_NAO_CADASTRADO',
        'GRUPOS_FORNECEDORES_GM_NAO_CONFIGURADOS',
        'GRUPOS_FORNECEDORES_META_NAO_HOMOLOGADOS'
      ]
    };
    const primeiroCenarioPronto = diagnosticarProntidaoPrimeiroCenarioGm(
      await carregarConfiguracoesIntegracoes(poolFalso({
        ...valores, ...configuracaoSicoobCompleta,
        APIJOELPIRES_GRAVACAO_HOMOLOGADA: 'false'
      })),
      whatsappPrimeiroCenario,
      diagnosticoSicoob
    );
    assert.strictEqual(primeiroCenarioPronto.pronto_para_teste, true);
    assert.deepStrictEqual(primeiroCenarioPronto.bloqueios, []);
    assert.strictEqual(primeiroCenarioPronto.componentes.joel_pires_leitura, true);
    assert.strictEqual(primeiroCenarioPronto.componentes.contato_teste, true);

    const primeiroCenarioSemContato = diagnosticarProntidaoPrimeiroCenarioGm(
      { joelPiresChave: 'chave', joelPiresUsuario: 'usuario' },
      { ...whatsappPrimeiroCenario, telefones_teste: 0 },
      diagnosticoSicoob
    );
    assert.strictEqual(primeiroCenarioSemContato.pronto_para_teste, false);
    assert.ok(primeiroCenarioSemContato.bloqueios.includes(
      'WHATSAPP:CONTATO_TESTE_NAO_CONFIGURADO'));

    const requisicoesMeta = [];
    global.fetch = async (url, opcoes) => {
      assert.match(String(url), /^https:\/\/graph\.facebook\.com\/v98\.0\//);
      assert.strictEqual(opcoes.headers.Authorization,
        `Bearer ${valores.WHATSAPP_ACCESS_TOKEN}`);
      requisicoesMeta.push(JSON.parse(opcoes.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ id: 'wamid.mock.config' }] })
      };
    };
    const api = await servidorWhatsapp(pool);
    servidor = api.servidor;
    const envioGrupo = await api.app.locals.enviarModeloWhatsapp({
      tipoDestinatario: 'GRUPO_META',
      grupoId: 'grupo_meta_marcio_1234567890',
      nome: 'consulta_grupo_fornecedor',
      idioma: 'pt_BR',
      parametros: ['PROTOCOLO-1']
    });
    assert.strictEqual(envioGrupo.grupo_id, 'grupo_meta_marcio_1234567890');
    assert.strictEqual(requisicoesMeta[0].recipient_type, 'group');
    assert.strictEqual(requisicoesMeta[0].to, 'grupo_meta_marcio_1234567890');
    const envio = await api.app.locals.enviarMensagemWhatsapp({
      telefone: '5511999999999',
      texto: 'Mensagem fictícia'
    });
    assert.strictEqual(envio.mensagem_externa_id, 'wamid.mock.config');
    assert.strictEqual(requisicoesMeta[1].recipient_type, 'individual');
    global.fetch = fetchOriginal;

    let resposta = await fetch(
      `${api.url}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=` +
      `${encodeURIComponent(valores.META_VERIFY_TOKEN)}&hub.challenge=12345`
    );
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(await resposta.text(), '12345');

    const corpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const assinatura = `sha256=${crypto.createHmac('sha256', valores.META_APP_SECRET)
      .update(Buffer.from(corpo)).digest('hex')}`;
    resposta = await fetch(`${api.url}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': assinatura },
      body: corpo
    });
    assert.strictEqual(resposta.status, 200);
  } finally {
    global.fetch = fetchOriginal;
    if (servidor) await fechar(servidor);
    for (const [chave, valor] of Object.entries(ambienteOriginal)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  }
  console.log('OK: configurações e webhook WhatsApp usam fonte unificada sem expor segredos');
}

executar().catch(erro => {
  console.error(`FALHA: configurações de integrações: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
