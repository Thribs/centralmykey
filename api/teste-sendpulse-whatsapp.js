'use strict';

const assert = require('assert');
const {
  enviarMensagemSendPulse,
  enviarModeloSendPulse,
  listarModelosSendPulse,
  limparCacheTokenParaTeste
} = require('./cliente-sendpulse-whatsapp');

async function executar() {
  const fetchOriginal = global.fetch;
  const chamadas = [];
  const config = {
    sendpulseClientId: 'id-ficticio',
    sendpulseClientSecret: 'segredo-ficticio',
    sendpulseBotId: 'bot-ficticio'
  };
  try {
    limparCacheTokenParaTeste();
    global.fetch = async (url, opcoes) => {
      chamadas.push({ url: String(url), opcoes });
      if (String(url).endsWith('/oauth/access_token')) {
        return { ok: true, status: 200, json: async () => ({
          access_token: 'token-ficticio', expires_in: 3600
        }) };
      }
      if (String(url).includes('/whatsapp/templates?')) {
        return { ok: true, status: 200, json: async () => ({
          success: true,
          data: [{ id: 'modelo-1', name: 'consulta_fornecedor_gm',
            language: 'pt_BR', status: 'APPROVED' }]
        }) };
      }
      return { ok: true, status: 200, json: async () => ({
        success: true, data: { message_id: `sp-${chamadas.length}` }
      }) };
    };
    const texto = await enviarMensagemSendPulse(config, {
      telefone: '5511999999999', texto: 'Mensagem de teste'
    });
    assert.strictEqual(texto.mensagem_externa_id, 'sp-2');
    assert.deepStrictEqual(JSON.parse(chamadas[1].opcoes.body), {
      bot_id: 'bot-ficticio', phone: '+5511999999999',
      message: { type: 'text', text: { body: 'Mensagem de teste' } }
    });
    const modelo = await enviarModeloSendPulse(config, {
      telefone: '+5511888888888', nome: 'consulta_fornecedor_gm',
      idioma: 'pt_BR', parametros: ['PROTOCOLO', 'CHASSI']
    });
    assert.strictEqual(modelo.mensagem_externa_id, 'sp-3');
    assert.strictEqual(chamadas.filter(item =>
      item.url.endsWith('/oauth/access_token')).length, 1);
    const corpoModelo = JSON.parse(chamadas[2].opcoes.body);
    assert.strictEqual(corpoModelo.template.name, 'consulta_fornecedor_gm');
    assert.deepStrictEqual(corpoModelo.template.components[0].parameters,
      [{ type: 'text', text: 'PROTOCOLO' }, { type: 'text', text: 'CHASSI' }]);
    const modelos = await listarModelosSendPulse(config);
    assert.strictEqual(modelos[0].status, 'APPROVED');
    assert.match(chamadas[3].url,
      /\/whatsapp\/templates\?bot_id=bot-ficticio$/);
    assert.ok(!JSON.stringify({ texto, modelo }).includes('segredo-ficticio'));
    console.log('OK: transporte SendPulse usa OAuth, texto e modelo com mocks');
  } finally {
    global.fetch = fetchOriginal;
    limparCacheTokenParaTeste();
  }
}

executar().catch(error => {
  console.error(`FALHA: teste do WhatsApp SendPulse: ${error.message}`);
  process.exitCode = 1;
});
