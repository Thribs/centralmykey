'use strict';

const {
  obterConfiguracaoApiJoelPires
} = require('./config-api-joelpires');
const { normalizarChassi } = require('./consulta-banco-senhas');

const FONTE_CACHE = 'API_JOELPIRES';

const MONTADORAS_PADRAO = Object.freeze({
  GM: 1,
  CHEVROLET: 1,
  KIA: 2,
  HYUNDAI: 2,
  'KIA E HYUNDAI': 2,
  PEUGEOT: 3,
  CITROEN: 3,
  'CITROËN': 3,
  'PEUGEOT E CITROEN': 3,
  FIAT: 4,
  NISSAN: 5,
  JEEP: 6,
  CHRYSLER: 6,
  DODGE: 6,
  'CHRYSLER DODGE E JEEP': 6
});

function normalizarTexto(valor) {
  return String(valor || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/gi, ' ')
    .trim()
    .toUpperCase();
}

function obterMapaMontadoras() {
  const configurado = process.env.MAPA_MONTADORAS_API_JOELPIRES;
  if (!configurado) return MONTADORAS_PADRAO;

  let mapa;
  try {
    mapa = JSON.parse(configurado);
  } catch {
    throw new Error('MAPA_MONTADORAS_API_JOELPIRES deve ser JSON valido');
  }

  return Object.fromEntries(
    Object.entries(mapa).map(([nome, id]) => [normalizarTexto(nome), Number(id)])
  );
}

function obterMontadoraId({ marca, montadoraId }) {
  if (Number.isInteger(Number(montadoraId)) && Number(montadoraId) > 0) {
    return Number(montadoraId);
  }

  const id = obterMapaMontadoras()[normalizarTexto(marca)];
  return Number.isInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
}

function valor(objeto, nomes) {
  for (const nome of nomes) {
    if (objeto[nome] !== undefined && objeto[nome] !== null) return objeto[nome];
  }
  return null;
}

function limparCodigo(codigo) {
  if (codigo === undefined || codigo === null) return null;
  const texto = String(codigo).trim();
  return texto || null;
}

function mapearSenhaApi(item, contexto) {
  const chassiResposta = normalizarChassi(
    valor(item, ['chassis', 'chassi']) || contexto.chassi
  );
  const chassiSolicitado = normalizarChassi(contexto.chassi);
  const chassi = chassiSolicitado.length > chassiResposta.length
    ? chassiSolicitado
    : chassiResposta;

  return {
    api_senha_id: valor(item, ['id', 'id_senha']),
    montadora_id: Number(
      valor(item, ['id_montadora', 'montadora_id', 'montadoraId']) || contexto.montadoraId
    ),
    tipo: contexto.codigoServico,
    marca: contexto.marca || null,
    modelo: limparCodigo(valor(item, ['modelo'])) || contexto.modelo || null,
    chassi,
    codigo_mecanico: limparCodigo(valor(item, ['cod_mecanico', 'codigo_mecanico', 'codMecanico'])),
    codigo_radio: limparCodigo(valor(item, ['cod_radio', 'codigo_radio', 'codRadio'])),
    codigo_imobilizador: limparCodigo(
      valor(item, ['cod_immo', 'codigo_imobilizador', 'codigo_immo', 'codImmo'])
    ),
    codigo_alarme: limparCodigo(valor(item, ['cod_alarme', 'codigo_alarme', 'codAlarme'])),
    pin: limparCodigo(valor(item, ['pin', 'cod_pin'])),
    dados_api: item,
    atualizado_api_em: valor(item, ['updated_at', 'atualizado_em', 'updatedAt'])
  };
}

function assinatura(senha) {
  return [
    senha.codigo_mecanico,
    senha.codigo_radio,
    senha.codigo_imobilizador,
    senha.codigo_alarme,
    senha.pin
  ].map(item => normalizarTexto(item)).join('|');
}

