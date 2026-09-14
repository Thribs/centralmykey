const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function (app, pool) {
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error('JWT_SECRET não configurado');
  }

  async function autenticarToken(req, res, next) {
    try {
      const authorization = req.headers.authorization || '';

      if (!authorization.startsWith('Bearer ')) {
        return res.status(401).json({
          ok: false,
          error: 'Token de acesso não informado'
        });
      }

      const token = authorization.slice(7).trim();

      if (!token) {
        return res.status(401).json({
          ok: false,
          error: 'Token de acesso não informado'
        });
      }

      const payload = jwt.verify(token, jwtSecret);

      const [usuarios] = await pool.query(
        `SELECT
           u.id,
           u.nome,
           u.email,
           u.telefone,
           u.login,
           u.perfil_id,
           p.nome AS perfil,
           u.status,
           u.senha_provisoria
         FROM usuarios u
         LEFT JOIN perfis p
           ON p.id = u.perfil_id
         WHERE u.id = ?
           AND u.status = 'ATIVO'
         LIMIT 1`,
        [payload.id]
      );

      if (!usuarios.length) {
        return res.status(401).json({
          ok: false,
          error: 'Usuário inválido ou inativo'
        });
      }

      req.usuario = usuarios[0];

      const rotasPermitidasDuranteTroca = new Set([
        '/api/auth/me',
        '/api/auth/trocar-senha'
      ]);

      if (
        Number(req.usuario.senha_provisoria) === 1 &&
        !rotasPermitidasDuranteTroca.has(req.path)
      ) {
        return res.status(403).json({
          ok: false,
          error: 'Troca de senha obrigatória',
          codigo: 'TROCA_SENHA_OBRIGATORIA'
        });
      }

      next();

    } catch (error) {
      return res.status(401).json({
        ok: false,
        error: 'Token inválido ou expirado'
      });
    }
  }

  app.locals.autenticarToken = autenticarToken;

  const acoesPermitidas = new Set([
    'visualizar',
    'criar',
    'editar',
    'excluir',
    'aprovar'
  ]);

  function exigirPermissao(moduloCodigo, acao = 'visualizar') {
    if (!acoesPermitidas.has(acao)) {
      throw new Error(`Ação de permissão inválida: ${acao}`);
    }

    return async function (req, res, next) {
      try {
        if (!req.usuario || !req.usuario.id) {
          return res.status(401).json({
            ok: false,
            error: 'Usuário não autenticado'
          });
        }

        const [permissoes] = await pool.query(
          `SELECT up.id
           FROM usuario_permissoes up
           INNER JOIN modulos m
             ON m.id = up.modulo_id
           WHERE up.usuario_id = ?
             AND m.codigo = ?
             AND m.ativo = 1
             AND up.${acao} = 1
           LIMIT 1`,
          [req.usuario.id, moduloCodigo]
        );

        if (!permissoes.length) {
          return res.status(403).json({
            ok: false,
            error: 'Usuário sem permissão para esta operação'
          });
        }

        next();

      } catch (error) {
        console.error('Erro ao verificar permissão:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao verificar permissão'
        });
      }
    };
  }

  app.locals.exigirPermissao = exigirPermissao;

  // ============================================================
  // CRIAR PRIMEIRO ADMINISTRADOR
  // ============================================================

  app.post('/api/auth/bootstrap', async (req, res) => {
    try {
      const {
        nome,
        email,
        telefone,
        login,
        senha
      } = req.body;

      const [contagem] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM usuarios`
      );

      if (Number(contagem[0].total) > 0) {
        return res.status(409).json({
          ok: false,
          error: 'Administrador inicial já foi criado'
        });
      }

      if (!nome || !login || !senha) {
        return res.status(400).json({
          ok: false,
          error: 'Nome, login e senha são obrigatórios'
        });
      }

      const loginNormalizado = String(login)
        .trim()
        .toLowerCase();

      if (loginNormalizado.length < 3) {
        return res.status(400).json({
          ok: false,
          error: 'O login deve possuir pelo menos 3 caracteres'
        });
      }

      if (String(senha).length < 8) {
        return res.status(400).json({
          ok: false,
          error: 'A senha deve possuir pelo menos 8 caracteres'
        });
      }

      const senhaHash = await bcrypt.hash(String(senha), 12);

      const [resultado] = await pool.query(
        `INSERT INTO usuarios (
          nome,
          email,
          telefone,
          login,
          senha_hash,
          perfil_id,
          status
        )
        VALUES (?, ?, ?, ?, ?, 1, 'ATIVO')`,
        [
          String(nome).trim(),
          email ? String(email).trim().toLowerCase() : null,
          telefone ? String(telefone).trim() : null,
          loginNormalizado,
          senhaHash
        ]
      );

      return res.status(201).json({
        ok: true,
        message: 'Administrador inicial criado com sucesso',
        usuario: {
          id: resultado.insertId,
          nome: String(nome).trim(),
          login: loginNormalizado,
          perfil_id: 1,
          perfil: 'Administrador'
        }
      });

    } catch (error) {
      if (error && error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          ok: false,
          error: 'Login ou e-mail já cadastrado'
        });
      }

      console.error('Erro ao criar administrador inicial:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao criar administrador inicial'
      });
    }
  });

  // ============================================================
  // LOGIN
  // ============================================================

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { login, senha } = req.body;

      if (!login || !senha) {
        return res.status(400).json({
          ok: false,
          error: 'Login e senha são obrigatórios'
        });
      }

      const loginNormalizado = String(login)
        .trim()
        .toLowerCase();

      const [usuarios] = await pool.query(
        `SELECT
           u.id,
           u.nome,
           u.email,
           u.telefone,
           u.login,
           u.senha_hash,
           u.perfil_id,
           p.nome AS perfil,
           u.status,
           u.senha_provisoria
         FROM usuarios u
         LEFT JOIN perfis p
           ON p.id = u.perfil_id
         WHERE u.login = ?
         LIMIT 1`,
        [loginNormalizado]
      );

      if (!usuarios.length) {
        return res.status(401).json({
          ok: false,
          error: 'Login ou senha inválidos'
        });
      }

      const usuario = usuarios[0];

      if (usuario.status !== 'ATIVO') {
        return res.status(403).json({
          ok: false,
          error: 'Usuário inativo ou bloqueado'
        });
      }

      const senhaCorreta = await bcrypt.compare(
        String(senha),
        usuario.senha_hash
      );

      if (!senhaCorreta) {
        return res.status(401).json({
          ok: false,
          error: 'Login ou senha inválidos'
        });
      }

      const token = jwt.sign(
        {
          id: usuario.id,
          perfil_id: usuario.perfil_id
        },
        jwtSecret,
        {
          expiresIn: '12h',
          issuer: 'central-mykey-api'
        }
      );

      await pool.query(
        `UPDATE usuarios
         SET ultimo_login = NOW()
         WHERE id = ?`,
        [usuario.id]
      );

      return res.json({
        ok: true,
        message: 'Login realizado com sucesso',
        token,
        expira_em: '12h',
        usuario: {
          id: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          telefone: usuario.telefone,
          login: usuario.login,
          perfil_id: usuario.perfil_id,
          perfil: usuario.perfil,
          troca_senha_obrigatoria:
            Number(usuario.senha_provisoria) === 1
        }
      });

    } catch (error) {
      console.error('Erro ao realizar login:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao realizar login'
      });
    }
  });

  // ============================================================
  // TROCAR SENHA
  // ============================================================

  app.post(
    '/api/auth/trocar-senha',
    autenticarToken,
    async (req, res) => {
      const connection = await pool.getConnection();

      try {
        const { senha_atual, nova_senha } = req.body;

        if (!senha_atual || !nova_senha) {
          return res.status(400).json({
            ok: false,
            error: 'Senha atual e nova senha são obrigatórias'
          });
        }

        const novaSenha = String(nova_senha);

        if (
          novaSenha.length < 8 ||
          !/[A-Za-zÀ-ÿ]/.test(novaSenha) ||
          !/[0-9]/.test(novaSenha)
        ) {
          return res.status(400).json({
            ok: false,
            error:
              'A nova senha deve ter ao menos 8 caracteres, com letras e números'
          });
        }

        await connection.beginTransaction();

        const [usuarios] = await connection.query(
          `SELECT id, senha_hash, senha_provisoria
           FROM usuarios
           WHERE id = ?
             AND status = 'ATIVO'
           LIMIT 1
           FOR UPDATE`,
          [req.usuario.id]
        );

        if (!usuarios.length) {
          await connection.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Usuário não encontrado'
          });
        }

        const usuario = usuarios[0];

        const senhaAtualCorreta = await bcrypt.compare(
          String(senha_atual),
          usuario.senha_hash
        );

        if (!senhaAtualCorreta) {
          await connection.rollback();

          return res.status(401).json({
            ok: false,
            error: 'Senha atual incorreta'
          });
        }

        const senhaRepetida = await bcrypt.compare(
          novaSenha,
          usuario.senha_hash
        );

        if (senhaRepetida) {
          await connection.rollback();

          return res.status(400).json({
            ok: false,
            error: 'A nova senha deve ser diferente da senha atual'
          });
        }

        const novaSenhaHash = await bcrypt.hash(novaSenha, 12);

        await connection.query(
          `UPDATE usuarios
           SET
             senha_hash = ?,
             senha_provisoria = 0
           WHERE id = ?`,
          [novaSenhaHash, usuario.id]
        );

        await connection.query(
          `INSERT INTO auditoria (
             usuario_id,
             modulo,
             acao,
             entidade,
             entidade_id,
             descricao,
             dados_antes,
             dados_depois,
             ip
           )
           VALUES (
             ?,
             'USUARIOS',
             'TROCAR_SENHA',
             'usuarios',
             ?,
             'Senha alterada pelo próprio usuário',
             ?,
             ?,
             ?
           )`,
          [
            usuario.id,
            String(usuario.id),
            JSON.stringify({
              senha_provisoria:
                Number(usuario.senha_provisoria) === 1
            }),
            JSON.stringify({
              senha_provisoria: false
            }),
            req.ip || null
          ]
        );

        await connection.commit();

        const token = jwt.sign(
          {
            id: req.usuario.id,
            perfil_id: req.usuario.perfil_id
          },
          jwtSecret,
          {
            expiresIn: '12h',
            issuer: 'central-mykey-api'
          }
        );

        return res.json({
          ok: true,
          message: 'Senha alterada com sucesso',
          token,
          expira_em: '12h',
          troca_senha_obrigatoria: false
        });

      } catch (error) {
        await connection.rollback();

        console.error('Erro ao trocar senha:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao trocar senha'
        });

      } finally {
        connection.release();
      }
    }
  );

  // ============================================================
  // USUÁRIO CONECTADO
  // ============================================================

  app.get('/api/auth/me', autenticarToken, async (req, res) => {
    try {
      const [permissoes] = await pool.query(
        `SELECT
           m.codigo,
           m.nome AS modulo,
           up.visualizar,
           up.criar,
           up.editar,
           up.excluir,
           up.aprovar
         FROM usuario_permissoes up
         INNER JOIN modulos m
           ON m.id = up.modulo_id
         WHERE up.usuario_id = ?
           AND m.ativo = 1
         ORDER BY m.id`,
        [req.usuario.id]
      );

      return res.json({
        ok: true,
        usuario: req.usuario,
        permissoes
      });

    } catch (error) {
      console.error('Erro ao carregar usuário conectado:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao carregar usuário conectado'
      });
    }
  });

  function somenteAdministrador(req, res, next) {
    if (Number(req.usuario.perfil_id) !== 1) {
      return res.status(403).json({
        ok: false,
        error: 'Acesso permitido somente ao administrador'
      });
    }

    next();
  }

  // ============================================================
  // LISTAR PERFIS
  // ============================================================

  app.get(
    '/api/perfis',
    autenticarToken,
      exigirPermissao('USUARIOS', 'visualizar'),
    async (req, res) => {
      try {
        const [perfis] = await pool.query(
          `SELECT
             id,
             nome,
             descricao
           FROM perfis
           WHERE ativo = 1
           ORDER BY id`
        );

        return res.json({
          ok: true,
          total: perfis.length,
          dados: perfis
        });

      } catch (error) {
        console.error('Erro ao listar perfis:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao listar perfis'
        });
      }
    }
  );

  // ============================================================
  // LISTAR USUÁRIOS
  // ============================================================

  app.get(
    '/api/usuarios',
    autenticarToken,
    exigirPermissao('USUARIOS', 'visualizar'),
    async (req, res) => {
      try {
        const [usuarios] = await pool.query(
          `SELECT
             u.id,
             u.nome,
             u.email,
             u.telefone,
             u.login,
             u.perfil_id,
             p.nome AS perfil,
             u.status,
             u.ultimo_login,
             u.criado_em,
             u.atualizado_em
           FROM usuarios u
           LEFT JOIN perfis p
             ON p.id = u.perfil_id
           ORDER BY u.nome`
        );

        return res.json({
          ok: true,
          total: usuarios.length,
          dados: usuarios
        });

      } catch (error) {
        console.error('Erro ao listar usuários:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao listar usuários'
        });
      }
    }
  );

  // ============================================================
  // CADASTRAR USUÁRIO
  // ============================================================

  app.post(
    '/api/usuarios',
    autenticarToken,
    exigirPermissao('USUARIOS', 'criar'),
    async (req, res) => {
      try {
        const {
          nome,
          email,
          telefone,
          login,
          senha,
          perfil_id
        } = req.body;

        if (!nome || !login || !senha || !perfil_id) {
          return res.status(400).json({
            ok: false,
            error: 'Nome, login, senha e perfil são obrigatórios'
          });
        }

        const loginNormalizado = String(login)
          .trim()
          .toLowerCase();

        if (loginNormalizado.length < 3) {
          return res.status(400).json({
            ok: false,
            error: 'O login deve possuir pelo menos 3 caracteres'
          });
        }

        if (String(senha).length < 8) {
          return res.status(400).json({
            ok: false,
            error: 'A senha deve possuir pelo menos 8 caracteres'
          });
        }

        const [perfis] = await pool.query(
          `SELECT id, nome
           FROM perfis
           WHERE id = ?
             AND ativo = 1
           LIMIT 1`,
          [Number(perfil_id)]
        );

        if (!perfis.length) {
          return res.status(400).json({
            ok: false,
            error: 'Perfil inválido ou inativo'
          });
        }

        const senhaHash = await bcrypt.hash(String(senha), 12);

        const [resultado] = await pool.query(
          `INSERT INTO usuarios (
            nome,
            email,
            telefone,
            login,
            senha_hash,
            senha_provisoria,
            perfil_id,
            status
          )
          VALUES (?, ?, ?, ?, ?, 1, ?, 'ATIVO')`,
          [
            String(nome).trim(),
            email
              ? String(email).trim().toLowerCase()
              : null,
            telefone
              ? String(telefone).trim()
              : null,
            loginNormalizado,
            senhaHash,
            Number(perfil_id)
          ]
        );

        return res.status(201).json({
          ok: true,
          message: 'Usuário cadastrado com sucesso',
          usuario: {
            id: resultado.insertId,
            nome: String(nome).trim(),
            email: email
              ? String(email).trim().toLowerCase()
              : null,
            telefone: telefone
              ? String(telefone).trim()
              : null,
            login: loginNormalizado,
            perfil_id: Number(perfil_id),
            perfil: perfis[0].nome,
            status: 'ATIVO'
          }
        });

      } catch (error) {
        if (error && error.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({
            ok: false,
            error: 'Login ou e-mail já cadastrado'
          });
        }

        console.error('Erro ao cadastrar usuário:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao cadastrar usuário'
        });
      }
    }
  );
};
