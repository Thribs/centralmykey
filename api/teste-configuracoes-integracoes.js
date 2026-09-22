'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const {
  carregarConfiguracoesIntegracoes,
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
  'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_API_VERSION',
  'META_VERIFY_TOKEN', 'META_APP_SECRET',
  'WHATSAPP_MODELO_CONSULTA_FORNECEDOR',
  'WHATSAPP_MODELO_ENTREGA_RESULTADO', 'COMUNICACOES_OUTBOX_HABILITADO',
  'SICOOB_CLIENT_ID', 'SICOOB_CLIENT_SECRET', 'SICOOB_CERT_PATH',
  'SICOOB_KEY_PATH', 'SICOOB_CA_PATH', 'SICOOB_CHAVE_PIX', 'SICOOB_AMBIENTE',
  'SICOOB_COBRANCA_HABILITADA', 'SICOOB_WEBHOOK_HABILITADO',
  'WBUY_USUARIO', 'WBUY_USERNAME', 'WBUY_SENHA', 'WBUY_PASSWORD',
  'WBUY_LOJA_URL', 'WBUY_TOKEN', 'WBUY_API_KEY'
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
    SICOOB_CLIENT_ID: 'id-ficticio',
    WBUY_TOKEN: 'token-legado-ficticio'
  };
  let servidor;
  try {
    for (const chave of [
      'CHAVE_API_JOELPIRES', 'JWT_SECRET', 'WBUY_SENHA',
      'WHATSAPP_ACCESS_TOKEN', 'SICOOB_KEY_PATH'
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
    const pool = poolFalso(valores);
    const carregada = await carregarConfiguracoesIntegracoes(pool);
    assert.strictEqual(carregada.whatsappApiVersion, 'v98.0',
      'O .env deve prevalecer sobre configuração do banco');
    const whatsapp = await obterConfiguracaoWhatsapp(pool);
    assert.strictEqual(whatsapp.accessToken, valores.WHATSAPP_ACCESS_TOKEN);
    assert.strictEqual(whatsapp.outboxHabilitada, true);

    const resumo = resumirIntegracoes(carregada);
    const itemWhatsapp = resumo.find(item => item.codigo === 'WHATSAPP');
    const itemSicoob = resumo.find(item => item.codigo === 'SICOOB');
    const itemPlugPay = resumo.find(item => item.codigo === 'PLUGPAY');
    const itemBling = resumo.find(item => item.codigo === 'BLING');
    const itemWbuy = resumo.find(item => item.codigo === 'WBUY');
    assert.strictEqual(itemWhatsapp.status, 'CONFIGURADO');
    assert.strictEqual(itemSicoob.status, 'PARCIAL');
    assert.strictEqual(itemSicoob.habilitado, false);
    assert.strictEqual(itemSicoob.componentes.cobranca_habilitada, false);
    assert.strictEqual(itemSicoob.componentes.webhook_publico_mtls, false);
    assert.strictEqual(itemPlugPay.status, 'CONTRATO_NAO_IDENTIFICADO');
    assert.strictEqual(itemPlugPay.configurado, false);
    assert.strictEqual(itemPlugPay.componentes.identidade_provedor, false);
    assert.strictEqual(itemWbuy.status, 'CREDENCIAIS_SEM_CONECTOR');
    assert.strictEqual(itemWbuy.componentes.credencial_legada, true);
    assert.strictEqual(itemBling.status, 'PENDENTE');
    assert.strictEqual(itemBling.componentes.webhook_assinado, true);
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
    assert.strictEqual(prontidao.fornecedores_gm.destinatarios_validos, 2);
    assert.strictEqual(prontidao.fila.falhas, 1);
    assert.ok(!JSON.stringify(prontidao).includes('99999'),
      'O diagnóstico não deve expor telefones');

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
    }, { ...carregada, whatsappAccessToken: '', modeloEntrega: '' });
    assert.strictEqual(prontidaoBloqueada.pronto_para_homologar, false);
    assert.ok(prontidaoBloqueada.bloqueios.includes('TRANSPORTE_WHATSAPP_INCOMPLETO'));
    assert.ok(prontidaoBloqueada.bloqueios.includes(
      'MODELO_ENTREGA_CLIENTE_NAO_HOMOLOGADO'));
    assert.ok(prontidaoBloqueada.bloqueios.includes(
      'FORNECEDORES_GM_SEM_DESTINATARIO_VALIDO'));
    assert.ok(prontidaoBloqueada.bloqueios.includes('FILA_WHATSAPP_REQUER_REVISAO'));

    const sicoobHabilitado = await obterConfiguracaoSicoob(poolFalso({
      SICOOB_CLIENT_ID: 'id-ficticio',
      SICOOB_CLIENT_SECRET: 'segredo-ficticio',
      SICOOB_CERT_PATH: '/certificado/ficticio',
      SICOOB_KEY_PATH: '/chave/ficticia',
      SICOOB_CHAVE_PIX: 'pix-ficticia',
      SICOOB_COBRANCA_HABILITADA: 'true',
      SICOOB_WEBHOOK_HABILITADO: 'true'
    }));
    assert.strictEqual(sicoobHabilitado.habilitado, true);
    const sicoobSemCredencial = await obterConfiguracaoSicoob(poolFalso({
      SICOOB_COBRANCA_HABILITADA: 'true',
      SICOOB_WEBHOOK_HABILITADO: 'true'
    }));
    assert.strictEqual(sicoobSemCredencial.habilitado, false);

    global.fetch = async (url, opcoes) => {
      assert.match(String(url), /^https:\/\/graph\.facebook\.com\/v98\.0\//);
      assert.strictEqual(opcoes.headers.Authorization,
        `Bearer ${valores.WHATSAPP_ACCESS_TOKEN}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ id: 'wamid.mock.config' }] })
      };
    };
    const api = await servidorWhatsapp(pool);
    servidor = api.servidor;
    const envio = await api.app.locals.enviarMensagemWhatsapp({
      telefone: '5511999999999',
      texto: 'Mensagem fictícia'
    });
    assert.strictEqual(envio.mensagem_externa_id, 'wamid.mock.config');
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
