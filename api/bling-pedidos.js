'use strict';

const crypto = require('crypto');
const { jsonCanonico } = require('./wbuy-pedidos');
const { obterAccessTokenBling, renovarOAuthBling } = require('./bling-oauth');

const API_URL = 'https://api.bling.com.br/Api/v3';

function falha(mensagem, codigo, status) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = status;
  return erro;
}

function pedidoIdValido(valor) {
  const id = String(valor ?? '').trim();
  return /^\d{1,18}$/.test(id) && !/^0+$/.test(id) ? BigInt(id).toString() : null;
}

async function requisitarPedido(config, id, accessToken, opcoes = {}) {
  const transporte = opcoes.transporteApi || global.fetch;
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), opcoes.timeoutMs || 10000);
  try {
    return await transporte(
      `${String(config.apiUrl || API_URL).replace(/\/+$/, '')}/pedidos/vendas/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'enable-jwt': '1',
          'User-Agent': 'CentralMyKey/1.0 (suporte@centralmykey.com.br)'
        },
        signal: controlador.signal
      }
    );
  } catch (erro) {
    throw falha(erro?.name === 'AbortError'
      ? 'Tempo limite ao consultar Bling' : 'Bling indisponível',
    erro?.name === 'AbortError' ? 'TIMEOUT_BLING' : 'BLING_INDISPONIVEL', 503);
  } finally {
    clearTimeout(temporizador);
  }
}

async function consultarPedidoBling(pool, config, pedidoExternoId, opcoes = {}) {
  const id = pedidoIdValido(pedidoExternoId);
  if (!id) throw falha('ID do pedido Bling inválido', 'PEDIDO_BLING_INVALIDO', 400);
  const oauth = {
    transporte: opcoes.transporteOAuth,
    timeoutMs: opcoes.timeoutMs,
    usuarioId: opcoes.usuarioId,
    ip: opcoes.ip
  };
  let accessToken = await obterAccessTokenBling(pool, config, oauth);
  let resposta = await requisitarPedido(config, id, accessToken, opcoes);
  if (resposta.status === 401) {
    await renovarOAuthBling(pool, config, oauth);
    accessToken = await obterAccessTokenBling(pool, config, oauth);
    resposta = await requisitarPedido(config, id, accessToken, opcoes);
  }
  if (resposta.status === 404) {
    throw falha('Pedido Bling não encontrado', 'PEDIDO_BLING_NAO_ENCONTRADO', 404);
  }
  if (resposta.status === 401) {
    throw falha('Reautorização Bling necessária', 'REAUTORIZACAO_BLING_NECESSARIA', 409);
  }
  if (resposta.status === 403) {
    throw falha('Escopo de pedidos Bling não autorizado',
      'ESCOPO_PEDIDOS_BLING_NAO_AUTORIZADO', 403);
  }
  if (resposta.status === 429 || resposta.status >= 500) {
    throw falha('Bling indisponível', 'BLING_INDISPONIVEL', 503);
  }
  if (!resposta.ok) {
    throw falha('Resposta inválida do Bling', 'RESPOSTA_BLING_INVALIDA', 502);
  }
  let corpo;
  try { corpo = await resposta.json(); } catch {
    throw falha('Resposta inválida do Bling', 'RESPOSTA_BLING_INVALIDA', 502);
  }
  const pedido = corpo?.data;
  if (!pedido || typeof pedido !== 'object' || Array.isArray(pedido) ||
      String(pedido.id ?? '') !== id) {
    throw falha('Resposta inválida do Bling', 'RESPOSTA_BLING_INVALIDA', 502);
  }
  return { id, pedido };
}

function resumirPedido(pedido) {
  return {
    pedido_externo_id: String(pedido.id),
    numero_externo: pedido.numero === undefined ? null : String(pedido.numero).slice(0, 80),
    situacao_externa_id: pedido.situacao?.id === undefined
      ? null : String(pedido.situacao.id).slice(0, 80),
    itens_total: Array.isArray(pedido.itens) ? pedido.itens.length : 0,
    possui_contato: Boolean(pedido.contato && typeof pedido.contato === 'object'),
    pronto_para_processar: false,
    bloqueios: ['MATRIZ_AUTORIDADE_PENDENTE', 'PROCESSADOR_BLING_DESABILITADO']
  };
}

function texto(valor, limite) {
  const resultado = String(valor ?? '').trim();
  return resultado ? resultado.slice(0, limite) : null;
}

async function analisarPedidoBling(connection, pedido) {
  const produtos = Array.isArray(pedido?.itens) ? pedido.itens : [];
  const [mapeamentos] = await connection.query(
    `SELECT m.produto_externo_id, m.sku, m.servico_id,
            s.codigo AS servico_codigo, s.nome AS servico_nome
       FROM integracao_produto_mapeamentos m
       JOIN servicos s ON s.id=m.servico_id
      WHERE m.provedor='BLING' AND m.ativo=1 AND s.ativo=1`
  );
  const [autoridades] = await connection.query(
    'SELECT dominio, autoridade FROM integracao_autoridades'
  );
  const statusExternoId = texto(pedido?.situacao?.id, 80);
  const [statusMapeados] = await connection.query(
    `SELECT situacao FROM integracao_status_mapeamentos
      WHERE provedor='BLING' AND dominio='PAGAMENTO'
        AND status_externo_id=? AND ativo=1 LIMIT 1`,
    [statusExternoId]
  );
  const situacaoPagamento = statusMapeados[0]?.situacao || null;
  const autoridadePorDominio = Object.fromEntries(
    autoridades.map(item => [item.dominio, item.autoridade])
  );
  const itens = produtos.map(produto => {
    const produtoExternoId = texto(produto?.produto?.id ?? produto?.id, 160);
    const sku = texto(produto?.codigo ?? produto?.produto?.codigo, 120)?.toUpperCase() || null;
    const candidatos = mapeamentos.filter(item =>
      (produtoExternoId && String(item.produto_externo_id || '') === produtoExternoId) ||
      (sku && String(item.sku || '').toUpperCase() === sku)
    );
    const servicos = [...new Set(candidatos.map(item => Number(item.servico_id)))];
    const situacao = servicos.length === 1 ? 'MAPEADO'
      : servicos.length > 1 ? 'CONFLITO' : 'NAO_MAPEADO';
    const mapeamento = situacao === 'MAPEADO'
      ? candidatos.find(item => Number(item.servico_id) === servicos[0]) : null;
    return {
      produto_externo_id: produtoExternoId,
      sku,
      quantidade: texto(produto?.quantidade, 30),
      situacao,
      servico_id: mapeamento ? Number(mapeamento.servico_id) : null,
      servico_codigo: mapeamento?.servico_codigo || null,
      servico_nome: mapeamento?.servico_nome || null
    };
  });
  const pendencias = ['MOEDA_NAO_INFORMADA'];
  if (!situacaoPagamento) pendencias.push('STATUS_PAGAMENTO_NAO_MAPEADO');
  else if (situacaoPagamento !== 'CONFIRMADO') {
    pendencias.push('PAGAMENTO_EXTERNO_NAO_CONFIRMADO');
  }
  if (!autoridadePorDominio.PEDIDO) pendencias.push('AUTORIDADE_PEDIDO_NAO_DEFINIDA');
  if (!autoridadePorDominio.PAGAMENTO) pendencias.push('AUTORIDADE_PAGAMENTO_NAO_DEFINIDA');
  if (['CLIENTE', 'COMPRADOR', 'PAGADOR'].some(
    dominio => !autoridadePorDominio[dominio]
  )) pendencias.push('PAPEIS_CLIENTE_COMPRADOR_PAGADOR_NAO_CONFIRMADOS');
  if (itens.some(item => item.situacao === 'NAO_MAPEADO')) {
    pendencias.push('PRODUTO_NAO_MAPEADO');
  }
  if (itens.some(item => item.situacao === 'CONFLITO')) {
    pendencias.push('MAPEAMENTO_CONFLITANTE');
  }
  return {
    pedido_externo_id: texto(pedido?.id, 120),
    numero_externo: texto(pedido?.numero, 80),
    status_externo: {
      id: statusExternoId,
      nome: texto(pedido?.situacao?.nome ?? pedido?.situacao?.valor, 160)
    },
    valor_total_externo: texto(pedido?.total, 40),
    produtos_total: itens.length,
    produtos_mapeados: itens.filter(item => item.situacao === 'MAPEADO').length,
    produtos_pendentes: itens.filter(item => item.situacao !== 'MAPEADO').length,
    itens,
    autoridades: {
      completa: ['PEDIDO', 'PAGAMENTO', 'CLIENTE', 'COMPRADOR', 'PAGADOR',
        'FISCAL', 'ESTOQUE'].every(dominio => Boolean(autoridadePorDominio[dominio])),
      dados: autoridadePorDominio
    },
    pagamento: { mapeado: Boolean(situacaoPagamento), situacao: situacaoPagamento },
    identidades: { contato_presente: Boolean(pedido?.contato) },
    pendencias,
    pronto_para_converter: false
  };
}

async function analisarSnapshotBling(pool, eventoId) {
  const id = Number(eventoId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw falha('Evento Bling inválido', 'EVENTO_BLING_INVALIDO', 400);
  }
  const [[evento]] = await pool.query(
    `SELECT id, referencia_externa, payload, status, recebido_em
       FROM integracao_eventos
      WHERE id=? AND provedor='BLING' AND tipo='ORDER.SNAPSHOT' LIMIT 1`,
    [id]
  );
  if (!evento) {
    throw falha('Snapshot Bling não encontrado', 'SNAPSHOT_BLING_NAO_ENCONTRADO', 404);
  }
  let pedido = evento.payload;
  if (Buffer.isBuffer(pedido)) pedido = pedido.toString('utf8');
  if (typeof pedido === 'string') {
    try { pedido = JSON.parse(pedido); } catch {
      throw falha('Snapshot Bling inválido', 'SNAPSHOT_BLING_INVALIDO', 422);
    }
  }
  if (!pedido || typeof pedido !== 'object' || Array.isArray(pedido) ||
      !Array.isArray(pedido.itens) || !pedido.situacao) {
    throw falha('Snapshot Bling inválido', 'SNAPSHOT_BLING_INVALIDO', 422);
  }
  return {
    ok: true,
    provedor: 'BLING',
    evento: { id: Number(evento.id), referencia_externa: evento.referencia_externa || null,
      status: evento.status, recebido_em: evento.recebido_em },
    analise: await analisarPedidoBling(pool, pedido)
  };
}

async function sincronizarPedidoBling(pool, config, pedidoExternoId, opcoes = {}) {
  const consulta = await consultarPedidoBling(pool, config, pedidoExternoId, opcoes);
  const payloadCanonico = jsonCanonico(consulta.pedido);
  const payloadHash = crypto.createHash('sha256').update(payloadCanonico).digest('hex');
  const eventoExternoId = `ORDER.SNAPSHOT:${consulta.id}:${payloadHash.slice(0, 32)}`;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [gravacao] = await connection.query(
      `INSERT INTO integracao_eventos
         (provedor, evento_externo_id, tipo, referencia_externa, entidade,
          payload_hash, payload, status)
       VALUES ('BLING', ?, 'ORDER.SNAPSHOT', ?, 'PEDIDO_EXTERNO', ?, ?, 'RECEBIDO')
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),
         tentativas=tentativas+1, atualizado_em=NOW()`,
      [eventoExternoId, consulta.id, payloadHash, JSON.stringify(consulta.pedido)]
    );
    const [[evento]] = await connection.query(
      `SELECT id, status, tentativas FROM integracao_eventos
        WHERE provedor='BLING' AND evento_externo_id=? LIMIT 1 FOR UPDATE`,
      [eventoExternoId]
    );
    const idempotente = gravacao.affectedRows !== 1;
    await connection.query(
      `INSERT INTO auditoria
         (usuario_id, modulo, acao, entidade, entidade_id, descricao,
          dados_antes, dados_depois, ip)
       VALUES (?, 'INTEGRACOES', 'SINCRONIZAR_PEDIDO_BLING',
               'integracao_eventos', ?, 'Snapshot de pedido Bling recebido',
               NULL, ?, ?)`,
      [opcoes.usuarioId || null, String(evento.id), JSON.stringify({
        pedido_externo_id: consulta.id,
        evento_id: Number(evento.id), status: evento.status, idempotente,
        itens: Array.isArray(consulta.pedido.itens) ? consulta.pedido.itens.length : 0
      }), opcoes.ip || null]
    );
    const analise = await analisarPedidoBling(connection, consulta.pedido);
    await connection.commit();
    return { ok: true, idempotente, evento_id: Number(evento.id),
      pedido_externo_id: consulta.id, status: evento.status,
      tentativas: Number(evento.tentativas), resumo: resumirPedido(consulta.pedido), analise };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally {
    connection.release();
  }
}

module.exports = {
  API_URL,
  analisarPedidoBling,
  analisarSnapshotBling,
  consultarPedidoBling,
  pedidoIdValido,
  resumirPedido,
  sincronizarPedidoBling
};