async function chamarBuscaApi({ montadoraId, chassi, fetchImpl = global.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponivel');

  const configuracao = obterConfiguracaoApiJoelPires();
  const chassiConsulta = montadoraId === 1
    ? normalizarChassi(chassi).slice(-8)
    : normalizarChassi(chassi);
  const parametros = new URLSearchParams({
    montadora_id: String(montadoraId),
    chassi: chassiConsulta,
    user_id: String(configuracao.idUsuario)
  });
  const controlador = new AbortController();
  const timeout = setTimeout(() => controlador.abort(), configuracao.timeoutMs);

  try {
    const resposta = await fetchImpl(
      `${configuracao.urlBase}/senhas/busca/?${parametros.toString()}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'chave-api': configuracao.chave,
          'id-dispositivo-mykey': configuracao.idDispositivo,
          'x-app-version': configuracao.versaoApp,
          'versao-app-mykey': configuracao.versaoApp
        },
        signal: controlador.signal
      }
    );
    const texto = await resposta.text();
    let corpo;
    try {
      corpo = texto ? JSON.parse(texto) : null;
    } catch {
      corpo = texto;
    }

    if (!resposta.ok) {
      const erro = new Error(`API Joel Pires respondeu HTTP ${resposta.status}`);
      erro.codigo = 'API_JOELPIRES_HTTP';
      erro.httpStatus = resposta.status;
      erro.resposta = corpo;
      throw erro;
    }
    if (!Array.isArray(corpo)) {
      const erro = new Error('API Joel Pires retornou formato inesperado');
      erro.codigo = 'API_JOELPIRES_FORMATO';
      throw erro;
    }
    return corpo;
  } catch (erro) {
    if (!erro.codigo) erro.codigo = 'API_JOELPIRES_COMUNICACAO';
    throw erro;
  } finally {
    clearTimeout(timeout);
  }
}

async function buscarCache(connection, contexto, { permitirVencido = false } = {}) {
  const ttlSegundos = Math.max(0, Number(
    process.env.CACHE_SENHAS_JOELPIRES_TTL_SEGUNDOS || 3600
  ));
  const chassi = normalizarChassi(contexto.chassi);
  const final8 = chassi.slice(-8);
  const parametros = [
    FONTE_CACHE,
    contexto.codigoServico,
    contexto.montadoraId
  ];
  let filtroChassi;

  if (contexto.montadoraId === 1) {
    filtroChassi = 'RIGHT(UPPER(TRIM(bs.chassi)), 8) = ?';
    parametros.push(final8);
  } else {
    filtroChassi = 'UPPER(TRIM(bs.chassi)) = ?';
    parametros.push(chassi);
  }

  if (!permitirVencido) parametros.push(ttlSegundos);

  const [linhas] = await connection.query(
    `SELECT
       bs.id, bs.tipo, bs.marca, bs.modelo, bs.chassi, bs.origem_id,
       bs.fornecedor_id, bs.confiabilidade, bs.codigo_mecanico,
       bs.codigo_imobilizador, bs.codigo_radio, bs.codigo_alarme,
       bs.pin, bs.dados_extras, bs.atualizado_em
     FROM banco_senhas bs
     WHERE JSON_UNQUOTE(JSON_EXTRACT(bs.dados_extras, '$.fonte')) = ?
       AND bs.tipo = ?
       AND CAST(JSON_UNQUOTE(JSON_EXTRACT(bs.dados_extras, '$.montadora_id')) AS UNSIGNED) = ?
       AND ${filtroChassi}
       AND bs.ativo = 1
       ${permitirVencido ? '' : 'AND bs.atualizado_em >= DATE_SUB(NOW(), INTERVAL ? SECOND)'}
     ORDER BY bs.atualizado_em DESC, bs.id DESC
     LIMIT 1`,
    parametros
  );

  return linhas[0] || null;
}

async function salvarCache(connection, senha) {
  const dadosExtras = {
    fonte: FONTE_CACHE,
    api_senha_id: senha.api_senha_id,
    montadora_id: senha.montadora_id,
    atualizado_api_em: senha.atualizado_api_em,
    consultado_em: new Date().toISOString(),
    resposta: senha.dados_api
  };
  const [existentes] = await connection.query(
    `SELECT id FROM banco_senhas
     WHERE JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.fonte')) = ?
       AND JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.api_senha_id')) = ?
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [FONTE_CACHE, String(senha.api_senha_id)]
  );

  if (existentes.length) {
    await connection.query(
      `UPDATE banco_senhas SET
         tipo=?, marca=?, modelo=?, chassi=?, codigo_mecanico=?,
         codigo_radio=?, codigo_imobilizador=?, codigo_alarme=?, pin=?,
         dados_extras=?, origem_id=3, fornecedor_id=NULL,
         confiabilidade='CONFIRMADA', ativo=1, atualizado_em=NOW()
       WHERE id=?`,
      [senha.tipo, senha.marca, senha.modelo, senha.chassi,
       senha.codigo_mecanico, senha.codigo_radio, senha.codigo_imobilizador,
       senha.codigo_alarme, senha.pin, JSON.stringify(dadosExtras), existentes[0].id]
    );
    return existentes[0].id;
  }

  const [resultado] = await connection.query(
    `INSERT INTO banco_senhas
     (tipo,marca,modelo,chassi,codigo_mecanico,codigo_radio,
      codigo_imobilizador,codigo_alarme,pin,dados_extras,origem_id,
      fornecedor_id,confiabilidade,ativo)
     VALUES (?,?,?,?,?,?,?,?,?,?,3,NULL,'CONFIRMADA',1)`,
    [senha.tipo, senha.marca, senha.modelo, senha.chassi,
     senha.codigo_mecanico, senha.codigo_radio, senha.codigo_imobilizador,
     senha.codigo_alarme, senha.pin, JSON.stringify(dadosExtras)]
  );
  return resultado.insertId;
}

function formatarCache(cache, origemCache) {
  return {
    status: 'ENCONTRADO',
    origem: origemCache,
    final8: normalizarChassi(cache.chassi).slice(-8),
    senha: cache
  };
}

async function buscarSenhaFonteVerdade(connection, entrada, opcoes = {}) {
  const chassi = normalizarChassi(entrada.chassi);
  const codigoServico = normalizarTexto(entrada.codigoServico).replace(/ /g, '_');
  const montadoraId = obterMontadoraId(entrada);
  if (!montadoraId) {
    return { status: 'MONTADORA_NAO_CONFIGURADA' };
  }
  const contexto = {
    chassi,
    codigoServico,
    montadoraId,
    marca: entrada.marca,
    modelo: entrada.modelo
  };
  const cache = await buscarCache(connection, contexto);
  if (cache) return formatarCache(cache, 'CACHE_JOELPIRES');

  try {
    const itens = await chamarBuscaApi({ montadoraId, chassi, fetchImpl: opcoes.fetchImpl });
    if (!itens.length) return { status: 'NAO_ENCONTRADO', montadoraId };

    const senhas = itens.map(item => mapearSenhaApi(item, contexto));
    const assinaturas = new Set(senhas.map(assinatura));
    if (assinaturas.size > 1) {
      return {
        status: 'CONFLITO',
        origem: 'API_JOELPIRES',
        montadoraId,
        api_senha_ids: senhas.map(item => item.api_senha_id)
      };
    }
    const senha = senhas[0];
    senha.id = await salvarCache(connection, senha);
    senha.origem_id = 3;
    senha.fornecedor_id = null;
    senha.confiabilidade = 'CONFIRMADA';
    return {
      status: 'ENCONTRADO',
      origem: 'API_JOELPIRES',
      final8: senha.chassi.slice(-8),
      senha
    };
  } catch (erro) {
    const cacheVencido = await buscarCache(connection, contexto, { permitirVencido: true });
    if (cacheVencido) {
      return {
        ...formatarCache(cacheVencido, 'CACHE_JOELPIRES_CONTINGENCIA'),
        contingencia: true,
        erro_api: erro.codigo
      };
    }
    return {
      status: 'INDISPONIVEL',
      origem: 'API_JOELPIRES',
      erro: erro.codigo,
      mensagem: erro.message
    };
  }
}

module.exports = {
  FONTE_CACHE,
  buscarSenhaFonteVerdade,
  chamarBuscaApi,
  mapearSenhaApi,
  obterMontadoraId
};
