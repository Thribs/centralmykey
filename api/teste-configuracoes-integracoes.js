'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const {
  carregarConfiguracoesIntegracoes,
  obterConfiguracaoWhatsapp,
  resumirIntegracoes
} = require('./configuracoes-integracoes');

const CHAVES_TESTE = [
  'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_API_VERSION',
  'META_VERIFY_TOKEN', 'META_APP_SECRET',
  'WHATSAPP_MODELO_CONSULTA_FORNECEDOR',
  'WHATSAPP_MODELO_ENTREGA_RESULTADO', 'COMUNICACOES_OUTBOX_HABILITADO'
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
    SICOOB_CLIENT_ID: 'id-ficticio'
  };
  let servidor;
  try {
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
    const itemBling = resumo.find(item => item.codigo === 'BLING');
    assert.strictEqual(itemWhatsapp.status, 'CONFIGURADO');
    assert.strictEqual(itemSicoob.status, 'CREDENCIAIS_SEM_CONECTOR');
    assert.strictEqual(itemBling.status, 'PENDENTE');
    assert.ok(resumo.every(item => !JSON.stringify(item).includes('ficticio')),
      'O resumo nunca pode expor valores de configuração');

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
