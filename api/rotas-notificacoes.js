'use strict';

function limite(valor) {
  const numero = Number(valor || 20);
  return Number.isInteger(numero) && numero >= 1 && numero <= 100
    ? numero
    : 20;
}

function condicaoVisibilidade(alias = 'n') {
  return `(
    (${alias}.usuario_destino_id IS NULL OR ${alias}.usuario_destino_id = ?)
    AND (
      ${alias}.modulo IS NULL OR EXISTS (
        SELECT 1
          FROM usuario_permissoes up
          INNER JOIN modulos m ON m.id = up.modulo_id
         WHERE up.usuario_id = ?
           AND m.codigo = ${alias}.modulo
           AND m.ativo = 1
           AND up.visualizar = 1
      )
    )
  )`;
}

module.exports = function (app, pool) {
  const autenticarToken = app.locals.autenticarToken;

  app.get('/api/notificacoes/resumo', autenticarToken, async (req, res) => {
    try {
      const [[resumo]] = await pool.query(
        `SELECT
           COUNT(*) AS nao_lidas,
           SUM(n.nivel = 'CRITICA') AS criticas
         FROM notificacoes n
         LEFT JOIN notificacao_leituras nl
           ON nl.notificacao_id = n.id AND nl.usuario_id = ?
        WHERE n.status = 'ATIVA'
          AND nl.notificacao_id IS NULL
          AND ${condicaoVisibilidade('n')}`,
        [req.usuario.id, req.usuario.id, req.usuario.id]
      );
      return res.json({
        ok: true,
        nao_lidas: Number(resumo.nao_lidas || 0),
        criticas: Number(resumo.criticas || 0)
      });
    } catch (error) {
      console.error('Erro ao resumir notificações:', error);
      return res.status(500).json({ ok: false, error: 'Erro ao consultar notificações' });
    }
  });

  app.get('/api/notificacoes', autenticarToken, async (req, res) => {
    const apenasNaoLidas = String(req.query.nao_lidas || '') === '1';
    const quantidade = limite(req.query.limite);
    try {
      const parametros = [req.usuario.id, req.usuario.id, req.usuario.id];
      const filtroLeitura = apenasNaoLidas ? 'AND nl.notificacao_id IS NULL' : '';
      const [dados] = await pool.query(
        `SELECT
           n.id, n.tipo, n.nivel, n.modulo, n.titulo, n.mensagem,
           n.entidade, n.entidade_id, n.dados, n.status,
           n.criado_em, n.atualizado_em,
           IF(nl.notificacao_id IS NULL, 0, 1) AS lida
         FROM notificacoes n
         LEFT JOIN notificacao_leituras nl
           ON nl.notificacao_id = n.id AND nl.usuario_id = ?
        WHERE n.status = 'ATIVA'
          AND ${condicaoVisibilidade('n')}
          ${filtroLeitura}
        ORDER BY
          FIELD(n.nivel, 'CRITICA', 'ATENCAO', 'INFO'),
          n.atualizado_em DESC, n.id DESC
        LIMIT ${quantidade}`,
        parametros
      );
      return res.json({ ok: true, total: dados.length, dados });
    } catch (error) {
      console.error('Erro ao listar notificações:', error);
      return res.status(500).json({ ok: false, error: 'Erro ao consultar notificações' });
    }
  });

  app.patch('/api/notificacoes/:id/ler', autenticarToken, async (req, res) => {
    const notificacaoId = Number(req.params.id);
    if (!Number.isInteger(notificacaoId) || notificacaoId <= 0) {
      return res.status(400).json({ ok: false, error: 'Notificação inválida' });
    }
    try {
      const [[notificacao]] = await pool.query(
        `SELECT n.id
           FROM notificacoes n
          WHERE n.id = ? AND n.status = 'ATIVA'
            AND ${condicaoVisibilidade('n')}
          LIMIT 1`,
        [notificacaoId, req.usuario.id, req.usuario.id]
      );
      if (!notificacao) {
        return res.status(404).json({ ok: false, error: 'Notificação não encontrada' });
      }
      await pool.query(
        `INSERT INTO notificacao_leituras (notificacao_id, usuario_id, lida_em)
         VALUES (?, ?, NOW())
         ON DUPLICATE KEY UPDATE lida_em = VALUES(lida_em)`,
        [notificacaoId, req.usuario.id]
      );
      return res.json({ ok: true, notificacao_id: notificacaoId, lida: true });
    } catch (error) {
      console.error('Erro ao marcar notificação como lida:', error);
      return res.status(500).json({ ok: false, error: 'Erro ao atualizar notificação' });
    }
  });

  app.post('/api/notificacoes/ler-todas', autenticarToken, async (req, res) => {
    try {
      const [resultado] = await pool.query(
        `INSERT INTO notificacao_leituras (notificacao_id, usuario_id, lida_em)
         SELECT n.id, ?, NOW()
           FROM notificacoes n
          WHERE n.status = 'ATIVA'
            AND ${condicaoVisibilidade('n')}
         ON DUPLICATE KEY UPDATE lida_em = VALUES(lida_em)`,
        [req.usuario.id, req.usuario.id, req.usuario.id]
      );
      return res.json({
        ok: true,
        atualizadas: Number(resultado.affectedRows || 0)
      });
    } catch (error) {
      console.error('Erro ao marcar todas as notificações:', error);
      return res.status(500).json({ ok: false, error: 'Erro ao atualizar notificações' });
    }
  });
};
