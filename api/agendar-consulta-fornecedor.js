'use strict';

function somenteNumeros(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function textoParametro(valor, fallback = '-') {
  const texto = String(valor ?? '').trim();
  return (texto || fallback).slice(0, 1024);
}

function removerAcentos(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toUpperCase();
}

function destinatarioFornecedor(fornecedor) {
  const nome = removerAcentos(fornecedor?.fornecedor || fornecedor?.nome);
  if (nome.includes('MARCIO')) return somenteNumeros(process.env.WHATSAPP_FORNECEDOR_MARCIO);
  if (nome.includes('EMERSON')) return somenteNumeros(process.env.WHATSAPP_FORNECEDOR_EMERSON);
  return somenteNumeros(fornecedor?.whatsapp || fornecedor?.telefone);
}

async function agendarConsultaFornecedor(connection, {
  pedido,
  fornecedor,
  usuarioId = null
}) {
  const pedidoId = Number(pedido?.id);
  const fornecedorId = Number(fornecedor?.fornecedor_id || fornecedor?.id);
  const destinatario = destinatarioFornecedor(fornecedor);

  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    throw new Error('Pedido inválido para comunicação com fornecedor');
  }

  if (!Number.isInteger(fornecedorId) || fornecedorId <= 0) {
    throw new Error('Fornecedor inválido para comunicação');
  }

  const destinatarioValido =
    destinatario.length >= 10 && destinatario.length <= 15;
  const statusInicial = destinatarioValido ? 'PENDENTE' : 'FALHOU';
  const erroInicial = destinatarioValido
    ? null
    : 'FORNECEDOR_SEM_WHATSAPP';

  const chaveIdempotencia =
    `CONSULTA_FORNECEDOR:${pedidoId}:${fornecedorId}`;
  const payload = {
    tipo: 'MODELO_WHATSAPP',
    parametros: [
      textoParametro(pedido.protocolo),
      textoParametro(pedido.chassi),
      textoParametro(pedido.marca),
      textoParametro(pedido.modelo),
      textoParametro(pedido.ano)
    ]
  };

  const [resultado] = await connection.query(
    `INSERT IGNORE INTO comunicacoes_outbox
       (chave_idempotencia, canal, finalidade, pedido_id,
        fornecedor_id, destinatario, payload, status,
        erro_codigo, erro_detalhe)
     VALUES (?, 'WHATSAPP', 'CONSULTA_FORNECEDOR', ?, ?, ?, ?, ?, ?, ?)`,
    [
      chaveIdempotencia,
      pedidoId,
      fornecedorId,
      destinatarioValido ? destinatario : null,
      JSON.stringify(payload),
      statusInicial,
      erroInicial,
      erroInicial ? 'Fornecedor sem WhatsApp válido no cadastro' : null
    ]
  );

  if (resultado.affectedRows === 1) {
    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
       VALUES (?, ?, ?, ?, ?)`,
      [
        pedidoId,
        usuarioId,
        statusInicial === 'PENDENTE'
          ? 'CONSULTA_FORNECEDOR_AGENDADA'
          : 'CONSULTA_FORNECEDOR_ENVIO_FALHOU',
        statusInicial === 'PENDENTE'
          ? 'Consulta preparada para envio ao fornecedor'
          : 'Consulta não enviada: fornecedor sem WhatsApp válido',
        JSON.stringify({
          comunicacao_id: resultado.insertId,
          fornecedor_id: fornecedorId,
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
    criada: resultado.affectedRows === 1,
    id: comunicacao.id,
    status: comunicacao.status,
    tentativas: Number(comunicacao.tentativas)
  };
}

async function reagendarConsultaFornecedor(connection, {
  pedidoId,
  comunicacaoId,
  usuarioId = null,
  confirmarIncerto = false
}) {
  const [registros] = await connection.query(
    `SELECT
       co.id,
       co.status,
       co.fornecedor_id,
       f.nome AS fornecedor,
       f.whatsapp,
       f.telefone
     FROM comunicacoes_outbox co
     INNER JOIN fornecedores f ON f.id = co.fornecedor_id
     WHERE co.id = ?
       AND co.pedido_id = ?
       AND co.finalidade = 'CONSULTA_FORNECEDOR'
     LIMIT 1
     FOR UPDATE`,
    [comunicacaoId, pedidoId]
  );

  if (!registros.length) {
    const erro = new Error('Comunicação do fornecedor não encontrada');
    erro.codigo = 'COMUNICACAO_NAO_ENCONTRADA';
    throw erro;
  }

  const comunicacao = registros[0];
  if (comunicacao.status === 'INCERTA' && !confirmarIncerto) {
    const erro = new Error(
      'Confirme que a mensagem não foi recebida antes de repetir'
    );
    erro.codigo = 'ENVIO_INCERTO_EXIGE_CONFIRMACAO';
    throw erro;
  }

  if (!['FALHOU', 'INCERTA'].includes(comunicacao.status)) {
    const erro = new Error('Somente envios falhos ou incertos podem ser repetidos');
    erro.codigo = 'COMUNICACAO_NAO_REPROCESSAVEL';
    throw erro;
  }

  const destinatario = destinatarioFornecedor(comunicacao);
  if (destinatario.length < 10 || destinatario.length > 15) {
    const erro = new Error('Fornecedor continua sem WhatsApp válido');
    erro.codigo = 'FORNECEDOR_SEM_WHATSAPP';
    throw erro;
  }

  await connection.query(
    `UPDATE comunicacoes_outbox
        SET destinatario = ?, status = 'PENDENTE',
            processar_apos = NOW(), mensagem_externa_id = NULL,
            erro_codigo = NULL, erro_detalhe = NULL, enviado_em = NULL
      WHERE id = ?`,
    [destinatario, comunicacao.id]
  );

  await connection.query(
    `INSERT INTO pedido_historico
       (pedido_id, usuario_id, tipo, descricao, dados)
     VALUES (?, ?, 'CONSULTA_FORNECEDOR_REAGENDADA', ?, ?)`,
    [
      pedidoId,
      usuarioId,
      'Envio da consulta ao fornecedor reagendado',
      JSON.stringify({
        comunicacao_id: comunicacao.id,
        fornecedor_id: comunicacao.fornecedor_id,
        status_anterior: comunicacao.status,
        confirmacao_envio_incerto: Boolean(confirmarIncerto)
      })
    ]
  );

  return {
    id: comunicacao.id,
    status: 'PENDENTE',
    fornecedor_id: comunicacao.fornecedor_id
  };
}

module.exports = {
  agendarConsultaFornecedor,
  destinatarioFornecedor,
  reagendarConsultaFornecedor,
  somenteNumeros
};
