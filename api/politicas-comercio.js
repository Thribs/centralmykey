'use strict';

const PROVEDORES_COMERCIO = ['WBUY', 'BLING'];
const MOEDAS_COMERCIO = ['BRL', 'USD', 'PYG'];
const ORIGENS_IDENTIDADE = ['ORIGEM_EXTERNA', 'CADASTRO_CENTRAL', 'MANUAL'];
const PAPEIS_IDENTIDADE = ['CLIENTE', 'COMPRADOR', 'PAGADOR'];

function chaveMoeda(provedor) {
  return `INTEGRACAO_${provedor}_MOEDA`;
}

function chaveIdentidade(provedor, papel) {
  return `INTEGRACAO_${provedor}_IDENTIDADE_${papel}`;
}

async function obterPoliticaComercio(connection, provedor) {
  if (!PROVEDORES_COMERCIO.includes(provedor)) return null;
  const chaves = [chaveMoeda(provedor),
    ...PAPEIS_IDENTIDADE.map(papel => chaveIdentidade(provedor, papel))];
  const [linhas] = await connection.query(
    'SELECT chave, valor FROM configuracoes WHERE chave IN (?)', [chaves]
  );
  const valores = Object.fromEntries(linhas.map(item => [item.chave, item.valor]));
  const identidades = Object.fromEntries(PAPEIS_IDENTIDADE.map(papel => [
    papel.toLowerCase(), valores[chaveIdentidade(provedor, papel)] || null
  ]));
  const moeda = valores[chaveMoeda(provedor)] || null;
  return {
    provedor,
    moeda: MOEDAS_COMERCIO.includes(moeda) ? moeda : null,
    identidades,
    moeda_definida: MOEDAS_COMERCIO.includes(moeda),
    identidades_definidas: Object.values(identidades)
      .every(valor => ORIGENS_IDENTIDADE.includes(valor))
  };
}

module.exports = {
  MOEDAS_COMERCIO,
  ORIGENS_IDENTIDADE,
  PAPEIS_IDENTIDADE,
  PROVEDORES_COMERCIO,
  chaveIdentidade,
  chaveMoeda,
  obterPoliticaComercio
};
