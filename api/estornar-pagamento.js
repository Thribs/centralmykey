'use strict';

function erroNegocio(codigo, mensagem, statusHttp = 409) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.statusHttp = statusHttp;
  return erro;
}

function normalizarDados(dados = {}) {
  const meio = String(dados.meio_estorno || '').trim().toUpperCase();
  const referencia = dados.referencia_externa
    ? String(dados.referencia_externa).trim()
    : null;
  const comprovante = dados.comprovante_url
    ? String(dados.comprovante_url).trim()
    : null;
  const motivo = String(dados.motivo_estorno || dados.motivo || '').trim();
  const meios = [
    'PIX', 'SICOOB', 'PLUGPAY', 'WBUY', 'CARTAO',
    'DINHEIRO', 'TRANSFERENCIA', 'OUTRO'
  ];
  if (!meios.includes(meio)) {
    throw erroNegocio(
      'MEIO_ESTORNO_INVALIDO',
      'Meio de estorno inválido',
      400
    );
  }
  if (meio !== 'DINHEIRO' && !referencia && !comprovante) {
    throw erroNegocio(
      'COMPROVANTE_ESTORNO_OBRIGATORIO',
      'Informe a referência ou o comprovante do estorno',
      400
    );
  }
  if (referencia && referencia.length > 120) {
    throw erroNegocio(
      'REFERENCIA_ESTORNO_INVALIDA',
      'Referência do estorno muito longa',
      400
    );
  }
  if (motivo.length < 5 || motivo.length > 500) {
    throw erroNegocio(
      'MOTIVO_ESTORNO_INVALIDO',
      'Informe um motivo de estorno entre 5 e 500 caracteres',
      400
    );
  }
  return { meio, referencia, comprovante, motivo };
}

async function resolverEventosDoPagamento(connection, pagamentoId) {
  const [resultado] = await connection.query(
    `UPDATE integracao_eventos
        SET status='IGNORADO',
            erro_codigo='PAGAMENTO_ESTORNADO',
            erro_detalhe='Pagamento recebido após cancelamento foi estornado',
            processado_em=NOW()
      WHERE pagamento_id=?
        AND status='FALHOU'
        AND erro_codigo='PAGAMENTO_APOS_CANCELAMENTO_REQUER_ESTORNO'`,
    [pagamentoId]
  );
  return Number(resultado.affectedRows || 0);
}

