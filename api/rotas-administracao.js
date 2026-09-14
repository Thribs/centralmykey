module.exports = function(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  const texto = valor => {
    if (valor === undefined || valor === null) return null;
    const resultado = String(valor).trim();
    return resultado || null;
  };

  const chaveSensivel = chave =>
    /(TOKEN|SECRET|PASSWORD|SENHA|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i
      .test(chave);

  // ============================================================
  // USUÁRIOS
  // ============================================================

  app.get(
    '/api/usuarios-resumo',
    autenticarToken,
    exigirPermissao('USUARIOS', 'visualizar'),
    async (req, res) => {
      try {
        const [rows] = await pool.query(`
          SELECT
            COUNT(*) AS total,
            SUM(status = 'ATIVO') AS ativos,
            SUM(status = 'INATIVO') AS inativos,
            SUM(status = 'BLOQUEADO') AS bloqueados,
            SUM(senha_provisoria = 1) AS senha_provisoria,
            SUM(ultimo_login IS NOT NULL) AS ja_acessaram
          FROM usuarios
        `);

        return res.json({ ok: true, resumo: rows[0] });
      } catch (error) {
        console.error('Erro ao resumir usuários:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar resumo de usuários'
        });
      }
    }
  );

  app.put(
    '/api/usuarios/:id',
    autenticarToken,
    exigirPermissao('USUARIOS', 'editar'),
    async (req, res) => {
      const id = Number(req.params.id);
      const nome = texto(req.body.nome);
      const login = texto(req.body.login)?.toLowerCase();
      const perfilId = Number(req.body.perfil_id);

      if (
        !Number.isInteger(id) ||
        id <= 0 ||
        !nome ||
        !login ||
        login.length < 3 ||
        !Number.isInteger(perfilId) ||
        perfilId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Nome, login e perfil são obrigatórios'
        });
      }

      try {
        const [perfil] = await pool.query(`
          SELECT id
          FROM perfis
          WHERE id = ? AND ativo = 1
          LIMIT 1
        `, [perfilId]);

        if (!perfil.length) {
          return res.status(400).json({
            ok: false,
            error: 'Perfil inválido'
          });
        }

        const [resultado] = await pool.query(`
          UPDATE usuarios
          SET
            nome = ?,
            email = ?,
            telefone = ?,
            login = ?,
            perfil_id = ?
          WHERE id = ?
        `, [
          nome,
          texto(req.body.email)?.toLowerCase() || null,
          texto(req.body.telefone),
          login,
          perfilId,
          id
        ]);

        if (!resultado.affectedRows) {
          return res.status(404).json({
            ok: false,
            error: 'Usuário não encontrado'
          });
        }

        return res.json({
          ok: true,
          mensagem: 'Usuário atualizado com sucesso'
        });
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({
            ok: false,
            error: 'Login ou e-mail já utilizado'
          });
        }

        console.error('Erro ao atualizar usuário:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao atualizar usuário'
        });
      }
    }
  );

  app.patch(
    '/api/usuarios/:id/status',
    autenticarToken,
    exigirPermissao('USUARIOS', 'editar'),
    async (req, res) => {
      const id = Number(req.params.id);
      const status = String(req.body.status || '').toUpperCase();

      if (
        !Number.isInteger(id) ||
        id <= 0 ||
        !['ATIVO', 'INATIVO', 'BLOQUEADO'].includes(status)
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Usuário ou status inválido'
        });
      }

      if (id === Number(req.usuario.id) && status !== 'ATIVO') {
        return res.status(409).json({
          ok: false,
          error: 'Você não pode bloquear ou inativar seu próprio usuário'
        });
      }

      try {
        const [resultado] = await pool.query(
          'UPDATE usuarios SET status = ? WHERE id = ?',
          [status, id]
        );

        if (!resultado.affectedRows) {
          return res.status(404).json({
            ok: false,
            error: 'Usuário não encontrado'
          });
        }

        return res.json({
          ok: true,
          mensagem: 'Status do usuário atualizado'
        });
      } catch (error) {
        console.error('Erro ao alterar usuário:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao alterar status do usuário'
        });
      }
    }
  );

  app.get(
    '/api/usuarios/:id/permissoes',
    autenticarToken,
    exigirPermissao('USUARIOS', 'visualizar'),
    async (req, res) => {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Usuário inválido'
        });
      }

      try {
        const [usuarios] = await pool.query(`
          SELECT id, nome, perfil_id
          FROM usuarios
          WHERE id = ?
          LIMIT 1
        `, [id]);

        if (!usuarios.length) {
          return res.status(404).json({
            ok: false,
            error: 'Usuário não encontrado'
          });
        }

        const [permissoes] = await pool.query(`
          SELECT
            m.id AS modulo_id,
            m.codigo,
            m.nome,
            COALESCE(up.visualizar, 0) AS visualizar,
            COALESCE(up.criar, 0) AS criar,
            COALESCE(up.editar, 0) AS editar,
            COALESCE(up.excluir, 0) AS excluir,
            COALESCE(up.aprovar, 0) AS aprovar
          FROM modulos m
          LEFT JOIN usuario_permissoes up
            ON up.modulo_id = m.id
           AND up.usuario_id = ?
          WHERE m.ativo = 1
          ORDER BY m.id
        `, [id]);

        return res.json({
          ok: true,
          usuario: usuarios[0],
          permissoes
        });
      } catch (error) {
        console.error('Erro ao listar permissões:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar permissões'
        });
      }
    }
  );

  app.put(
    '/api/usuarios/:id/permissoes',
    autenticarToken,
    exigirPermissao('USUARIOS', 'editar'),
    async (req, res) => {
      const id = Number(req.params.id);
      const permissoes = Array.isArray(req.body.permissoes)
        ? req.body.permissoes
        : null;

      if (!Number.isInteger(id) || id <= 0 || !permissoes) {
        return res.status(400).json({
          ok: false,
          error: 'Usuário ou permissões inválidas'
        });
      }

      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        const [usuario] = await connection.query(
          'SELECT id FROM usuarios WHERE id = ? LIMIT 1 FOR UPDATE',
          [id]
        );

        if (!usuario.length) {
          await connection.rollback();
          return res.status(404).json({
            ok: false,
            error: 'Usuário não encontrado'
          });
        }

        await connection.query(
          'DELETE FROM usuario_permissoes WHERE usuario_id = ?',
          [id]
        );

        for (const item of permissoes) {
          const moduloId = Number(item.modulo_id);

          if (!Number.isInteger(moduloId) || moduloId <= 0) continue;

          await connection.query(`
            INSERT INTO usuario_permissoes (
              usuario_id,
              modulo_id,
              visualizar,
              criar,
              editar,
              excluir,
              aprovar
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `, [
            id,
            moduloId,
            item.visualizar ? 1 : 0,
            item.criar ? 1 : 0,
            item.editar ? 1 : 0,
            item.excluir ? 1 : 0,
            item.aprovar ? 1 : 0
          ]);
        }

        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Permissões atualizadas com sucesso'
        });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar permissões:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao atualizar permissões'
        });
      } finally {
        connection.release();
      }
    }
  );

  // ============================================================
  // CONFIGURAÇÕES SEGURAS E INTEGRAÇÕES
  // ============================================================

  app.get(
    '/api/configuracoes-seguras',
    autenticarToken,
    exigirPermissao('CONFIGURACOES', 'visualizar'),
    async (req, res) => {
      try {
        const [dados] = await pool.query(`
          SELECT id, chave, valor, descricao, atualizado_em
          FROM configuracoes
          ORDER BY chave
        `);

        return res.json({
          ok: true,
          total: dados.length,
          dados: dados.map(item => ({
            id: item.id,
            chave: item.chave,
            valor: chaveSensivel(item.chave)
              ? (item.valor ? '••••••••' : '')
              : item.valor,
            configurado: Boolean(item.valor),
            sensivel: chaveSensivel(item.chave),
            descricao: item.descricao,
            atualizado_em: item.atualizado_em
          }))
        });
      } catch (error) {
        console.error('Erro ao listar configurações:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar configurações'
        });
      }
    }
  );

  app.put(
    '/api/configuracoes/:chave',
    autenticarToken,
    exigirPermissao('CONFIGURACOES', 'editar'),
    async (req, res) => {
      const chave = String(req.params.chave || '').trim().toUpperCase();
      const valor = req.body.valor === undefined
        ? null
        : String(req.body.valor).trim();
      const descricao = texto(req.body.descricao);

      if (!/^[A-Z0-9_.-]{2,120}$/.test(chave)) {
        return res.status(400).json({
          ok: false,
          error: 'Chave de configuração inválida'
        });
      }

      if (chaveSensivel(chave) && !valor) {
        return res.status(400).json({
          ok: false,
          error: 'Informe o novo valor sensível'
        });
      }

      try {
        await pool.query(`
          INSERT INTO configuracoes (chave, valor, descricao)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE
            valor = VALUES(valor),
            descricao = COALESCE(VALUES(descricao), descricao)
        `, [chave, valor, descricao]);

        return res.json({
          ok: true,
          mensagem: 'Configuração salva com sucesso'
        });
      } catch (error) {
        console.error('Erro ao salvar configuração:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao salvar configuração'
        });
      }
    }
  );

  app.get(
    '/api/integracoes/resumo',
    autenticarToken,
    exigirPermissao('CONFIGURACOES', 'visualizar'),
    async (req, res) => {
      try {
        const [configuracoes] = await pool.query(`
          SELECT chave, valor
          FROM configuracoes
        `);

        const mapa = Object.fromEntries(
          configuracoes.map(item => [item.chave, Boolean(item.valor)])
        );

        const [modelos] = await pool.query(`
          SELECT
            COUNT(*) AS total,
            SUM(status = 'APROVADO') AS aprovados,
            SUM(status = 'PENDENTE') AS pendentes,
            SUM(ativo = 1) AS ativos
          FROM whatsapp_modelos
        `);

        const grupos = [
          {
            codigo: 'WHATSAPP',
            nome: 'WhatsApp Cloud API',
            configurado: Boolean(
              mapa.WHATSAPP_ACCESS_TOKEN ||
              mapa.META_ACCESS_TOKEN
            )
          },
          {
            codigo: 'SICOOB',
            nome: 'Sicoob',
            configurado: Boolean(
              mapa.SICOOB_CLIENT_ID &&
              mapa.SICOOB_CLIENT_SECRET
            )
          },
          {
            codigo: 'PLUGPAY',
            nome: 'PlugPay',
            configurado: Boolean(
              mapa.PLUGPAY_TOKEN ||
              mapa.PLUGPAY_API_KEY
            )
          },
          {
            codigo: 'WBUY',
            nome: 'WBuy',
            configurado: Boolean(
              mapa.WBUY_TOKEN ||
              mapa.WBUY_API_KEY
            )
          }
        ];

        return res.json({
          ok: true,
          integracoes: grupos,
          modelos_whatsapp: modelos[0]
        });
      } catch (error) {
        console.error('Erro ao resumir integrações:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar integrações'
        });
      }
    }
  );
};
