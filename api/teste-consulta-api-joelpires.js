'use strict';

const assert = require('assert');
const {
  chamarBuscaApi,
  mapearSenhaApi,
  obterMontadoraId
} = require('./consulta-api-joelpires');

process.env.AMBIENTE_API_JOELPIRES = 'teste';
process.env.URL_API_JOELPIRES_TESTE = 'https://staging.api.joelpires.com.br';
process.env.CHAVE_API_JOELPIRES = 'chave-de-teste';
process.env.ID_USUARIO_API_JOELPIRES = '-7';
process.env.APIJOELPIRES_ID_DISPOSITIVO = 'centralmykey';
process.env.APIJOELPIRES_VERSAO_APP = '2.7.2%2Bcentralmykey';

async function executar() {
  assert.strictEqual(obterMontadoraId({ marca: 'GM' }), 1);
  assert.strictEqual(obterMontadoraId({ marca: 'Citroën' }), 3);
  assert.strictEqual(obterMontadoraId({ marca: 'Jeep' }), 6);
  assert.strictEqual(obterMontadoraId({ marca: 'Marca inexistente' }), null);

  let requisicao;
  const resposta = await chamarBuscaApi({
    montadoraId: 1,
    chassi: '9BGJP7520MB197925',
    fetchImpl: async (url, opcoes) => {
      requisicao = { url, opcoes };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{
          id: 101,
          montadoraId: 1,
          chassis: '9BGJP7520MB197925',
          codMecanico: 'Z5917',
          codImmo: '8077',
          codAlarme: '3400'
        }])
      };
    }
  });

  assert.strictEqual(resposta.length, 1);
  assert.match(requisicao.url, /chassi=MB197925/);
  assert.match(requisicao.url, /montadora_id=1/);
  assert.match(requisicao.url, /user_id=-7/);
  assert.strictEqual(requisicao.opcoes.headers['chave-api'], 'chave-de-teste');
  assert.strictEqual(
    requisicao.opcoes.headers['id-dispositivo-mykey'],
    'centralmykey'
  );

  const senha = mapearSenhaApi(resposta[0], {
    montadoraId: 1,
    chassi: '9BGJP7520MB197925',
    codigoServico: 'GM_SENHA',
    marca: 'GM',
    modelo: null
  });

  assert.strictEqual(senha.api_senha_id, 101);
  assert.strictEqual(senha.chassi, '9BGJP7520MB197925');
  assert.strictEqual(senha.codigo_mecanico, 'Z5917');
  assert.strictEqual(senha.codigo_imobilizador, '8077');
  assert.strictEqual(senha.codigo_alarme, '3400');

  console.log('OK: consulta API Joel Pires');
}

executar().catch(erro => {
  console.error(erro);
  process.exitCode = 1;
});
