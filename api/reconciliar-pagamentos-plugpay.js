'use strict';

const { consultarPix } = require('./cliente-plugpay');
const { processarEventoPagamentoPedido } = require('./processar-evento-pagamento');
const { sincronizarAtendimentoAposPagamento } = require('./automacao-gm-whatsapp');

const NOME_BLOQUEIO = 'central_mykey_pagamentos_plugpay';

function centavos(valor) { return Math.round(Number(valor) * 100); }

async function reconciliarPagamentosPlugPay(pool, config, opcoes = {}) {
  if (!config?.consultaHabilitada) return { executado: false, motivo: 'DESABILITADA' };
  const consultar = opcoes.consultarPix || consultarPix;
  const sincronizar = opcoes.sincronizarAtendimento || sincronizarAtendimentoAposPagamento;
  const processarEvento = opcoes.processarEvento || processarEventoPagamentoPedido;
  const conexao = await pool.getConnection();
  let bloqueio = false;
  try {
    const [[trava]] = await conexao.query('SELECT GET_LOCK(?,0) AS adquirido', [NOME_BLOQUEIO]);
    bloqueio = Number(trava?.adquirido) === 1;
    if (!bloqueio) return { executado: false, motivo: 'EM_EXECUCAO' };
    const [referencias] = await conexao.query(
      `SELECT r.id, r.entidade_id AS pedido_id, r.referencia_provedor AS referencia,
              r.valor, r.moeda
         FROM integracao_referencias_pagamento r
         JOIN pedidos_senha p ON p.id=r.entidade_id
        WHERE r.provedor='PLUGPAY' AND r.entidade='PEDIDO' AND r.status='REGISTRADA'
          AND p.status='AGUARDANDO_PAGAMENTO' ORDER BY r.id LIMIT ?`,
      [Math.min(Math.max(Number(opcoes.limite) || 50, 1), 200)]);
    let pagas = 0; let pendentes = 0; let falhas = 0;
    for (const ref of referencias) {
      try {
        const remoto = await consultar(config, ref.referencia, opcoes.transporte);
        if (Number(remoto.status) !== 1) { pendentes += 1; continue; }
        const valor = remoto.valueBRL ?? remoto.value;
        const moeda = String(remoto.currency || 'BRL').toUpperCase();
        if (!Number.isFinite(Number(valor)) || centavos(valor) !== centavos(ref.valor) ||
            moeda !== ref.moeda) { falhas += 1; continue; }
        const eventoId = String(remoto.transactionCode || remoto.IdTransacao ||
          `PIX-${ref.referencia}`);
        const resultado = await processarEvento(pool, {
          provedor: 'PLUGPAY', evento_id: eventoId, tipo: 'PIX_APROVADO',
          referencia: ref.referencia, pedido_id: Number(ref.pedido_id),
          valor: Number(valor), moeda, payload: remoto
        });
        if (!resultado.ok) { falhas += 1; continue; }
        await pool.query(
          `UPDATE integracao_referencias_pagamento SET status='PAGA',
              identificador_pagamento=?, paga_em=COALESCE(paga_em,NOW())
            WHERE id=? AND status='REGISTRADA'`, [eventoId, ref.id]);
        await sincronizar(pool, Number(ref.pedido_id));
        pagas += 1;
      } catch { falhas += 1; }
    }
    return { executado: true, analisadas: referencias.length, pagas, pendentes, falhas };
  } finally {
    if (bloqueio) await conexao.query('SELECT RELEASE_LOCK(?)', [NOME_BLOQUEIO]).catch(() => {});
    conexao.release();
  }
}

module.exports = { NOME_BLOQUEIO, reconciliarPagamentosPlugPay };
