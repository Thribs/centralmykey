module.exports = function(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  const texto = valor => {
    if (valor === undefined || valor === null) return null;
    const resultado = String(valor).trim();
    return resultado || null;
  };

  // ============================================================
  // FORNECEDORES
  // ============================================================

  app.get(
    '/api/fornecedores-resumo',
    autenticarToken,
    exigirPermissao('FORNECEDORES', 'visualizar'),
    async (req, res) => {
      try {
        const [rows] = await pool.query(`
          SELECT
            COUNT(*) AS total,
            SUM(ativo = 1) AS ativos,
            SUM(ativo = 0) AS bloqueados,
            SUM(tipo = 'PESSOA') AS pessoas,
            SUM(tipo = 'EMPRESA') AS empresas,
            SUM(tipo = 'API') AS apis,
            SUM(tipo = 'SISTEMA') AS sistemas
          FROM fornecedores
        `);

        return res.json({ ok: true, resumo: rows[0] });
      } catch (error) {
        console.error('Erro ao resumir fornecedores:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar resumo de fornecedores'
        });
      }
    }
  );

  app.get(
    '/api/fornecedores/:id',
    autenticarToken,
    exigirPermissao('FORNECEDORES', 'visualizar'),
    async (req, res) => {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Fornecedor inválido'
        });
      }

      try {
        const [rows] = await pool.query(`
          SELECT
            f.*,
            (
              SELECT COUNT(*)
              FROM pedidos_senha p
              WHERE p.fornecedor_id = f.id
            ) AS total_pedidos,
            (
              SELECT COUNT(*)
              FROM pedido_resultados pr
              WHERE pr.fornecedor_id = f.id
            ) AS total_resultados
          FROM fornecedores f
          WHERE f.id = ?
          LIMIT 1
        `, [id]);

        if (!rows.length) {
          return res.status(404).json({
            ok: false,
            error: 'Fornecedor não encontrado'
          });
        }

        return res.json({ ok: true, fornecedor: rows[0] });
      } catch (error) {
        console.error('Erro ao detalhar fornecedor:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao detalhar fornecedor'
        });
      }
    }
  );

  app.put(
    '/api/fornecedores/:id',
    autenticarToken,
    exigirPermissao('FORNECEDORES', 'editar'),
    async (req, res) => {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Fornecedor inválido'
        });
      }

      const nome = texto(req.body.nome);
      const tipo = ['PESSOA', 'EMPRESA', 'SISTEMA', 'API'].includes(
        req.body.tipo
      )
        ? req.body.tipo
        : 'PESSOA';

      if (!nome) {
        return res.status(400).json({
          ok: false,
          error: 'Nome do fornecedor é obrigatório'
        });
      }

      try {
        const [resultado] = await pool.query(`
          UPDATE fornecedores
          SET
            nome = ?,
            contato = ?,
            telefone = ?,
            whatsapp = ?,
            email = ?,
            tipo = ?,
            horario_inicio = ?,
            horario_fim = ?,
            observacoes = ?
          WHERE id = ?
        `, [
          nome,
          texto(req.body.contato),
          texto(req.body.telefone),
          texto(req.body.whatsapp),
          texto(req.body.email),
          tipo,
          texto(req.body.horario_inicio),
          texto(req.body.horario_fim),
          texto(req.body.observacoes),
          id
        ]);

        if (!resultado.affectedRows) {
          return res.status(404).json({
            ok: false,
            error: 'Fornecedor não encontrado'
          });
        }

        return res.json({
          ok: true,
          mensagem: 'Fornecedor atualizado com sucesso'
        });
      } catch (error) {
        console.error('Erro ao atualizar fornecedor:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao atualizar fornecedor'
        });
      }
    }
  );

  app.patch(
    '/api/fornecedores/:id/status',
    autenticarToken,
    exigirPermissao('FORNECEDORES', 'editar'),
    async (req, res) => {
      const id = Number(req.params.id);
      const ativo = Number(req.body.ativo);

      if (!Number.isInteger(id) || id <= 0 || ![0, 1].includes(ativo)) {
        return res.status(400).json({
          ok: false,
          error: 'Dados inválidos'
        });
      }

      try {
        const [resultado] = await pool.query(
          'UPDATE fornecedores SET ativo = ? WHERE id = ?',
          [ativo, id]
        );

        if (!resultado.affectedRows) {
          return res.status(404).json({
            ok: false,
            error: 'Fornecedor não encontrado'
          });
        }

        return res.json({
          ok: true,
          mensagem: ativo
            ? 'Fornecedor ativado com sucesso'
            : 'Fornecedor bloqueado com sucesso'
        });
      } catch (error) {
        console.error('Erro ao alterar fornecedor:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao alterar status do fornecedor'
        });
      }
    }
  );
};
