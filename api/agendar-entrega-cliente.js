'use strict';

const { somenteNumeros } = require('./agendar-consulta-fornecedor');

function textoParametro(valor, fallback = '-') {
  const texto = String(valor ?? '').trim();
  return (texto || fallback).slice(0, 1024);
}

function telefoneCliente(cliente) {
  return somenteNumeros(
    cliente?.telefone_normalizado || cliente?.telefone
  );
}

function telefoneValido(telefone) {
  return telefone.length >= 10 && telefone.length <= 15;
}

async function agendarEntregaCliente(connection, {
  pedido,
  resultado,
  cliente,
  usuarioId = null
}) {
  const pedidoId = Number(pedido?.id);
  const resultadoId = Number(resultado?.id);
  const destinatario = telefoneCliente(cliente);

  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    throw new Error('Pedido inválido para entrega ao cliente');
  }
  if (!Number.isInteger(resultadoId) || resultadoId <= 0) {
    throw new Error('Resultado inválido para entrega ao cliente');
  }

  const destinatarioValido = telefoneValido(destinatario);
  const statusInicial = destinatarioValido ? 'PENDENTE' : 'FALHOU';
  const erroInicial = destinatarioValido ? null : 'CLIENTE_SEM_WHATSAPP';
  const chaveIdempotencia = `ENTREGA_CLIENTE:${pedidoId}:${resultadoId}`;
  const dadosResultado = resultado.resultado &&
    typeof resultado.resultado === 'object'
    ? resultado.resultado
    : {};
  const payload = {
    tipo: 'MODELO_WHATSAPP',
    parametros: [
      textoParametro(pedido.protocolo),
      textoParametro(resultado.codigo_mecanico),
      textoParametro(resultado.codigo_imobilizador),
      textoParametro(resultado.codigo_radio),
      textoParametro(dadosResultado.codigo_alarme),
      textoParametro(resultado.pin)
    ]
  };

  const [insercao] = await connection.query(
    `INSERT IGNORE INTO comunicacoes_outbox
       (chave_idempotencia, canal, finalidade, pedido_id,
        resultado_id, fornecedor_id, destinatario, payload, status,
        erro_codigo, erro_detalhe)
     VALUES (?, 'WHATSAPP', 'ENTREGA_CLIENTE', ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [
      chaveIdempotencia,
      pedidoId,
      resultadoId,
      destinatarioValido ? destinatario : null,
      JSON.stringify(payload),
      statusInicial,
      erroInicial,
      erroInicial ? 'Cliente sem WhatsApp válido no cadastro' : null
    ]
  );

  if (insercao.affectedRows === 1) {
    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
       VALUES (?, ?, ?, ?, ?)`,
      [
        pedidoId,
        usuarioId,
        statusInicial === 'PENDENTE'
          ? 'ENTREGA_CLIENTE_AGENDADA'
          : 'ENTREGA_CLIENTE_ENVIO_FALHOU',
        statusInicial === 'PENDENTE'
          ? 'Resultado preparado para envio ao cliente'
          : 'Resultado não enviado: cliente sem WhatsApp válido',
        JSON.stringify({
          comunicacao_id: insercao.insertId,
          resultado_id: resultadoId,
          canal: 'WHATSAPP',
          status: statusInicial,
          erro_codigo: erroInicial
        })
      ]
    );
  }

  const [[comunicacao]] = await connection.query(
    `SELECT id, status, tentativas
       FROM comunicacoes_outbox
      WHERE chave_idempotencia = ?
      LIMIT 1`,
    [chaveIdempotencia]
  );

  return {
    criada: insercao.affectedRows === 1,
    id: comunicacao.id,
    status: comunicacao.status,
    tentativas: Number(comunicacao.tentativas)
  };
}

async function reagendarEntregaCliente(connection, {
  pedidoId,
  comunicacaoId,
  usuarioId = null,
  confirmarIncerto = false
}) {
  const [registros] = await connection.query(
    `SELECT
       co.id,
       co.status,
       co.resultado_id,
       COALESCE(
         NULLIF(c.telefone_normalizado, ''),
         NULLIF(c.telefone, ''),
         (SELECT ct.telefone_normalizado
            FROM cliente_telefones ct
           WHERE ct.cliente_id = c.id
           ORDER BY ct.id LIMIT 1)
       ) AS telefone_cliente
     FROM comunicacoes_outbox co
     INNER JOIN pedidos_senha p ON p.id = co.pedido_id
     INNER JOIN clientes c ON c.id = p.cliente_id
     WHERE co.id = ?
       AND co.pedido_id = ?
       AND co.finalidade = 'ENTREGA_CLIENTE'
     LIMIT 1
     FOR UPDATE`,
    [comunicacaoId, pedidoId]
  );

  if (!registros.length) {
    const erro = new Error('Comunicação de entrega não encontrada');
    erro.codigo = 'COMUNICACAO_NAO_ENCONTRADA';
    throw erro;
  }

  const comunicacao = registros[0];
  if (comunicacao.status === 'INCERTA' && !confirmarIncerto) {
    const erro = new Error(
      'Confirme que o cliente não recebeu a mensagem antes de repetir'
    );
    erro.codigo = 'ENVIO_INCERTO_EXIGE_CONFIRMACAO';
    throw erro;
  }
  if (!['FALHOU', 'INCERTA'].includes(comunicacao.status)) {
    const erro = new Error('Somente envios falhos ou incertos podem ser repetidos');
    erro.codigo = 'COMUNICACAO_NAO_REPROCESSAVEL';
    throw erro;
  }

  const destinatario = somenteNumeros(comunicacao.telefone_cliente);
  if (!telefoneValido(destinatario)) {
    const erro = new Error('Cliente continua sem WhatsApp válido');
    erro.codigo = 'CLIENTE_SEM_WHATSAPP';
    throw erro;
  }

  await connection.query(
    `UPDATE comunicacoes_outbox
        SET destinatario = ?, status = 'PENDENTE',
            processar_apos = NOW(), mensagem_externa_id = NULL,
            erro_codigo = NULL, erro_detalhe = NULL,
            enviado_em = NULL, entregue_em = NULL, lida_em = NULL
      WHERE id = ?`,
    [destinatario, comunicacao.id]
  );
  await connection.query(
    `INSERT INTO pedido_historico
       (pedido_id, usuario_id, tipo, descricao, dados)
     VALUES (?, ?, 'ENTREGA_CLIENTE_REAGENDADA', ?, ?)`,
    [
      pedidoId,
      usuarioId,
      'Envio do resultado ao cliente reagendado',
      JSON.stringify({
        comunicacao_id: comunicacao.id,
        resultado_id: comunicacao.resultado_id,
        status_anterior: comunicacao.status,
        confirmacao_envio_incerto: Boolean(confirmarIncerto)
      })
    ]
  );

  return {
    id: comunicacao.id,
    status: 'PENDENTE',
    resultado_id: comunicacao.resultado_id
  };
}

module.exports = {
  agendarEntregaCliente,
  reagendarEntregaCliente,
  telefoneCliente
};
