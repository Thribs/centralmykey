'use strict';

const crypto = require('crypto');
const { processarEventoPagamentoPedido } = require('./processar-evento-pagamento');
const { criarCobranca } = require('./cliente-sicoob-pix');

const TXID = /^[A-Za-z0-9]{26,35}$/;
const E2E = /^[A-Za-z0-9]{20,100}$/;
const VALOR = /^\d{1,10}\.\d{2}$/;

function falha(mensagem, codigo, status = 400) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = status;
  return erro;
}

function gerarTxid() {
  return `CMK${Date.now().toString(36)}${crypto.randomBytes(9).toString('hex')}`
    .slice(0, 35);
}

function normalizarPix(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw falha('Item Pix inválido', 'PIX_INVALIDO');
  }
  const txid = String(item.txid || '').trim();
  const endToEndId = String(item.endToEndId || '').trim();
  const valor = String(item.valor || '').trim();
  const horario = String(item.horario || '').trim();
  if (!TXID.test(txid)) throw falha('txid Pix inválido', 'TXID_INVALIDO');
  if (!E2E.test(endToEndId)) {
    throw falha('endToEndId Pix inválido', 'END_TO_END_ID_INVALIDO');
  }
  if (!VALOR.test(valor) || Number(valor) <= 0) {
    throw falha('Valor Pix inválido', 'VALOR_PIX_INVALIDO');
  }
  if (!horario || !Number.isFinite(Date.parse(horario))) {
    throw falha('Horário Pix inválido', 'HORARIO_PIX_INVALIDO');
  }
  return { txid, endToEndId, valor, horario, payload: item };
}

function interpretarWebhook(payloadBruto) {
  let corpo;
  try {
    corpo = JSON.parse(Buffer.isBuffer(payloadBruto)
      ? payloadBruto.toString('utf8') : String(payloadBruto || ''));
  } catch {
    throw falha('Corpo do webhook não é JSON válido', 'JSON_INVALIDO');
  }
  if (!corpo || !Array.isArray(corpo.pix) || corpo.pix.length === 0) {
    throw falha('Webhook sem recebimentos Pix', 'PIX_AUSENTE');
  }
  if (corpo.pix.length > 100) {
    throw falha('Webhook excede o limite de recebimentos', 'LOTE_EXCEDIDO', 413);
  }
  return corpo.pix.map(normalizarPix);
}

