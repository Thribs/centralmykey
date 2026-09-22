'use strict';

const PROCESSADORES = Object.freeze({
  GM_SENHA: Object.freeze({
    codigo: 'API_JOELPIRES_GM',
    integracao: 'API_JOELPIRES',
    entradas_obrigatorias: Object.freeze(['exige_chassi']),
    exige_fornecedor_fallback: true
  })
});

const CODIGOS = Object.freeze(Object.keys(PROCESSADORES));

function obterProcessadorServico(codigo) {
  return PROCESSADORES[String(codigo || '').trim().toUpperCase()]?.codigo || null;
}

function servicoImplementado(codigo) {
  return Boolean(obterProcessadorServico(codigo));
}

function avaliarProntidaoServico(servico, {
  integracoesConfiguradas = {},
  fornecedoresAtivos = 0
} = {}) {
  const codigo = String(servico?.codigo || '').trim().toUpperCase();
  const processador = PROCESSADORES[codigo] || null;
  const lacunas = [];

  if (!Number(servico?.ativo)) lacunas.push('SERVICO_INATIVO');
  if (!processador) lacunas.push('PROCESSADOR_AUSENTE');

  if (processador) {
    for (const entrada of processador.entradas_obrigatorias) {
      if (!Number(servico?.[entrada])) {
        lacunas.push(`ENTRADA_${entrada.replace(/^exige_/, '').toUpperCase()}_AUSENTE`);
      }
    }
    if (processador.integracao && !integracoesConfiguradas[processador.integracao]) {
      lacunas.push(`INTEGRACAO_${processador.integracao}_NAO_CONFIGURADA`);
    }
    if (processador.exige_fornecedor_fallback && Number(fornecedoresAtivos) < 1) {
      lacunas.push('FORNECEDOR_FALLBACK_AUSENTE');
    }
  }

  let status = 'OPERACIONAL';
  if (!Number(servico?.ativo)) status = 'INATIVO';
  else if (!processador) status = 'SOMENTE_CATALOGO';
  else if (lacunas.length) status = 'CONFIGURACAO_PENDENTE';

  return {
    status,
    processador: processador?.codigo || null,
    integracao: processador?.integracao || null,
    fornecedores_ativos: Number(fornecedoresAtivos) || 0,
    lacunas
  };
}

module.exports = {
  CODIGOS_SERVICOS_IMPLEMENTADOS: CODIGOS,
  avaliarProntidaoServico,
  obterProcessadorServico,
  servicoImplementado
};