async function estornarPagamentoManual(connection, {
  pedidoId,
  usuarioId,
  dados,
  ip = null
}) {
  const entrada = normalizarDados(dados);
  const [[pedido]] = await connection.query(
    `SELECT id, protocolo, cliente_id, status
       FROM pedidos_senha
      WHERE id = ?
      LIMIT 1
      FOR UPDATE`,
    [pedidoId]
  );
  if (!pedido) {
    throw erroNegocio('PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado', 404);
  }

  const [[pagamento]] = await connection.query(
    `SELECT
       pg.id, pg.lancamento_id, pg.valor, pg.moeda,
       lf.tipo, lf.status AS lancamento_status, lf.origem
     FROM pagamentos pg
     INNER JOIN lancamentos_financeiros lf ON lf.id = pg.lancamento_id
     WHERE lf.pedido_senha_id = ?
       AND lf.tipo = 'RECEITA'
       AND (lf.origem = 'CONFIRMACAO_MANUAL' OR LEFT(lf.origem, 11) = 'INTEGRACAO_')
     ORDER BY pg.id DESC
     LIMIT 1
     FOR UPDATE`,
    [pedido.id]
  );
  if (!pagamento) {
    throw erroNegocio(
      'PAGAMENTO_ESTORNAVEL_NAO_ENCONTRADO',
      'Não existe pagamento registrado para estornar',
      404
    );
  }

  const [[existente]] = await connection.query(
    `SELECT id, pagamento_id, lancamento_estorno_id,
            pagamento_estorno_id, valor, moeda, meio_estorno,
            referencia_externa, comprovante_url, motivo, status
       FROM estornos_pagamentos
      WHERE pagamento_id = ?
      LIMIT 1
      FOR UPDATE`,
    [pagamento.id]
  );
  if (existente) {
    const igual = existente.status === 'CONFIRMADO' &&
      existente.meio_estorno === entrada.meio &&
      (existente.referencia_externa || null) === entrada.referencia &&
      (existente.comprovante_url || null) === entrada.comprovante;
    if (!igual) {
      throw erroNegocio(
        'ESTORNO_DIVERGENTE',
        'O pagamento já possui outro estorno registrado'
      );
    }
    const eventosResolvidos = await resolverEventosDoPagamento(
      connection,
      pagamento.id
    );
    return {
      idempotente: true,
      estorno_id: existente.id,
      pagamento_id: pagamento.id,
      valor: Number(existente.valor),
      moeda: existente.moeda,
      status: existente.status,
      eventos_resolvidos: eventosResolvidos
    };
  }

  const valor = Number(pagamento.valor);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw erroNegocio('VALOR_ESTORNO_INVALIDO', 'Pagamento sem valor válido');
  }

  const [lancamentoEstorno] = await connection.query(
    `INSERT INTO lancamentos_financeiros
       (tipo, cliente_id, pedido_senha_id, descricao, valor, moeda,
        data_competencia, status, origem, criado_por)
     VALUES ('DESPESA', ?, ?, ?, ?, ?, CURDATE(), 'PAGO',
             'ESTORNO_MANUAL', ?)`,
    [
      pedido.cliente_id,
      pedido.id,
      `Estorno do pagamento do pedido ${pedido.protocolo}`,
      valor,
      pagamento.moeda,
      usuarioId
    ]
  );
  const [pagamentoEstorno] = await connection.query(
    `INSERT INTO pagamentos
       (lancamento_id, valor, moeda, data_pagamento, meio_pagamento,
        referencia_externa, comprovante_url, observacao, registrado_por)
     VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
    [
      lancamentoEstorno.insertId,
      valor,
      pagamento.moeda,
      entrada.meio,
      entrada.referencia,
      entrada.comprovante,
      entrada.motivo,
      usuarioId
    ]
  );
  const [estorno] = await connection.query(
    `INSERT INTO estornos_pagamentos
       (pagamento_id, pedido_senha_id, lancamento_original_id,
        lancamento_estorno_id, pagamento_estorno_id, valor, moeda,
        meio_estorno, referencia_externa, comprovante_url, motivo,
        status, registrado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMADO', ?)`,
    [
      pagamento.id,
      pedido.id,
      pagamento.lancamento_id,
      lancamentoEstorno.insertId,
      pagamentoEstorno.insertId,
      valor,
      pagamento.moeda,
      entrada.meio,
      entrada.referencia,
      entrada.comprovante,
      entrada.motivo,
      usuarioId
    ]
  );

  await connection.query(
    `INSERT INTO pedido_historico
       (pedido_id, usuario_id, tipo, descricao, dados)
     VALUES (?, ?, 'PAGAMENTO_ESTORNADO', ?, ?)`,
    [
      pedido.id,
      usuarioId,
      entrada.motivo,
      JSON.stringify({
        estorno_id: estorno.insertId,
        pagamento_id: pagamento.id,
        valor,
        moeda: pagamento.moeda,
        meio_estorno: entrada.meio
      })
    ]
  );

  const eventosResolvidos = await resolverEventosDoPagamento(
    connection,
    pagamento.id
  );
  await connection.query(
    `INSERT INTO auditoria
       (usuario_id, modulo, acao, entidade, entidade_id,
        descricao, dados_antes, dados_depois, ip)
     VALUES (?, 'FINANCEIRO', 'ESTORNAR_PAGAMENTO', 'pagamentos', ?, ?, ?, ?, ?)`,
    [
      usuarioId,
      String(pagamento.id),
      `Pagamento do pedido ${pedido.protocolo} estornado`,
      JSON.stringify({
        status: pagamento.lancamento_status,
        valor,
        moeda: pagamento.moeda
      }),
      JSON.stringify({
        estorno_id: estorno.insertId,
        lancamento_estorno_id: lancamentoEstorno.insertId,
        status: 'CONFIRMADO',
        eventos_resolvidos: eventosResolvidos
      }),
      ip
    ]
  );

  return {
    idempotente: false,
    estorno_id: estorno.insertId,
    pagamento_id: pagamento.id,
    valor,
    moeda: pagamento.moeda,
    status: 'CONFIRMADO',
    eventos_resolvidos: eventosResolvidos
  };
}

module.exports = {
  erroNegocio,
  estornarPagamentoManual,
  normalizarDados
};