async function prepararReferenciaPedido(connection, pedidoId, txid = gerarTxid(), dados = {}) {
  if (!TXID.test(txid)) throw falha('txid Pix inválido', 'TXID_INVALIDO');
  const [pedidos] = await connection.query(
    `SELECT id, valor_venda, moeda, status
       FROM pedidos_senha WHERE id=? LIMIT 1 FOR UPDATE`,
    [pedidoId]
  );
  if (!pedidos.length) throw falha('Pedido não encontrado', 'PEDIDO_NAO_ENCONTRADO', 404);
  const pedido = pedidos[0];
  if (pedido.status !== 'AGUARDANDO_PAGAMENTO') {
    throw falha('Pedido não aguarda pagamento', 'PEDIDO_NAO_AGUARDA_PAGAMENTO', 409);
  }
  if (pedido.moeda !== 'BRL' || Number(pedido.valor_venda) <= 0) {
    throw falha('Pedido incompatível com Pix', 'PEDIDO_INCOMPATIVEL_PIX', 422);
  }
  const [expiracao] = await connection.query(
    `UPDATE integracao_referencias_pagamento
        SET status='EXPIRADA', erro_codigo='COBRANCA_EXPIRADA',
            erro_detalhe='Prazo da cobrança Pix encerrado'
      WHERE provedor='SICOOB' AND entidade='PEDIDO' AND entidade_id=?
        AND status IN ('PREPARADA','REGISTRADA')
        AND TIMESTAMPADD(
              SECOND, COALESCE(expiracao_segundos, 3600), criada_em
            ) <= NOW()`,
    [pedido.id]
  );
  const quantidadeExpiradas = Number(expiracao.affectedRows || 0);
  if (quantidadeExpiradas > 0) {
    const dadosMudanca = {
      quantidade: quantidadeExpiradas,
      status_anterior: ['PREPARADA', 'REGISTRADA'],
      status: 'EXPIRADA'
    };
    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
       VALUES (?, ?, 'COBRANCA_SICOOB_EXPIRADA', ?, ?)`,
      [pedido.id, dados.usuarioId || null,
        'Cobrança Pix Sicoob expirada antes de gerar nova referência',
        JSON.stringify(dadosMudanca)]
    );
    await connection.query(
      `INSERT INTO auditoria
         (usuario_id, modulo, acao, entidade, entidade_id, descricao,
          dados_antes, dados_depois, ip)
       VALUES (?, 'INTEGRACOES', 'EXPIRAR_COBRANCA_SICOOB',
               'pedidos_senha', ?, ?, ?, ?, ?)`,
      [dados.usuarioId || null, String(pedido.id),
        `Cobrança Sicoob do pedido ${pedido.id} expirada`,
        JSON.stringify({ quantidade: quantidadeExpiradas,
          status: ['PREPARADA', 'REGISTRADA'] }),
        JSON.stringify({ quantidade: quantidadeExpiradas, status: 'EXPIRADA' }),
        dados.ip || null]
    );
  }
  const [existentes] = await connection.query(
    `SELECT id, referencia_provedor, valor, moeda, status,
            expiracao_segundos, solicitacao_pagador
       FROM integracao_referencias_pagamento
      WHERE provedor='SICOOB' AND entidade='PEDIDO' AND entidade_id=?
        AND status IN ('PREPARADA','REGISTRADA')
      ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [pedido.id]
  );
  if (existentes.length) {
    const existente = existentes[0];
    return { id: existente.id, txid: existente.referencia_provedor,
      pedido_id: pedido.id, valor: Number(existente.valor), moeda: existente.moeda,
      status: existente.status,
      expiracao_segundos: Number(existente.expiracao_segundos || 3600),
      solicitacao_pagador: existente.solicitacao_pagador,
      idempotente: true };
  }
  const [resultado] = await connection.query(
    `INSERT INTO integracao_referencias_pagamento
       (provedor, entidade, entidade_id, referencia_provedor, valor, moeda,
        expiracao_segundos, solicitacao_pagador, status)
     VALUES ('SICOOB', 'PEDIDO', ?, ?, ?, 'BRL', ?, ?, 'PREPARADA')`,
    [pedido.id, txid, pedido.valor_venda,
      dados.expiracaoSegundos || 3600, dados.solicitacaoPagador || null]
  );
  return { id: resultado.insertId, txid, pedido_id: pedido.id,
    valor: Number(pedido.valor_venda), moeda: 'BRL', status: 'PREPARADA',
    expiracao_segundos: dados.expiracaoSegundos || 3600,
    solicitacao_pagador: dados.solicitacaoPagador || null };
}

async function processarWebhookSicoob(pool, payloadBruto, opcoes = {}) {
  const itens = interpretarWebhook(payloadBruto);
  const resultados = [];
  for (const pix of itens) {
    const [referencias] = await pool.query(
      `SELECT id, entidade_id, status
         FROM integracao_referencias_pagamento
        WHERE provedor='SICOOB' AND referencia_provedor=? LIMIT 1`,
      [pix.txid]
    );
    const referencia = referencias[0];
    const resultado = await processarEventoPagamentoPedido(pool, {
      provedor: 'SICOOB',
      evento_externo_id: pix.endToEndId,
      tipo: 'PIX_RECEBIDO',
      referencia_externa: pix.endToEndId,
      pedido_id: referencia ? referencia.entidade_id : 0,
      protocolo: referencia ? '' : pix.txid,
      valor: pix.valor,
      moeda: 'BRL',
      payload_bruto: JSON.stringify(pix.payload)
    }, {
      ...opcoes,
      pedidoNaoEncontradoCodigo: referencia
        ? 'PEDIDO_NAO_ENCONTRADO' : 'TXID_NAO_VINCULADO',
      pedidoNaoEncontradoDetalhe: referencia
        ? 'Pedido vinculado ao txid não encontrado' : 'txid não vinculado a pedido',
      forcarPedidoNaoEncontrado: !referencia
    });
    if (referencia) {
      const pago = resultado.status === 'PROCESSADO';
      await pool.query(
        `UPDATE integracao_referencias_pagamento
            SET status=?, identificador_pagamento=?, erro_codigo=?, erro_detalhe=?,
                paga_em=IF(?, COALESCE(paga_em, NOW()), paga_em)
          WHERE id=?`,
        [pago ? 'PAGA' : 'FALHOU', pix.endToEndId,
          pago ? null : resultado.codigo, pago ? null : 'Falha ao conciliar recebimento Pix',
          pago ? 1 : 0, referencia.id]
      );
    }
    resultados.push({ txid: pix.txid, endToEndId: pix.endToEndId, ...resultado });
  }
  return { ok: resultados.every(item => item.ok), total: resultados.length, resultados };
}

