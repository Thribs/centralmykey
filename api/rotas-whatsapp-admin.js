module.exports = function (app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  const categorias = new Set([
    'UTILIDADE',
    'MARKETING',
    'AUTENTICACAO'
  ]);

  const statusPermitidos = new Set([
    'PENDENTE',
    'APROVADO',
    'REJEITADO',
    'PAUSADO',
    'DESATIVADO'
  ]);

  // ============================================================
  // LISTAR TODOS OS MODELOS
  // ============================================================

  app.get(
    '/api/whatsapp/modelos',
    autenticarToken,
    exigirPermissao('CONFIGURACOES', 'visualizar'),
    async (req, res) => {
      try {
        const [modelos] = await pool.query(
          `SELECT
             id,
             nome,
             idioma,
             categoria,
             status,
             componentes_json,
             ativo,
             criado_em,
             atualizado_em
           FROM whatsapp_modelos
           ORDER BY nome ASC, idioma ASC`
        );

        return res.json({
          ok: true,
          total: modelos.length,
          dados: modelos
        });
      } catch (error) {
        console.error('Erro ao listar modelos:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao listar modelos do WhatsApp'
        });
      }
    }
  );

  // ============================================================
  // CADASTRAR MODELO PARA ACOMPANHAMENTO
  // ============================================================

  app.post(
    '/api/whatsapp/modelos',
    autenticarToken,
    exigirPermissao('CONFIGURACOES', 'editar'),
    async (req, res) => {
      const nome = String(req.body?.nome || '').trim();
      const idioma = String(req.body?.idioma || 'pt_BR').trim();
      const categoria = String(
        req.body?.categoria || 'UTILIDADE'
      ).toUpperCase();

      const componentes =
        req.body?.componentes === undefined
          ? null
          : req.body.componentes;

      if (
        !/^[a-z0-9_]{1,512}$/.test(nome) ||
        !/^[a-zA-Z]{2,3}(?:_[a-zA-Z]{2})?$/.test(idioma) ||
        !categorias.has(categoria)
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Nome, idioma ou categoria inválido'
        });
      }

      let componentesJson = null;

      if (componentes !== null) {
        try {
          componentesJson = JSON.stringify(componentes);
        } catch {
          return res.status(400).json({
            ok: false,
            error: 'Componentes do modelo inválidos'
          });
        }

        if (componentesJson.length > 20000) {
          return res.status(400).json({
            ok: false,
            error: 'Componentes do modelo excedem o limite'
          });
        }
      }

      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        const [resultado] = await connection.query(
          `INSERT INTO whatsapp_modelos
             (nome, idioma, categoria, status,
              componentes_json, ativo)
           VALUES (?, ?, ?, 'PENDENTE', ?, 0)`,
          [nome, idioma, categoria, componentesJson]
        );

        await connection.query(
          `INSERT INTO auditoria
             (usuario_id, modulo, acao, entidade, entidade_id,
              descricao, dados_antes, dados_depois, ip)
           VALUES (?, 'CONFIGURACOES', 'CADASTRAR_MODELO_WHATSAPP',
                   'whatsapp_modelos', ?, ?, NULL, ?, ?)`,
          [
            req.usuario.id,
            String(resultado.insertId),
            `Modelo WhatsApp ${nome} cadastrado como pendente`,
            JSON.stringify({
              nome,
              idioma,
              categoria,
              status: 'PENDENTE',
              ativo: false
            }),
            req.ip || null
          ]
        );

        await connection.commit();

        return res.status(201).json({
          ok: true,
          mensagem: 'Modelo cadastrado como pendente',
          modelo_id: resultado.insertId
        });
      } catch (error) {
        await connection.rollback();

        if (error.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({
            ok: false,
            error: 'Este modelo e idioma já estão cadastrados'
          });
        }

        console.error('Erro ao cadastrar modelo:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao cadastrar modelo do WhatsApp'
        });
      } finally {
        connection.release();
      }
    }
  );

  // ============================================================
  // ATUALIZAR APROVAÇÃO E ATIVAÇÃO DO MODELO
  // ============================================================

  app.patch(
    '/api/whatsapp/modelos/:id/status',
    autenticarToken,
    exigirPermissao('CONFIGURACOES', 'editar'),
    async (req, res) => {
      const modeloId = Number(req.params.id);
      const status = String(req.body?.status || '').toUpperCase();
      const ativoSolicitado =
        req.body?.ativo === true ||
        req.body?.ativo === 1;

      if (
        !Number.isInteger(modeloId) ||
        modeloId <= 0 ||
        !statusPermitidos.has(status)
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Modelo ou status inválido'
        });
      }

      const ativo =
        status === 'APROVADO' && ativoSolicitado ? 1 : 0;

      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        const [modelos] = await connection.query(
          `SELECT id, nome, idioma, categoria, status, ativo
           FROM whatsapp_modelos
           WHERE id = ?
           LIMIT 1
           FOR UPDATE`,
          [modeloId]
        );

        if (!modelos.length) {
          await connection.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Modelo não encontrado'
          });
        }

        const anterior = modelos[0];

        await connection.query(
          `UPDATE whatsapp_modelos
           SET status = ?, ativo = ?
           WHERE id = ?`,
          [status, ativo, modeloId]
        );

        await connection.query(
          `INSERT INTO auditoria
             (usuario_id, modulo, acao, entidade, entidade_id,
              descricao, dados_antes, dados_depois, ip)
           VALUES (?, 'CONFIGURACOES', 'ATUALIZAR_MODELO_WHATSAPP',
                   'whatsapp_modelos', ?, ?, ?, ?, ?)`,
          [
            req.usuario.id,
            String(modeloId),
            `Status do modelo WhatsApp ${anterior.nome} atualizado`,
            JSON.stringify(anterior),
            JSON.stringify({
              ...anterior,
              status,
              ativo: Boolean(ativo)
            }),
            req.ip || null
          ]
        );

        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Modelo atualizado com sucesso',
          modelo: {
            id: modeloId,
            status,
            ativo: Boolean(ativo)
          }
        });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar modelo:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao atualizar modelo do WhatsApp'
        });
      } finally {
        connection.release();
      }
    }
  );
};
