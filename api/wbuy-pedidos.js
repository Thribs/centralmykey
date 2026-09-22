'use strict';

const crypto = require('crypto');

function falha(mensagem, codigo, status) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = status;
  return erro;
}

function pedidoIdValido(valor) {
  const id = String(valor ?? '').trim();
  return /^\d{1,18}$/.test(id) && !/^0+$/.test(id) ? id : null;
}

function jsonCanonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  if (valor && typeof valor === 'object') {
    return `{${Object.keys(valor).sort().map(chave =>
      `${JSON.stringify(chave)}:${jsonCanonico(valor[chave])}`).join(',')}}`;
  }
  return JSON.stringify(valor);
}

async function consultarPedidoWBuy(config, pedidoExternoId, opcoes = {}) {
  const id = pedidoIdValido(pedidoExternoId);
  if (!id) throw falha('ID do pedido WBuy inválido', 'PEDIDO_WBUY_INVALIDO', 400);
  if (!config?.usuario || !config?.senha) {
    throw falha('Integração WBuy não configurada', 'WBUY_NAO_CONFIGURADO', 503);
  }
  const transporte = opcoes.transporte || global.fetch;
  const controlador = new AbortController();
  const timeoutMs = Number(opcoes.timeoutMs) || 15000;
  const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
  const apiUrl = String(config.apiUrl || '').replace(/\/+$/, '');
  const url = `${apiUrl}/order/${encodeURIComponent(id)}`;
  let resposta;
  try {
    resposta = await transporte(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${Buffer.from(`${config.usuario}:${config.senha}`).toString('base64')}`,
        'User-Agent': 'CentralMyKey/1.0 (suporte@centralmykey.com.br)'
      },
      signal: controlador.signal
    });
  } catch (erro) {
    if (erro?.name === 'AbortError') {
      throw falha('Tempo limite ao consultar WBuy', 'TIMEOUT_WBUY', 504);
    }
    throw falha('WBuy indisponível', 'WBUY_INDISPONIVEL', 503);
  } finally {
    clearTimeout(temporizador);
  }
  if (resposta.status === 404) {
    throw falha('Pedido WBuy não encontrado', 'PEDIDO_WBUY_NAO_ENCONTRADO', 404);
  }
  if (resposta.status === 401 || resposta.status === 403) {
    throw falha('Credenciais WBuy recusadas', 'AUTENTICACAO_WBUY_RECUSADA', 502);
  }
  if (resposta.status === 429 || resposta.status >= 500) {
    throw falha('WBuy indisponível', 'WBUY_INDISPONIVEL', 503);
  }
  if (!resposta.ok) {
    throw falha('Resposta inválida da WBuy', 'RESPOSTA_WBUY_INVALIDA', 502);
  }
  let envelope;
  try {
    envelope = await resposta.json();
  } catch {
    throw falha('Resposta inválida da WBuy', 'RESPOSTA_WBUY_INVALIDA', 502);
  }
  const pedidos = Array.isArray(envelope?.data) ? envelope.data : [];
  const pedido = pedidos.find(item => String(item?.id ?? '') === id) || null;
  if (!pedido) {
    throw falha('Pedido WBuy não encontrado', 'PEDIDO_WBUY_NAO_ENCONTRADO', 404);
  }
  if (!Array.isArray(pedido.produtos) || !pedido.status || !pedido.cliente) {
    throw falha('Pedido WBuy incompleto', 'RESPOSTA_WBUY_INVALIDA', 502);
  }
  return { id, pedido };
}

async function sincronizarPedidoWBuy(pool, config, pedidoExternoId, opcoes = {}) {
  const consulta = await consultarPedidoWBuy(config, pedidoExternoId, opcoes);
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
       VALUES ('WBUY', ?, 'ORDER.SNAPSHOT', ?, 'PEDIDO_EXTERNO', ?, ?, 'RECEBIDO')
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),
         tentativas=tentativas+1, atualizado_em=NOW()`,
      [eventoExternoId, consulta.id, payloadHash, JSON.stringify(consulta.pedido)]
    );
    const [[persistido]] = await connection.query(
      `SELECT id, status, tentativas FROM integracao_eventos
        WHERE provedor='WBUY' AND evento_externo_id=? LIMIT 1 FOR UPDATE`,
      [eventoExternoId]
    );
    const idempotente = gravacao.affectedRows !== 1;
    await connection.query(
      `INSERT INTO auditoria
         (usuario_id, modulo, acao, entidade, entidade_id, descricao,
          dados_antes, dados_depois, ip)
       VALUES (?, 'INTEGRACOES', 'SINCRONIZAR_PEDIDO_WBUY',
               'integracao_eventos', ?, 'Snapshot de pedido WBuy recebido',
               NULL, ?, ?)`,
      [opcoes.usuarioId || null, String(persistido.id), JSON.stringify({
        pedido_externo_id: consulta.id,
        evento_id: Number(persistido.id),
        status: persistido.status,
        idempotente,
        produtos: consulta.pedido.produtos.length
      }), opcoes.ip || null]
    );
    await connection.commit();
    return {
      ok: true,
      idempotente,
      evento_id: Number(persistido.id),
      pedido_externo_id: consulta.id,
      status: persistido.status,
      tentativas: Number(persistido.tentativas)
    };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally {
    connection.release();
  }
}

module.exports = {
  consultarPedidoWBuy,
  jsonCanonico,
  pedidoIdValido,
  sincronizarPedidoWBuy
};
