'use strict';

function limitar(valor, tamanho) {
  return String(valor || '').trim().slice(0, tamanho);
}

async function registrarNotificacao(connection, {
  chave,
  tipo,
  nivel = 'INFO',
  modulo = null,
  usuarioDestinoId = null,
  titulo,
  mensagem,
  entidade = null,
  entidadeId = null,
  dados = null
}) {
  const chaveNormalizada = limitar(chave, 190);
  const tipoNormalizado = limitar(tipo, 60);
  const tituloNormalizado = limitar(titulo, 160);
  const mensagemNormalizada = limitar(mensagem, 500);
  const nivelNormalizado = ['INFO', 'ATENCAO', 'CRITICA'].includes(nivel)
    ? nivel
    : 'INFO';
  if (!chaveNormalizada || !tipoNormalizado || !tituloNormalizado ||
      !mensagemNormalizada) {
    throw new Error('Notificação interna incompleta');
  }
  const [resultado] = await connection.query(
    `INSERT INTO notificacoes
       (chave, tipo, nivel, modulo, usuario_destino_id, titulo,
        mensagem, entidade, entidade_id, dados, status, resolvido_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ATIVA', NULL)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       tipo = VALUES(tipo),
       nivel = VALUES(nivel),
       modulo = VALUES(modulo),
       usuario_destino_id = VALUES(usuario_destino_id),
       titulo = VALUES(titulo),
       mensagem = VALUES(mensagem),
       entidade = VALUES(entidade),
       entidade_id = VALUES(entidade_id),
       dados = VALUES(dados),
       status = 'ATIVA',
       resolvido_em = NULL,
       atualizado_em = NOW()`,
    [
      chaveNormalizada,
      tipoNormalizado,
      nivelNormalizado,
      modulo ? limitar(modulo, 60) : null,
      usuarioDestinoId || null,
      tituloNormalizado,
      mensagemNormalizada,
      entidade ? limitar(entidade, 80) : null,
      entidadeId === null ? null : limitar(entidadeId, 80),
      dados ? JSON.stringify(dados) : null
    ]
  );
  const notificacaoId = Number(resultado.insertId);
  await connection.query(
    'DELETE FROM notificacao_leituras WHERE notificacao_id = ?',
    [notificacaoId]
  );
  return { id: notificacaoId, chave: chaveNormalizada, status: 'ATIVA' };
}

async function resolverNotificacao(connection, chave) {
  const [resultado] = await connection.query(
    `UPDATE notificacoes
        SET status = 'RESOLVIDA', resolvido_em = NOW()
      WHERE chave = ? AND status = 'ATIVA'`,
    [limitar(chave, 190)]
  );
  return Number(resultado.affectedRows || 0) > 0;
}

module.exports = { registrarNotificacao, resolverNotificacao };
