const {
  carregarConfiguracoesIntegracoes,
  diagnosticarProntidaoWhatsapp,
  resumirIntegracoes
} = require('./configuracoes-integracoes');
const {
  chaveSensivel,
  mascararConfiguracao
} = require('./seguranca-configuracoes');

module.exports = function(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  const texto = valor => {
    if (valor === undefined || valor === null) return null;
    const resultado = String(valor).trim();
    return resultado || null;
  };

  const registrarAuditoriaUsuario = async (
    connection,
    req,
    { acao, usuarioId, descricao, antes, depois }
  ) => {
    await connection.query(`
      INSERT INTO auditoria
        (usuario_id, modulo, acao, entidade, entidade_id, descricao,
         dados_antes, dados_depois, ip)
      VALUES (?, 'USUARIOS', ?, 'usuarios', ?, ?, ?, ?, ?)
    `, [req.usuario?.id || null, acao, String(usuarioId), descricao,
      antes ? JSON.stringify(antes) : null,
      depois ? JSON.stringify(depois) : null,
      req.ip || null]);
  };

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

      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [perfil] = await connection.query(`
          SELECT id
          FROM perfis
          WHERE id = ? AND ativo = 1
          LIMIT 1
        `, [perfilId]);

        if (!perfil.length) {
          await connection.rollback();
          return res.status(400).json({
            ok: false,
            error: 'Perfil inválido'
          });
        }

        const [atuais] = await connection.query(`
          SELECT id, nome, email, telefone, login, perfil_id, status,
                 senha_provisoria
            FROM usuarios
           WHERE id = ? LIMIT 1 FOR UPDATE
        `, [id]);
        if (!atuais.length) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Usuário não encontrado' });
        }

        const depois = {
          ...atuais[0],
          nome,
          email: texto(req.body.email)?.toLowerCase() || null,
          telefone: texto(req.body.telefone),
          login,
          perfil_id: perfilId
        };
        await connection.query(`
          UPDATE usuarios
          SET
            nome = ?,
            email = ?,
            telefone = ?,
            login = ?,
            perfil_id = ?
          WHERE id = ?
        `, [depois.nome, depois.email, depois.telefone, depois.login,
          depois.perfil_id, id]);
        await registrarAuditoriaUsuario(connection, req, {
          acao: 'EDITAR',
          usuarioId: id,
          descricao: 'Cadastro do usuário atualizado',
          antes: atuais[0],
          depois
        });
        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Usuário atualizado com sucesso'
        });
      } catch (error) {
        if (connection) await connection.rollback();
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
      } finally {
        connection?.release();
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

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [atuais] = await connection.query(
          `SELECT id, nome, login, status FROM usuarios
            WHERE id = ? LIMIT 1 FOR UPDATE`,
          [id]
        );
        if (!atuais.length) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Usuário não encontrado' });
        }
        await connection.query(
          'UPDATE usuarios SET status = ? WHERE id = ?',
          [status, id]
        );
        await registrarAuditoriaUsuario(connection, req, {
          acao: 'ALTERAR_STATUS',
          usuarioId: id,
          descricao: `Status do usuário alterado para ${status}`,
          antes: atuais[0],
          depois: { ...atuais[0], status }
        });
        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Status do usuário atualizado'
        });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao alterar usuário:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao alterar status do usuário'
        });
      } finally {
        connection.release();
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

      const moduloIds = permissoes.map(item => Number(item.modulo_id));
      if (
        moduloIds.some(moduloId => !Number.isInteger(moduloId) || moduloId <= 0) ||
        new Set(moduloIds).size !== moduloIds.length
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Módulos de permissão inválidos ou duplicados'
        });
      }

      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        const [usuario] = await connection.query(
          `SELECT id, nome, login, perfil_id, status
             FROM usuarios WHERE id = ? LIMIT 1 FOR UPDATE`,
          [id]
        );

        if (!usuario.length) {
          await connection.rollback();
          return res.status(404).json({
            ok: false,
            error: 'Usuário não encontrado'
          });
        }

        if (moduloIds.length) {
          const marcadores = moduloIds.map(() => '?').join(',');
          const [modulos] = await connection.query(
            `SELECT id FROM modulos WHERE ativo = 1 AND id IN (${marcadores})`,
            moduloIds
          );
          if (modulos.length !== moduloIds.length) {
            await connection.rollback();
            return res.status(400).json({
              ok: false,
              error: 'Um ou mais módulos são inválidos ou inativos'
            });
          }
        }

        const [permissoesAntes] = await connection.query(`
          SELECT modulo_id, visualizar, criar, editar, excluir, aprovar
            FROM usuario_permissoes
           WHERE usuario_id = ?
           ORDER BY modulo_id
        `, [id]);

        await connection.query(
          'DELETE FROM usuario_permissoes WHERE usuario_id = ?',
          [id]
        );

        for (const item of permissoes) {
          const moduloId = Number(item.modulo_id);

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

        const permissoesDepois = permissoes.map(item => ({
          modulo_id: Number(item.modulo_id),
          visualizar: item.visualizar ? 1 : 0,
          criar: item.criar ? 1 : 0,
          editar: item.editar ? 1 : 0,
          excluir: item.excluir ? 1 : 0,
          aprovar: item.aprovar ? 1 : 0
        })).sort((a, b) => a.modulo_id - b.modulo_id);
        await registrarAuditoriaUsuario(connection, req, {
          acao: 'ALTERAR_PERMISSOES',
          usuarioId: id,
          descricao: 'Permissões individuais do usuário atualizadas',
          antes: { usuario: usuario[0], permissoes: permissoesAntes },
          depois: { usuario: usuario[0], permissoes: permissoesDepois }
        });

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
          dados: dados.map(mascararConfiguracao)
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

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[atual]] = await connection.query(
          `SELECT chave, valor, descricao
             FROM configuracoes
            WHERE chave = ?
            LIMIT 1 FOR UPDATE`,
          [chave]
        );
        await connection.query(`
          INSERT INTO configuracoes (chave, valor, descricao)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE
            valor = VALUES(valor),
            descricao = COALESCE(VALUES(descricao), descricao)
        `, [chave, valor, descricao]);
        const resumoAntes = atual ? {
          chave,
          configurado: Boolean(atual.valor),
          descricao: atual.descricao || null
        } : null;
        const resumoDepois = {
          chave,
          configurado: Boolean(valor),
          descricao: descricao || atual?.descricao || null
        };
        await connection.query(
          `INSERT INTO auditoria
             (usuario_id, modulo, acao, entidade, entidade_id, descricao,
              dados_antes, dados_depois, ip)
           VALUES (?, 'CONFIGURACOES', 'ALTERAR_CONFIGURACAO',
                   'configuracoes', ?, ?, ?, ?, ?)`,
          [
            req.usuario.id,
            chave,
            `Configuração ${chave} atualizada`,
            resumoAntes ? JSON.stringify(resumoAntes) : null,
            JSON.stringify(resumoDepois),
            req.ip || null
          ]
        );
        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Configuração salva com sucesso'
        });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao salvar configuração:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao salvar configuração'
        });
      } finally {
        connection.release();
      }
    }
  );

  app.get(
    '/api/integracoes/resumo',
    autenticarToken,
    exigirPermissao('INTEGRACOES', 'visualizar'),
    async (req, res) => {
      try {
        const configuracoes = await carregarConfiguracoesIntegracoes(pool);
        const grupos = resumirIntegracoes(configuracoes);
        const prontidaoWhatsapp = await diagnosticarProntidaoWhatsapp(
          pool, configuracoes
        );

        const [modelos] = await pool.query(`
          SELECT
            COUNT(*) AS total,
            SUM(status = 'APROVADO') AS aprovados,
            SUM(status = 'PENDENTE') AS pendentes,
            SUM(ativo = 1) AS ativos
          FROM whatsapp_modelos
        `);

        return res.json({
          ok: true,
          integracoes: grupos,
          modelos_whatsapp: modelos[0],
          prontidao_whatsapp: prontidaoWhatsapp
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