async function criarCobrancaPedidoSicoob(pool, pedidoId, config, opcoes = {}) {
  const expiracaoSegundos = Number(opcoes.expiracaoSegundos || 3600);
  const solicitacaoPagador = String(opcoes.solicitacaoPagador ||
    `Central MyKey - pedido ${pedidoId}`).trim().slice(0, 140);
  if (!Number.isInteger(expiracaoSegundos) || expiracaoSegundos < 60 ||
      expiracaoSegundos > 86400) {
    throw falha('Expiração Pix inválida', 'EXPIRACAO_PIX_INVALIDA');
  }
  const connection = await pool.getConnection();
  let referencia;
  try {
    await connection.beginTransaction();
    referencia = await prepararReferenciaPedido(connection, pedidoId, gerarTxid(), {
      expiracaoSegundos, solicitacaoPagador,
      usuarioId: opcoes.usuarioId,
      ip: opcoes.ip
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  try {
    const cobranca = await criarCobranca(config, {
      txid: referencia.txid, valor: referencia.valor,
      expiracaoSegundos: referencia.expiracao_segundos,
      solicitacaoPagador: referencia.solicitacao_pagador
    }, opcoes.transporte);
    const finalizacao = await pool.getConnection();
    let registradaAgora = false;
    try {
      await finalizacao.beginTransaction();
      const [atualizacao] = await finalizacao.query(
        `UPDATE integracao_referencias_pagamento
            SET status='REGISTRADA', location=?, pix_copia_cola=?, registrada_em=NOW(),
                erro_codigo=NULL, erro_detalhe=NULL
          WHERE id=? AND status<>'REGISTRADA'`,
        [cobranca.location, cobranca.pixCopiaECola || null, referencia.id]
      );
      registradaAgora = Number(atualizacao.affectedRows) === 1;
      if (registradaAgora) {
        await finalizacao.query(
          `INSERT INTO pedido_historico
             (pedido_id, usuario_id, tipo, descricao, dados)
           VALUES (?, ?, 'COBRANCA_SICOOB_REGISTRADA', ?, ?)`,
          [pedidoId, opcoes.usuarioId || null, 'Cobrança Pix Sicoob registrada',
            JSON.stringify({ txid: referencia.txid, valor: referencia.valor,
              moeda: referencia.moeda })]
        );
        await finalizacao.query(
          `INSERT INTO auditoria
             (usuario_id, modulo, acao, entidade, entidade_id, descricao,
              dados_antes, dados_depois, ip)
           VALUES (?, 'INTEGRACOES', 'CRIAR_COBRANCA_SICOOB',
                   'pedidos_senha', ?, ?, NULL, ?, ?)`,
          [opcoes.usuarioId || null, String(pedidoId),
            `Cobrança Sicoob do pedido ${pedidoId} registrada`,
            JSON.stringify({ txid: referencia.txid, valor: referencia.valor,
              moeda: referencia.moeda }), opcoes.ip || null]
        );
      }
      await finalizacao.commit();
    } catch (error) {
      await finalizacao.rollback();
      throw error;
    } finally {
      finalizacao.release();
    }
    return { ok: true, pedido_id: referencia.pedido_id, txid: referencia.txid,
      valor: referencia.valor, moeda: referencia.moeda, status: 'REGISTRADA',
      location: cobranca.location, pix_copia_cola: cobranca.pixCopiaECola || null,
      idempotente: Boolean(referencia.idempotente),
      registrada_agora: registradaAgora };
  } catch (error) {
    await pool.query(
      `UPDATE integracao_referencias_pagamento
          SET erro_codigo=?, erro_detalhe=? WHERE id=?`,
      [error.codigo || 'SICOOB_INDISPONIVEL',
        String(error.message || 'Falha Sicoob').slice(0, 500), referencia.id]
    );
    throw error;
  }
}

module.exports = {
  gerarTxid,
  interpretarWebhook,
  prepararReferenciaPedido,
  processarWebhookSicoob,
  criarCobrancaPedidoSicoob
};
