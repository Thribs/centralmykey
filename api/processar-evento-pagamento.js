'use strict';

const crypto = require('crypto');
const processarPedidoPagoPadrao = require('./processar-pedido-pago');

const PROVEDORES = ['SICOOB', 'PLUGPAY', 'WBUY'];
const MOEDAS = ['BRL', 'USD', 'PYG'];

function falha(mensagem, codigo, status = 400) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = status;
  return erro;
}

function texto(valor, limite) {
  const resultado = String(valor === undefined || valor === null ? '' : valor).trim();
  return resultado && resultado.length <= limite ? resultado : '';
}

function centavos(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.round(numero * 100) : NaN;
}

function prepararEvento(dados) {
  const provedor = texto(dados.provedor, 40).toUpperCase();
  const eventoId = texto(dados.evento_externo_id, 160);
  const tipo = texto(dados.tipo, 80);
  const referencia = texto(dados.referencia_externa, 120);
  const moeda = texto(dados.moeda || 'BRL', 3).toUpperCase();
  const pedidoId = Number(dados.pedido_id || 0);
  const protocolo = texto(dados.protocolo, 120);
  const valorCentavos = centavos(dados.valor);

  if (!PROVEDORES.includes(provedor)) {
    throw falha('Provedor de pagamento inválido', 'PROVEDOR_INVALIDO');
  }
  if (!eventoId || !tipo || !referencia) {
    throw falha('Evento, tipo e referência são obrigatórios', 'EVENTO_INVALIDO');
  }
  if ((!Number.isInteger(pedidoId) || pedidoId <= 0) && !protocolo) {
    throw falha('Pedido ou protocolo é obrigatório', 'PEDIDO_NAO_INFORMADO');
  }
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) {
    throw falha('Valor do pagamento inválido', 'VALOR_INVALIDO');
  }
  if (!MOEDAS.includes(moeda)) {
    throw falha('Moeda do pagamento inválida', 'MOEDA_INVALIDA');
  }
  const possuiPayloadBruto = typeof dados.payload_bruto === 'string';
  const payloadBruto = possuiPayloadBruto
    ? dados.payload_bruto
    : JSON.stringify(dados.payload || {});
  let payload;
  try {
    payload = possuiPayloadBruto
      ? JSON.parse(payloadBruto || '{}')
      : (dados.payload && typeof dados.payload === 'object' ? dados.payload : {});
  } catch {
    throw falha('Payload externo inválido', 'PAYLOAD_INVALIDO');
  }
  const payloadHash = crypto.createHash('sha256').update(payloadBruto).digest('hex');
  return {
    provedor, eventoId, tipo, referencia, moeda, pedidoId, protocolo,
    valorCentavos, payload, payloadHash
  };
}

async function marcarFalha(connection, eventoId, codigo, detalhe, entidadeId = null) {
  await connection.query(
    `UPDATE integracao_eventos
        SET status = 'FALHOU', entidade = 'PEDIDO', entidade_id = ?,
            erro_codigo = ?, erro_detalhe = ?, processado_em = NOW()
      WHERE id = ?`,
    [entidadeId, codigo, String(detalhe).slice(0, 500), eventoId]
  );
  return { ok: false, aceito: true, status: 'FALHOU', codigo, evento_id: eventoId };
}

