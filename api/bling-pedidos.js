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
    await connection.commit();
    return { ok: true, idempotente, evento_id: Number(evento.id),
      pedido_externo_id: consulta.id, status: evento.status,
      tentativas: Number(evento.tentativas), resumo: resumirPedido(consulta.pedido) };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally {
    connection.release();
  }
}

module.exports = {
  API_URL,
  consultarPedidoBling,
  pedidoIdValido,
  resumirPedido,
  sincronizarPedidoBling
};
