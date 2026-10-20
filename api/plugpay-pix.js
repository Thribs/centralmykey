'use strict';

const crypto = require('crypto');
const { criarPix } = require('./cliente-plugpay');
const { validarCPF } = require('./rotas-clientes');

function falha(mensagem, codigo, status = 400) {
  const erro = new Error(mensagem); erro.codigo = codigo; erro.status = status; return erro;
}

async function preparar(connection, pedidoId) {
  const [pedidos] = await connection.query(
    `SELECT p.id, p.valor_venda, p.moeda, p.status, c.cpf_normalizado AS cpf
       FROM pedidos_senha p JOIN clientes c ON c.id=p.cliente_id
      WHERE p.id=? LIMIT 1 FOR UPDATE`, [pedidoId]);
  if (!pedidos.length) throw falha('Pedido não encontrado', 'PEDIDO_NAO_ENCONTRADO', 404);
  const pedido = pedidos[0];
  if (pedido.status !== 'AGUARDANDO_PAGAMENTO') {
    throw falha('Pedido não aguarda pagamento', 'PEDIDO_NAO_AGUARDA_PAGAMENTO', 409);
  }
  if (pedido.moeda !== 'BRL' || Number(pedido.valor_venda) <= 0) {
    throw falha('Pedido incompatível com Pix', 'PEDIDO_INCOMPATIVEL_PIX', 422);
  }
  const cpf = String(pedido.cpf || '').replace(/\D/g, '');
  if (!validarCPF(cpf)) throw falha('Cliente precisa de CPF válido', 'CPF_PAGADOR_INVALIDO', 422);
  const [existentes] = await connection.query(
    `SELECT id, referencia_provedor, valor, moeda, status, pix_copia_cola
       FROM integracao_referencias_pagamento
      WHERE provedor='PLUGPAY' AND entidade='PEDIDO' AND entidade_id=?
        AND status IN ('PREPARADA','REGISTRADA') ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [pedido.id]);
  if (existentes.length) return { ...existentes[0], pedido_id: pedido.id, cpf,
    idempotente: true };
  const provisoria = `PENDENTE-${crypto.randomUUID()}`;
  const [resultado] = await connection.query(
    `INSERT INTO integracao_referencias_pagamento
       (provedor, entidade, entidade_id, referencia_provedor, valor, moeda, status)
     VALUES ('PLUGPAY','PEDIDO',?,?,?,'BRL','PREPARADA')`,
    [pedido.id, provisoria, pedido.valor_venda]);
  return { id: resultado.insertId, referencia_provedor: provisoria,
    pedido_id: pedido.id, valor: Number(pedido.valor_venda), moeda: 'BRL', cpf,
    status: 'PREPARADA', idempotente: false };
}

async function criarCobrancaPedidoPlugPay(pool, pedidoId, config, opcoes = {}) {
  const conexao = await pool.getConnection();
  let ref;
  try {
    await conexao.beginTransaction(); ref = await preparar(conexao, pedidoId);
    await conexao.commit();
  } catch (error) { await conexao.rollback(); throw error; } finally { conexao.release(); }
  if (ref.idempotente) {
    if (ref.status === 'REGISTRADA') return { ok: true, pedido_id: ref.pedido_id,
      referencia: ref.referencia_provedor, valor: Number(ref.valor), moeda: ref.moeda,
      status: ref.status, pix_copia_cola: ref.pix_copia_cola, idempotente: true };
    throw falha('Criação PlugPay anterior exige conferência antes de nova tentativa',
      'PLUGPAY_CRIACAO_INCERTA', 409);
  }
  try {
    const cobranca = await criarPix(config, { valor: ref.valor, moeda: ref.moeda,
      cpf: ref.cpf }, opcoes.transporte);
    await pool.query(
      `UPDATE integracao_referencias_pagamento
          SET referencia_provedor=?, status='REGISTRADA', location=?,
              pix_copia_cola=?, registrada_em=NOW(), erro_codigo=NULL, erro_detalhe=NULL
        WHERE id=? AND status='PREPARADA'`,
      [cobranca.referencia, cobranca.qrCodeId || null, cobranca.pixCopiaECola, ref.id]);
    await pool.query(
      `INSERT INTO pedido_historico (pedido_id, usuario_id, tipo, descricao, dados)
       VALUES (?,?,'COBRANCA_PLUGPAY_REGISTRADA','Cobrança Pix PlugPay registrada',?)`,
      [pedidoId, opcoes.usuarioId || null, JSON.stringify({
        referencia: cobranca.referencia, transacao_id: cobranca.transacaoId,
        valor: ref.valor, moeda: ref.moeda })]);
    return { ok: true, pedido_id: ref.pedido_id, referencia: cobranca.referencia,
      valor: ref.valor, moeda: ref.moeda, status: 'REGISTRADA',
      pix_copia_cola: cobranca.pixCopiaECola, idempotente: false };
  } catch (error) {
    await pool.query(`UPDATE integracao_referencias_pagamento SET erro_codigo=?, erro_detalhe=?
      WHERE id=?`, [error.codigo || 'PLUGPAY_INDISPONIVEL',
      String(error.message || 'Falha PlugPay').slice(0, 500), ref.id]);
    throw error;
  }
}

module.exports = { criarCobrancaPedidoPlugPay, preparar };
