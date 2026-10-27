'use strict';

const crypto = require('crypto');
const {
  processarEventoPagamentoPedido
} = require('./processar-evento-pagamento');
const {
  sincronizarAtendimentoAposPagamento
} = require('./automacao-gm-whatsapp');

function falha(mensagem, codigo, status = 400) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = status;
  return erro;
}

function compararSeguro(recebido, esperado) {
  const a = Buffer.from(String(recebido || ''));
  const b = Buffer.from(String(esperado || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function autenticacaoWebhookValida(req, segredo) {
  const valor = String(segredo || '').trim();
  if (!valor) return false;
  const candidatos = [
    req.get('authorization'),
    req.get('x-webhook-token'),
    req.get('x-api-key')
  ].filter(Boolean);
  return candidatos.some(recebido =>
    compararSeguro(recebido, valor) ||
    compararSeguro(recebido, `Bearer ${valor}`)
  );
}

function normalizarDocumento(valor) {
  return String(valor || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

async function receberWebhookPlugPay(pool, payload, config, opcoes = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw falha('Payload PlugPay inválido', 'PLUGPAY_PAYLOAD_INVALIDO');
  }
  const status = Number(payload.status ?? payload.Status);
  if (!Number.isInteger(status)) {
    throw falha('Status PlugPay inválido', 'PLUGPAY_STATUS_INVALIDO');
  }
  if (status !== 1) {
    return { ok: true, aceito: true, processado: false, status_externo: status };
  }
  const documentoRecebido = normalizarDocumento(payload.documentMerchant);
  const documentoEsperado = normalizarDocumento(config.documentMerchant);
  if (documentoRecebido && documentoEsperado &&
      documentoRecebido !== documentoEsperado) {
    throw falha('Merchant PlugPay divergente', 'PLUGPAY_MERCHANT_DIVERGENTE', 401);
  }
  const referencia = String(payload.referenciaInterna || '').trim();
  const eventoId = String(payload.transactionCode || payload.IdTransacao || '').trim();
  const valor = payload.valueBRL ?? payload.value;
  const moeda = payload.valueBRL !== undefined
    ? 'BRL' : String(payload.currency || 'BRL').toUpperCase();
  if (!referencia || !eventoId || !Number.isFinite(Number(valor))) {
    throw falha('Confirmação PlugPay incompleta', 'PLUGPAY_EVENTO_INVALIDO');
  }
  const [[referenciaLocal]] = await pool.query(
    `SELECT entidade_id AS pedido_id
       FROM integracao_referencias_pagamento
      WHERE provedor='PLUGPAY' AND entidade='PEDIDO'
        AND referencia_provedor=? LIMIT 1`,
    [referencia]
  );
  if (!referenciaLocal) {
    throw falha('Referência PlugPay desconhecida',
      'PLUGPAY_REFERENCIA_DESCONHECIDA', 404);
  }
  const processarEvento = opcoes.processarEvento || processarEventoPagamentoPedido;
  const resultado = await processarEvento(pool, {
    provedor: 'PLUGPAY', evento_id: eventoId, tipo: 'PIX_APROVADO',
    referencia, pedido_id: Number(referenciaLocal.pedido_id),
    valor: Number(valor), moeda, payload
  });
  if (resultado.ok) {
    await pool.query(
      `UPDATE integracao_referencias_pagamento
          SET status='PAGA', identificador_pagamento=?,
              paga_em=COALESCE(paga_em,NOW())
        WHERE provedor='PLUGPAY' AND referencia_provedor=?
          AND status='REGISTRADA'`,
      [eventoId, referencia]
    );
    const sincronizar = opcoes.sincronizarAtendimento ||
      sincronizarAtendimentoAposPagamento;
    await sincronizar(pool, Number(referenciaLocal.pedido_id));
  }
  return { ...resultado, aceito: true, pedido_id: Number(referenciaLocal.pedido_id) };
}

module.exports = {
  autenticacaoWebhookValida,
  receberWebhookPlugPay
};
