'use strict';

const crypto = require('crypto');

function falha(mensagem, codigo, status = 400) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = status;
  return erro;
}

function assinaturaValida(corpoBruto, assinatura, segredo) {
  const recebida = String(assinatura || '').trim();
  if (!/^sha256=[a-f0-9]{64}$/i.test(recebida) || !segredo) return false;
  const esperada = `sha256=${crypto
    .createHmac('sha256', segredo)
    .update(corpoBruto)
    .digest('hex')}`;
  const a = Buffer.from(recebida.toLowerCase());
  const b = Buffer.from(esperada.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function prepararEventoBling(payload, corpoBruto) {
  const eventoId = String(payload?.eventId || '').trim();
  const evento = String(payload?.event || '').trim().toLowerCase();
  const versao = String(payload?.version || '').trim().toLowerCase();
  const empresaId = String(payload?.companyId ?? '').trim();
  const dados = payload?.data;
  if (!eventoId || eventoId.length > 160 || !/^[a-z0-9._:-]+$/i.test(eventoId)) {
    throw falha('Identificador do evento Bling inválido', 'EVENTO_BLING_INVALIDO');
  }
  const partes = evento.match(/^([a-z_]+)\.(created|updated|deleted)$/);
  if (!partes || !versao || versao.length > 20 || !empresaId || empresaId.length > 80 ||
      !dados || typeof dados !== 'object' || Array.isArray(dados)) {
    throw falha('Envelope do evento Bling inválido', 'EVENTO_BLING_INVALIDO');
  }
  const recurso = partes[1];
  const acao = partes[2];
  if (recurso === 'order' && (dados.id === undefined || dados.id === null)) {
    throw falha('Pedido ausente no evento Bling', 'EVENTO_BLING_INVALIDO');
  }
  const referencia = String(dados.numeroLoja ?? dados.id ?? empresaId).trim().slice(0, 120);
  const bruto = Buffer.isBuffer(corpoBruto) ? corpoBruto : Buffer.from(corpoBruto || '');
  return {
    eventoId,
    tipo: `${recurso}.${acao}`.toUpperCase(),
    referencia,
    recurso,
    acao,
    payload,
    payloadHash: crypto.createHash('sha256').update(bruto).digest('hex'),
    statusInicial: recurso === 'order' && versao === 'v1'
      ? 'RECEBIDO'
      : 'IGNORADO'
  };
}

async function receberEventoBling(pool, {
  payload,
  corpoBruto,
  assinatura,
  segredo
}) {
  if (!segredo) {
    throw falha('Webhook Bling não configurado', 'BLING_NAO_CONFIGURADO', 503);
  }
  if (!assinaturaValida(corpoBruto, assinatura, segredo)) {
    throw falha('Assinatura Bling inválida', 'ASSINATURA_BLING_INVALIDA', 401);
  }
  const evento = prepararEventoBling(payload, corpoBruto);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [gravacao] = await connection.query(
      `INSERT INTO integracao_eventos
         (provedor, evento_externo_id, tipo, referencia_externa,
          entidade, payload_hash, payload, status, processado_em)
       VALUES ('BLING', ?, ?, ?, 'PEDIDO_EXTERNO', ?, ?, ?,
               IF(? = 'IGNORADO', NOW(), NULL))
       ON DUPLICATE KEY UPDATE
         id = LAST_INSERT_ID(id), tentativas = tentativas + 1,
         atualizado_em = NOW()`,
      [
        evento.eventoId,
        evento.tipo,
        evento.referencia || null,
        evento.payloadHash,
        JSON.stringify(evento.payload),
        evento.statusInicial,
        evento.statusInicial
      ]
    );
    const [[persistido]] = await connection.query(
      `SELECT id, payload_hash, status, tentativas
         FROM integracao_eventos
        WHERE provedor = 'BLING' AND evento_externo_id = ?
        LIMIT 1 FOR UPDATE`,
      [evento.eventoId]
    );
    if (persistido.payload_hash !== evento.payloadHash) {
      throw falha(
        'Identificador Bling reutilizado com conteúdo diferente',
        'COLISAO_EVENTO_BLING',
        409
      );
    }
    const idempotente = gravacao.affectedRows !== 1;
    await connection.commit();
    return {
      ok: true,
      aceito: true,
      idempotente,
      evento_id: Number(persistido.id),
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
  assinaturaValida,
  prepararEventoBling,
  receberEventoBling
};
