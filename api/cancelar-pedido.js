'use strict';

function erroNegocio(codigo, mensagem) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  return erro;
}

async function cancelarPedido(connection, {
  pedidoId,
  usuarioId,
  motivo,
  ip = null
}) {
  const motivoNormalizado = String(motivo || '').trim();
  if (motivoNormalizado.length < 5 || motivoNormalizado.length > 500) {
    throw erroNegocio(
      'MOTIVO_CANCELAMENTO_INVALIDO',
      'Informe um motivo de cancelamento entre 5 e 500 caracteres'
    );
  }

  const [pedidos] = await connection.query(
    `SELECT
       p.id, p.protocolo, p.status, p.cliente_id, p.fornecedor_id,
       p.origem_id, p.custo, p.valor_venda, p.moeda
     FROM pedidos_senha p
     WHERE p.id = ?
     LIMIT 1
     FOR UPDATE`,
    [pedidoId]
  );
  if (!pedidos.length) {
    throw erroNegocio('PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado');
  }
  const pedido = pedidos[0];

  if (pedido.status === 'CANCELADO') {
    return {
      idempotente: true,
      pedido_id: pedido.id,
      protocolo: pedido.protocolo,
      status: 'CANCELADO'
    };
  }
  if (pedido.status === 'CONCLUIDO') {
    throw erroNegocio(
      'PEDIDO_JA_CONCLUIDO',
      'Pedido concluído exige fluxo específico de devolução'
    );
  }

  const [[financeiro]] = await connection.query(
    `SELECT
       SUM(
         lf.status IN ('RECEBIDO', 'PAGO')
         AND COALESCE(lf.origem, '') <> 'ESTORNO_MANUAL'
         AND NOT EXISTS (
           SELECT pg.lancamento_id
             FROM pagamentos pg
             INNER JOIN estornos_pagamentos ep
               ON ep.pagamento_id = pg.id
              AND ep.status = 'CONFIRMADO'
            WHERE pg.lancamento_id = lf.id
            GROUP BY pg.lancamento_id
           HAVING ROUND(SUM(ep.valor), 2) >= ROUND(lf.valor, 2)
         )
       ) AS liquidados_sem_estorno
     FROM lancamentos_financeiros lf
     WHERE lf.pedido_senha_id = ?
       AND lf.status <> 'CANCELADO'`,
    [pedido.id]
  );
  if (Number(financeiro.liquidados_sem_estorno || 0) > 0) {
    throw erroNegocio(
      'ESTORNO_FINANCEIRO_NECESSARIO',
      'O pedido possui pagamento e exige estorno antes do cancelamento'
    );
  }

  const [[comunicacaoExterna]] = await connection.query(
    `SELECT id, status
       FROM comunicacoes_outbox
      WHERE pedido_id = ?
        AND finalidade = 'CONSULTA_FORNECEDOR'
        AND status IN ('PROCESSANDO', 'ENVIADA', 'ENTREGUE', 'LIDA', 'INCERTA')
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE`,
    [pedido.id]
  );
  if (comunicacaoExterna) {
    throw erroNegocio(
      'CUSTO_FORNECEDOR_REQUER_DECISAO',
      'O fornecedor pode ter recebido a consulta; resolva o custo antes de cancelar'
    );
  }

  const [itensFatura] = await connection.query(
    `SELECT fi.id, fi.fatura_id, fi.valor, f.status AS fatura_status
       FROM fatura_itens fi
       INNER JOIN faturas_clientes f ON f.id = fi.fatura_id
      WHERE fi.pedido_senha_id = ?
      FOR UPDATE`,
    [pedido.id]
  );
  if (itensFatura.some(item => item.fatura_status !== 'ABERTA')) {
    throw erroNegocio(
      'FATURA_REQUER_AJUSTE',
      'O pedido está em fatura fechada ou paga e exige ajuste financeiro'
    );
  }

  const faturasAjustadas = [];
  for (const item of itensFatura) {
    await connection.query('DELETE FROM fatura_itens WHERE id = ?', [item.id]);
    await connection.query(
      `UPDATE faturas_clientes
          SET valor_total = GREATEST(valor_total - ?, 0),
              status = CASE
                WHEN NOT EXISTS (
                  SELECT 1 FROM fatura_itens fi WHERE fi.fatura_id = ?
                ) THEN 'CANCELADA'
                ELSE status
              END
        WHERE id = ?`,
      [Number(item.valor), item.fatura_id, item.fatura_id]
    );
    faturasAjustadas.push(Number(item.fatura_id));
  }

  await connection.query(
    `UPDATE comunicacoes_outbox
        SET status = 'CANCELADA',
            erro_codigo = 'PEDIDO_CANCELADO',
            erro_detalhe = 'Comunicação cancelada junto com o pedido'
      WHERE pedido_id = ?
        AND status IN ('PENDENTE', 'FALHOU')`,
    [pedido.id]
  );
  await connection.query(
    `UPDATE lancamentos_financeiros
        SET status = 'CANCELADO'
      WHERE pedido_senha_id = ?
        AND COALESCE(origem, '') <> 'ESTORNO_MANUAL'
        AND status IN ('PREVISTO', 'PENDENTE', 'VENCIDO')`,
    [pedido.id]
  );
  await connection.query(
    `UPDATE pedidos_senha
        SET status = 'CANCELADO', custo = 0,
            fornecedor_id = NULL, origem_id = NULL, concluido_em = NULL
      WHERE id = ?`,
    [pedido.id]
  );

  const dadosDepois = {
    status: 'CANCELADO',
    custo: 0,
    fornecedor_id: null,
    origem_id: null,
    motivo: motivoNormalizado,
    faturas_ajustadas: faturasAjustadas
  };
  await connection.query(
    `INSERT INTO pedido_historico
       (pedido_id, usuario_id, tipo, descricao, dados)
     VALUES (?, ?, 'PEDIDO_CANCELADO', ?, ?)`,
    [
      pedido.id,
      usuarioId,
      motivoNormalizado,
      JSON.stringify({
        status_anterior: pedido.status,
        ...dadosDepois
      })
    ]
  );
  await connection.query(
    `INSERT INTO auditoria
       (usuario_id, modulo, acao, entidade, entidade_id,
        descricao, dados_antes, dados_depois, ip)
     VALUES (?, 'PEDIDOS_SENHAS', 'CANCELAR', 'pedidos_senha', ?, ?, ?, ?, ?)`,
    [
      usuarioId,
      String(pedido.id),
      `Pedido ${pedido.protocolo} cancelado`,
      JSON.stringify({
        status: pedido.status,
        custo: Number(pedido.custo || 0),
        fornecedor_id: pedido.fornecedor_id,
        origem_id: pedido.origem_id
      }),
      JSON.stringify(dadosDepois),
      ip
    ]
  );

  return {
    idempotente: false,
    pedido_id: pedido.id,
    protocolo: pedido.protocolo,
    status: 'CANCELADO',
    faturas_ajustadas: faturasAjustadas
  };
}

module.exports = { cancelarPedido };