async function processarEventoPagamentoPedido(pool, dados, opcoes = {}) {
  const evento = prepararEvento(dados);
  const processarPedidoPago = opcoes.processarPedidoPago || processarPedidoPagoPadrao;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existentes] = await connection.query(
      `SELECT id, payload_hash, status, entidade_id, lancamento_id, pagamento_id
         FROM integracao_eventos
        WHERE provedor = ? AND evento_externo_id = ? LIMIT 1 FOR UPDATE`,
      [evento.provedor, evento.eventoId]
    );
    if (existentes.length) {
      const existente = existentes[0];
      if (existente.payload_hash !== evento.payloadHash) {
        throw falha('Identificador externo reutilizado com conteúdo diferente',
          'COLISAO_EVENTO_EXTERNO', 409);
      }
      await connection.query(
        'UPDATE integracao_eventos SET tentativas = tentativas + 1 WHERE id = ?',
        [existente.id]
      );
      await connection.commit();
      return {
        ok: existente.status === 'PROCESSADO',
        aceito: true,
        idempotente: true,
        status: existente.status,
        evento_id: existente.id,
        pedido_id: existente.entidade_id,
        lancamento_id: existente.lancamento_id,
        pagamento_id: existente.pagamento_id
      };
    }

    const [insercaoEvento] = await connection.query(
      `INSERT INTO integracao_eventos
         (provedor, evento_externo_id, tipo, referencia_externa,
          payload_hash, payload, status)
       VALUES (?, ?, ?, ?, ?, ?, 'RECEBIDO')`,
      [evento.provedor, evento.eventoId, evento.tipo, evento.referencia,
        evento.payloadHash, JSON.stringify(evento.payload)]
    );
    const eventoBancoId = insercaoEvento.insertId;
    const parametrosPedido = evento.pedidoId > 0
      ? [evento.pedidoId]
      : [evento.protocolo];
    const filtroPedido = evento.pedidoId > 0 ? 'p.id = ?' : 'p.protocolo = ?';
    const [pedidos] = await connection.query(
      `SELECT p.id, p.protocolo, p.cliente_id, p.valor_venda, p.moeda,
              p.status, c.nome AS cliente, s.nome AS servico
         FROM pedidos_senha p
         JOIN clientes c ON c.id = p.cliente_id
         JOIN servicos s ON s.id = p.servico_id
        WHERE ${filtroPedido} LIMIT 1 FOR UPDATE`,
      parametrosPedido
    );
    if (!pedidos.length) {
      const resultado = await marcarFalha(connection, eventoBancoId,
        'PEDIDO_NAO_ENCONTRADO', 'Pedido informado pelo evento não encontrado');
      await connection.commit();
      return resultado;
    }
    const pedido = pedidos[0];
    const valorPedido = centavos(pedido.valor_venda);
    if (pedido.moeda !== evento.moeda || valorPedido !== evento.valorCentavos) {
      const resultado = await marcarFalha(connection, eventoBancoId,
        'VALOR_OU_MOEDA_DIVERGENTE',
        'Valor ou moeda do evento diverge do pedido', pedido.id);
      await connection.commit();
      return resultado;
    }

    const origem = `INTEGRACAO_${evento.provedor}`;
    const [pagamentosExistentes] = await connection.query(
      `SELECT pg.id AS pagamento_id, pg.valor, pg.moeda,
              lf.id AS lancamento_id, lf.pedido_senha_id
         FROM pagamentos pg
         JOIN lancamentos_financeiros lf ON lf.id = pg.lancamento_id
        WHERE pg.meio_pagamento = ? AND pg.referencia_externa = ?
        ORDER BY pg.id DESC LIMIT 1 FOR UPDATE`,
      [evento.provedor, evento.referencia]
    );
    if (pagamentosExistentes.length) {
      const existente = pagamentosExistentes[0];
      const igual = Number(existente.pedido_senha_id) === Number(pedido.id) &&
        centavos(existente.valor) === evento.valorCentavos &&
        existente.moeda === evento.moeda;
      if (!igual) {
        const resultado = await marcarFalha(connection, eventoBancoId,
          'COLISAO_REFERENCIA_PAGAMENTO',
          'Referência externa já vinculada a outro pagamento', pedido.id);
        await connection.commit();
        return resultado;
      }
      await connection.query(
        `UPDATE integracao_eventos
            SET status='PROCESSADO', entidade='PEDIDO', entidade_id=?,
                lancamento_id=?, pagamento_id=?, processado_em=NOW()
          WHERE id=?`,
        [pedido.id, existente.lancamento_id, existente.pagamento_id, eventoBancoId]
      );
      await connection.commit();
      return {
        ok: true, aceito: true, idempotente: true, status: 'PROCESSADO',
        evento_id: eventoBancoId, pedido_id: pedido.id,
        lancamento_id: existente.lancamento_id,
        pagamento_id: existente.pagamento_id
      };
    }

    if (pedido.status !== 'AGUARDANDO_PAGAMENTO') {
      const resultado = await marcarFalha(connection, eventoBancoId,
        'PEDIDO_NAO_AGUARDA_PAGAMENTO',
        `Pedido está no estado ${pedido.status}`, pedido.id);
      await connection.commit();
      return resultado;
    }

    const valor = evento.valorCentavos / 100;
    const [lancamento] = await connection.query(
      `INSERT INTO lancamentos_financeiros
         (tipo, cliente_id, pedido_senha_id, descricao, valor, moeda,
          data_competencia, status, origem, criado_por)
       VALUES ('RECEITA', ?, ?, ?, ?, ?, CURDATE(), 'RECEBIDO', ?, NULL)`,
      [pedido.cliente_id, pedido.id,
        `Pagamento ${evento.provedor} do pedido ${pedido.protocolo}`,
        valor, evento.moeda, origem]
    );
    const [pagamento] = await connection.query(
      `INSERT INTO pagamentos
         (lancamento_id, valor, moeda, data_pagamento, meio_pagamento,
          referencia_externa, observacao, registrado_por)
       VALUES (?, ?, ?, NOW(), ?, ?, ?, NULL)`,
      [lancamento.insertId, valor, evento.moeda, evento.provedor,
        evento.referencia, `Evento externo ${evento.eventoId}`]
    );
    await connection.query("UPDATE pedidos_senha SET status='PAGO' WHERE id=?", [pedido.id]);
    const processamento = await processarPedidoPago(connection, pedido.id, null);
    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
       VALUES (?, NULL, 'PAGAMENTO_CONFIRMADO_INTEGRACAO', ?, ?)`,
      [pedido.id, `Pagamento confirmado automaticamente por ${evento.provedor}`,
        JSON.stringify({ provedor: evento.provedor, evento_id: eventoBancoId,
          pagamento_id: pagamento.insertId, referencia_externa: evento.referencia,
          valor, moeda: evento.moeda })]
    );
    await connection.query(
      `INSERT INTO auditoria
         (usuario_id, modulo, acao, entidade, entidade_id, descricao,
          dados_antes, dados_depois, ip)
       VALUES (NULL, 'INTEGRACOES', 'CONFIRMAR_PAGAMENTO_EXTERNO',
               'pedidos_senha', ?, ?, ?, ?, NULL)`,
      [String(pedido.id),
        `Pagamento do pedido ${pedido.protocolo} confirmado por ${evento.provedor}`,
        JSON.stringify({ status: 'AGUARDANDO_PAGAMENTO' }),
        JSON.stringify({ status: processamento.status, provedor: evento.provedor,
          evento_id: eventoBancoId, pagamento_id: pagamento.insertId,
          lancamento_id: lancamento.insertId })]
    );
    await connection.query(
      `UPDATE integracao_eventos
          SET status='PROCESSADO', entidade='PEDIDO', entidade_id=?,
              lancamento_id=?, pagamento_id=?, processado_em=NOW()
        WHERE id=?`,
      [pedido.id, lancamento.insertId, pagamento.insertId, eventoBancoId]
    );
    await connection.commit();
    return {
      ok: true, aceito: true, status: 'PROCESSADO', evento_id: eventoBancoId,
      pedido_id: pedido.id, lancamento_id: lancamento.insertId,
      pagamento_id: pagamento.insertId, processamento
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { prepararEvento, processarEventoPagamentoPedido };
