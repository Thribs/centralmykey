'use strict';

const { consultarCobranca } = require('./cliente-sicoob-pix');
const { processarWebhookSicoob } = require('./sicoob-pix');
const {
  buscarAtendimentoAutomaticoDoPedido,
  encaminharHumano,
  sincronizarAtendimentoAposPagamento
} = require('./automacao-gm-whatsapp');

const NOME_BLOQUEIO = 'central_mykey_pagamentos_sicoob';

async function encaminharFalhaConfirmada(pool, pedidoId, codigo, detalhe) {
  const atendimentoId = await buscarAtendimentoAutomaticoDoPedido(pool, pedidoId);
  if (atendimentoId) {
    await encaminharHumano(pool, atendimentoId, codigo, detalhe);
  }
}

async function reconciliarPagamentosSicoob(pool, config, opcoes = {}) {
  if (!config?.consultaHabilitada) {
    return { executado: false, motivo: 'DESABILITADA' };
  }
  const limite = Math.min(Math.max(Number(opcoes.limite) || 50, 1), 200);
  const consultar = opcoes.consultarCobranca || consultarCobranca;
  const sincronizar = opcoes.sincronizarAtendimento ||
    sincronizarAtendimentoAposPagamento;
  const connection = await pool.getConnection();
  let bloqueio = false;
  try {
    const [[resultadoBloqueio]] = await connection.query(
      'SELECT GET_LOCK(?, 0) AS adquirido', [NOME_BLOQUEIO]
    );
    bloqueio = Number(resultadoBloqueio?.adquirido) === 1;
    if (!bloqueio) return { executado: false, motivo: 'EM_EXECUCAO' };

    const [referencias] = await connection.query(
      `SELECT r.id, r.entidade_id AS pedido_id,
              r.referencia_provedor AS txid
         FROM integracao_referencias_pagamento r
         INNER JOIN pedidos_senha p ON p.id=r.entidade_id
        WHERE r.provedor='SICOOB' AND r.entidade='PEDIDO'
          AND r.status='REGISTRADA'
          AND p.status='AGUARDANDO_PAGAMENTO'
          AND TIMESTAMPADD(SECOND, COALESCE(r.expiracao_segundos, 3600),
                r.criada_em) > NOW()
        ORDER BY r.id
        LIMIT ?`,
      [limite]
    );

    let pagas = 0;
    let pendentes = 0;
    let falhas = 0;
    for (const referencia of referencias) {
      try {
        const cobranca = await consultar(config, referencia.txid);
        if (String(cobranca.status || '').toUpperCase() !== 'CONCLUIDA') {
          pendentes += 1;
          continue;
        }
        if (!Array.isArray(cobranca.pix) || cobranca.pix.length === 0 ||
            cobranca.pix.some(item =>
              String(item?.txid || '').trim() !== referencia.txid)) {
          falhas += 1;
          continue;
        }
        const resultado = await processarWebhookSicoob(
          pool,
          JSON.stringify({ pix: cobranca.pix }),
          { origem: 'CONSULTA_COBRANCA_SICOOB' }
        );
        if (!resultado.ok) {
          await encaminharFalhaConfirmada(
            pool,
            Number(referencia.pedido_id),
            'PAGAMENTO_SICOOB_DIVERGENTE',
            'O recebimento Pix exige conferência manual'
          );
          falhas += 1;
          continue;
        }
        pagas += 1;
        try {
          await sincronizar(pool, Number(referencia.pedido_id));
        } catch {
          await encaminharFalhaConfirmada(
            pool,
            Number(referencia.pedido_id),
            'FALHA_APOS_PAGAMENTO_SICOOB',
            'O pagamento foi confirmado e a continuação exige atendimento humano'
          );
          falhas += 1;
        }
      } catch {
        // Uma indisponibilidade externa não altera a cobrança nem o pedido.
        // O ciclo seguinte fará uma nova consulta segura pelo mesmo txid.
        falhas += 1;
      }
    }
    return {
      executado: true,
      analisadas: referencias.length,
      pagas,
      pendentes,
      falhas
    };
  } finally {
    if (bloqueio) {
      await connection.query('SELECT RELEASE_LOCK(?)', [NOME_BLOQUEIO])
        .catch(() => {});
    }
    connection.release();
  }
}

module.exports = { NOME_BLOQUEIO, reconciliarPagamentosSicoob };
