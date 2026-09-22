'use strict';

const assert = require('assert');
const {
  avaliarProntidaoServico,
  obterProcessadorServico,
  servicoImplementado
} = require('./servicos-implementados');

const base = {
  codigo: 'GM_SENHA',
  ativo: 1,
  exige_chassi: 1
};

assert.strictEqual(obterProcessadorServico('gm_senha'), 'API_JOELPIRES_GM');
assert.strictEqual(servicoImplementado('GM_SENHA'), true);
assert.strictEqual(servicoImplementado('KIA_SENHA'), false);

assert.deepStrictEqual(
  avaliarProntidaoServico(base, {
    integracoesConfiguradas: { API_JOELPIRES: true },
    fornecedoresAtivos: 2
  }),
  {
    status: 'OPERACIONAL',
    processador: 'API_JOELPIRES_GM',
    integracao: 'API_JOELPIRES',
    fornecedores_ativos: 2,
    lacunas: []
  }
);

const semConfiguracao = avaliarProntidaoServico(
  { ...base, exige_chassi: 0 },
  { integracoesConfiguradas: {}, fornecedoresAtivos: 0 }
);
assert.strictEqual(semConfiguracao.status, 'CONFIGURACAO_PENDENTE');
assert.deepStrictEqual(semConfiguracao.lacunas, [
  'ENTRADA_CHASSI_AUSENTE',
  'INTEGRACAO_API_JOELPIRES_NAO_CONFIGURADA',
  'FORNECEDOR_FALLBACK_AUSENTE'
]);

const somenteCatalogo = avaliarProntidaoServico({
  codigo: 'KIA_SENHA', ativo: 1, exige_chassi: 1
});
assert.strictEqual(somenteCatalogo.status, 'SOMENTE_CATALOGO');
assert.strictEqual(somenteCatalogo.processador, null);
assert.deepStrictEqual(somenteCatalogo.lacunas, ['PROCESSADOR_AUSENTE']);

const inativo = avaliarProntidaoServico({ ...base, ativo: 0 }, {
  integracoesConfiguradas: { API_JOELPIRES: true }, fornecedoresAtivos: 2
});
assert.strictEqual(inativo.status, 'INATIVO');
assert.deepStrictEqual(inativo.lacunas, ['SERVICO_INATIVO']);

console.log('OK: prontidão dos serviços');
