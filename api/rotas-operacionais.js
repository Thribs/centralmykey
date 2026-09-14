module.exports = function(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;


  app.get('/api/fornecedores', autenticarToken, exigirPermissao('FORNECEDORES', 'visualizar'), async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT
          id, nome, contato, telefone, whatsapp,
          email, tipo, horario_inicio, horario_fim,
          ativo, observacoes, criado_em
        FROM fornecedores
        ORDER BY nome
      `);

      res.json({
        ok: true,
        total: rows.length,
        dados: rows
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        ok: false,
        error: 'Erro ao consultar fornecedores'
      });
    }
  });

  app.get('/api/servicos', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'visualizar'), async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT
          id, codigo, nome, categoria, marca,
          preco_base, preco_vip, moeda,
          exige_placa, exige_chassi,
          exige_documento, ativo
        FROM servicos
        ORDER BY nome
      `);

      res.json({
        ok: true,
        total: rows.length,
        dados: rows
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        ok: false,
        error: 'Erro ao consultar serviços'
      });
    }
  });

  // ============================================================
  // BANCO DE SENHAS
  // ============================================================

  const normalizarTexto = (valor, maiusculo = false) => {
    if (valor === undefined || valor === null) return null;
    const resultado = String(valor).trim();
    if (!resultado) return null;
    return maiusculo ? resultado.toUpperCase() : resultado;
  };

  const normalizarAno = (valor) => {
    if (valor === undefined || valor === null || valor === '') return null;
    const ano = Number(valor);
    return Number.isInteger(ano) && ano >= 1900 && ano <= 2100
      ? ano
      : null;
  };

  const usuarioDaRequisicao = req =>
    Number(
      req.usuario?.id ||
      req.user?.id ||
      0
    );

  const podeAlterarSenhaConsultada = async (
    conexao,
    usuarioId,
    senhaId
  ) => {
    const [acessoCompleto] = await conexao.query(
      `SELECT up.id
       FROM usuario_permissoes up
       INNER JOIN modulos m
         ON m.id = up.modulo_id
       WHERE up.usuario_id = ?
         AND m.codigo = 'BANCO_SENHAS'
         AND m.ativo = 1
         AND up.aprovar = 1
       LIMIT 1`,
      [usuarioId]
    );

    if (acessoCompleto.length) {
      return true;
    }

    const [consultas] = await conexao.query(
      `SELECT id
       FROM auditoria
       WHERE usuario_id = ?
         AND modulo = 'BANCO_SENHAS'
         AND acao = 'CONSULTA_INDIVIDUAL'
         AND entidade = 'BANCO_SENHA'
         AND entidade_id = ?
         AND criado_em >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
       ORDER BY id DESC
       LIMIT 1`,
      [usuarioId, senhaId]
    );

    return consultas.length > 0;
  };

  const camposBancoSenha = `
    bs.id,
    bs.tipo,
    bs.marca,
    bs.modelo,
    bs.ano_inicio,
    bs.ano_fim,
    bs.placa,
    bs.chassi,
    bs.codigo_mecanico,
      bs.codigo_mecanico_alterado,
    bs.codigo_radio,
      bs.codigo_radio_alterado,
    bs.codigo_imobilizador,
      bs.codigo_imobilizador_alterado,
    bs.codigo_alarme,
      bs.codigo_alarme_alterado,
    bs.pin,
      bs.pin_alterado,
    bs.dados_extras,
    bs.origem_id,
    os.codigo AS origem_codigo,
    os.nome AS origem,
    bs.fornecedor_id,
    f.nome AS fornecedor,
    bs.confiabilidade,
    bs.quantidade_usos,
    bs.quantidade_sucessos,
    bs.quantidade_erros,
    bs.ativo,
    bs.criado_em,
    bs.atualizado_em
  `;

  app.get(
    '/api/banco-senhas/resumo',
    autenticarToken,
    exigirPermissao('BANCO_SENHAS', 'aprovar'),
    async (req, res) => {
      try {
        const [rows] = await pool.query(`
          SELECT
            COUNT(*) AS total,
            SUM(ativo = 1) AS ativos,
            SUM(ativo = 0) AS bloqueados,
            SUM(confiabilidade = 'CONFIRMADA') AS confirmados,
            SUM(confiabilidade = 'ALTA') AS confiabilidade_alta,
            SUM(quantidade_erros > 0) AS com_erros,
            COUNT(DISTINCT marca) AS marcas,
            SUM(origem_id = 5) AS origem_bonus
          FROM banco_senhas
        `);

        return res.json({
          ok: true,
          resumo: rows[0]
        });
      } catch (error) {
        console.error('Erro ao resumir banco de senhas:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar resumo do banco de senhas'
        });
      }
    }
  );

  app.get(
    '/api/origens-senha',
    autenticarToken,
    exigirPermissao('BANCO_SENHAS', 'visualizar'),
    async (req, res) => {
      try {
        const [dados] = await pool.query(`
          SELECT id, codigo, nome, ativo
          FROM origens_senha
          WHERE ativo = 1
          ORDER BY nome
        `);

        return res.json({
          ok: true,
          total: dados.length,
          dados
        });
      } catch (error) {
        console.error('Erro ao listar origens:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar origens'
        });
      }
    }
  );

  app.get(
    '/api/banco-senhas',
    autenticarToken,
    exigirPermissao('BANCO_SENHAS', 'aprovar'),
    async (req, res) => {
      try {
        const busca = normalizarTexto(req.query.busca, true);
        const chassi = normalizarTexto(req.query.chassi, true);
        const codigo = normalizarTexto(req.query.codigo, true);
        const marca = normalizarTexto(req.query.marca, true);
        const confiabilidade = normalizarTexto(
          req.query.confiabilidade,
          true
        );
        const origemId = Number(req.query.origem_id) || null;
        const ativo =
          req.query.ativo === '0' || req.query.ativo === '1'
            ? Number(req.query.ativo)
            : null;

        const pagina = Math.max(Number(req.query.pagina) || 1, 1);
        const limite = Math.min(
          Math.max(Number(req.query.limite) || 50, 1),
          200
        );
        const offset = (pagina - 1) * limite;

        const filtros = [];
        const parametros = [];

        if (busca) {
          const termo = `%${busca}%`;
          filtros.push(`(
            UPPER(bs.chassi) LIKE ?
            OR UPPER(bs.placa) LIKE ?
            OR UPPER(bs.marca) LIKE ?
            OR UPPER(bs.modelo) LIKE ?
            OR UPPER(bs.codigo_mecanico) LIKE ?
            OR UPPER(bs.codigo_radio) LIKE ?
            OR UPPER(bs.codigo_imobilizador) LIKE ?
            OR UPPER(bs.codigo_alarme) LIKE ?
          )`);
          parametros.push(
            termo, termo, termo, termo,
            termo, termo, termo, termo
          );
        }

        if (chassi) {
          filtros.push('UPPER(bs.chassi) LIKE ?');
          parametros.push(`%${chassi}%`);
        }

        if (codigo) {
          const termoCodigo = `%${codigo}%`;
          filtros.push(`(
            UPPER(bs.codigo_mecanico) LIKE ?
            OR UPPER(bs.codigo_radio) LIKE ?
            OR UPPER(bs.codigo_imobilizador) LIKE ?
            OR UPPER(bs.codigo_alarme) LIKE ?
          )`);
          parametros.push(
            termoCodigo,
            termoCodigo,
            termoCodigo,
            termoCodigo
          );
        }

        if (marca) {
          filtros.push('UPPER(bs.marca) = ?');
          parametros.push(marca);
        }

        if (origemId) {
          filtros.push('bs.origem_id = ?');
          parametros.push(origemId);
        }

        if (
          ['BAIXA', 'MEDIA', 'ALTA', 'CONFIRMADA'].includes(
            confiabilidade
          )
        ) {
          filtros.push('bs.confiabilidade = ?');
          parametros.push(confiabilidade);
        }

        if (ativo !== null) {
          filtros.push('bs.ativo = ?');
          parametros.push(ativo);
        }

        const where = filtros.length
          ? `WHERE ${filtros.join(' AND ')}`
          : '';

        const [contagem] = await pool.query(
          `SELECT COUNT(*) AS total
           FROM banco_senhas bs
           ${where}`,
          parametros
        );

        const [dados] = await pool.query(
          `SELECT ${camposBancoSenha}
           FROM banco_senhas bs
           LEFT JOIN origens_senha os
             ON os.id = bs.origem_id
           LEFT JOIN fornecedores f
             ON f.id = bs.fornecedor_id
           ${where}
           ORDER BY bs.id DESC
           LIMIT ${limite}
           OFFSET ${offset}`,
          parametros
        );

        const total = Number(contagem[0].total || 0);

        return res.json({
          ok: true,
          total,
          pagina,
          limite,
          total_paginas: Math.ceil(total / limite),
          dados
        });
      } catch (error) {
        console.error('Erro ao consultar banco de senhas:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar banco de senhas'
        });
      }
    }
  );

  app.get(
    '/api/banco-senhas/consulta-exata',
    autenticarToken,
    exigirPermissao('PEDIDOS_SENHAS', 'criar'),
    async (req, res) => {
      const chassiInformado = String(
        req.query.chassi || ''
      )
        .trim()
        .toUpperCase()
        .replace(/[\s.-]/g, '');

      if (!chassiInformado) {
        return res.status(400).json({
          ok: false,
          error: 'Informe o chassi'
        });
      }

      if (
        chassiInformado.length < 8 ||
        chassiInformado.length > 17
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Informe de 8 a 17 caracteres do chassi'
        });
      }

      if (!/^[A-HJ-NPR-Z0-9]+$/.test(chassiInformado)) {
        return res.status(400).json({
          ok: false,
          error:
            'O chassi não pode conter I, O, Q ou caracteres inválidos'
        });
      }

      try {
        const campos = `
          bs.id,
          bs.tipo,
          bs.marca,
          bs.modelo,
          bs.ano_inicio,
          bs.ano_fim,
          bs.chassi,
          bs.codigo_mecanico,
      bs.codigo_mecanico_alterado,
          bs.codigo_radio,
      bs.codigo_radio_alterado,
          bs.codigo_imobilizador,
      bs.codigo_imobilizador_alterado,
          bs.codigo_alarme,
      bs.codigo_alarme_alterado,
          bs.pin,
      bs.pin_alterado,
          bs.origem_id,
          os.codigo AS origem_codigo,
          os.nome AS origem,
          bs.fornecedor_id,
          f.nome AS fornecedor,
          bs.confiabilidade,
          bs.quantidade_usos,
          bs.quantidade_sucessos,
          bs.quantidade_erros,
          bs.ativo
        `;

        let consulta;
        let parametros;

        if (chassiInformado.length === 17) {
          consulta = `
            SELECT ${campos}
            FROM banco_senhas bs
            LEFT JOIN origens_senha os
              ON os.id = bs.origem_id
            LEFT JOIN fornecedores f
              ON f.id = bs.fornecedor_id
            WHERE bs.chassi = ?
            LIMIT 2
          `;
          parametros = [chassiInformado];
        } else {
          const chassiInvertido =
            chassiInformado
              .split('')
              .reverse()
              .join('') + '%';

          consulta = `
            SELECT ${campos}
            FROM banco_senhas bs
            LEFT JOIN origens_senha os
              ON os.id = bs.origem_id
            LEFT JOIN fornecedores f
              ON f.id = bs.fornecedor_id
            WHERE bs.chassi_invertido LIKE ?
            ORDER BY bs.id DESC
            LIMIT 2
          `;
          parametros = [chassiInvertido];
        }

        const [dados] = await pool.query(
          consulta,
          parametros
        );

        const usuarioId =
          req.usuario?.id ||
          req.user?.id ||
          null;

        if (dados.length > 1) {
          await pool.query(
            `INSERT INTO auditoria (
              usuario_id,
              modulo,
              acao,
              entidade,
              descricao,
              dados_depois,
              ip
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              usuarioId,
              'BANCO_SENHAS',
              'CONSULTA_INDIVIDUAL',
              'BANCO_SENHA',
              'Consulta encontrou mais de um chassi',
              JSON.stringify({
                encontrado: false,
                ambiguo: true,
                caracteres_informados:
                  chassiInformado.length
              }),
              req.ip || null
            ]
          );

          return res.json({
            ok: true,
            encontrada: false,
            ambiguo: true,
            mensagem:
              'Mais de um veículo encontrado. Informe mais caracteres do chassi.'
          });
        }

        const senha = dados[0] || null;

        await pool.query(
          `INSERT INTO auditoria (
            usuario_id,
            modulo,
            acao,
            entidade,
            entidade_id,
            descricao,
            dados_depois,
            ip
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            usuarioId,
            'BANCO_SENHAS',
            'CONSULTA_INDIVIDUAL',
            'BANCO_SENHA',
            senha?.id || null,
            senha
              ? 'Consulta individual encontrou registro ativo'
              : 'Consulta individual não encontrou registro ativo',
            JSON.stringify({
              encontrado: Boolean(senha),
              caracteres_informados:
                chassiInformado.length,
              tipo: senha?.tipo || null,
              confiabilidade:
                senha?.confiabilidade || null
            }),
            req.ip || null
          ]
        );

        if (!senha) {
          return res.json({
            ok: true,
            encontrada: false,
            ambiguo: false,
            mensagem:
              'Chassi não encontrado no banco interno'
          });
        }

        return res.json({
          ok: true,
          encontrada: true,
          ambiguo: false,
          senha
        });
      } catch (error) {
        console.error(
          'Erro na consulta individual por chassi:',
          error
        );

        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar o banco de senhas'
        });
      }
    }
  );

  app.get(
    '/api/banco-senhas/:id',
    autenticarToken,
    exigirPermissao('BANCO_SENHAS', 'aprovar'),
    async (req, res) => {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Registro inválido'
        });
      }

      try {
        const [dados] = await pool.query(
          `SELECT ${camposBancoSenha}
           FROM banco_senhas bs
           LEFT JOIN origens_senha os
             ON os.id = bs.origem_id
           LEFT JOIN fornecedores f
             ON f.id = bs.fornecedor_id
           WHERE bs.id = ?
           LIMIT 1`,
          [id]
        );

        if (!dados.length) {
          return res.status(404).json({
            ok: false,
            error: 'Senha não encontrada'
          });
        }

        return res.json({
          ok: true,
          senha: dados[0]
        });
      } catch (error) {
        console.error('Erro ao detalhar senha:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao detalhar senha'
        });
      }
    }
  );

  app.post(
    '/api/banco-senhas',
    autenticarToken,
    exigirPermissao('BANCO_SENHAS', 'criar'),
    async (req, res) => {
      try {
        const chassi = normalizarTexto(req.body.chassi, true);
        const codigoMecanico = normalizarTexto(
          req.body.codigo_mecanico,
          true
        );
        const codigoRadio = normalizarTexto(
          req.body.codigo_radio,
          true
        );
        const codigoImobilizador = normalizarTexto(
          req.body.codigo_imobilizador,
          true
        );
        const codigoAlarme = normalizarTexto(
          req.body.codigo_alarme,
          true
        );

        const codigoMecanicoAlterado = normalizarTexto(
          req.body.codigo_mecanico_alterado,
          true
        );
        const codigoRadioAlterado = normalizarTexto(
          req.body.codigo_radio_alterado,
          true
        );
        const codigoImobilizadorAlterado = normalizarTexto(
          req.body.codigo_imobilizador_alterado,
          true
        );
        const codigoAlarmeAlterado = normalizarTexto(
          req.body.codigo_alarme_alterado,
          true
        );
        const pin = normalizarTexto(req.body.pin, true);
        const pinAlterado = normalizarTexto(
          req.body.pin_alterado,
          true
        );
        if (!chassi) {
          return res.status(400).json({
            ok: false,
            error: 'Chassi é obrigatório'
          });
        }

        if (
          !codigoMecanico &&
          !codigoMecanicoAlterado &&
          !codigoRadio &&
          !codigoRadioAlterado &&
          !codigoImobilizador &&
          !codigoImobilizadorAlterado &&
          !codigoAlarme &&
          !codigoAlarmeAlterado &&
          !pin &&
          !pinAlterado
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Informe pelo menos um código'
          });
        }

        const [existentes] = await pool.query(
          `SELECT id
           FROM banco_senhas
           WHERE UPPER(chassi) = ?
           LIMIT 1`,
          [chassi]
        );

        if (existentes.length) {
          return res.status(409).json({
            ok: false,
            error: 'Já existe uma senha cadastrada para este chassi',
            senha_id: existentes[0].id
          });
        }

        const confiabilidade = normalizarTexto(
          req.body.confiabilidade,
          true
        );

        const confiabilidadeFinal = [
          'BAIXA',
          'MEDIA',
          'ALTA',
          'CONFIRMADA'
        ].includes(confiabilidade)
          ? confiabilidade
          : 'MEDIA';

        const [resultado] = await pool.query(
          `INSERT INTO banco_senhas (
             tipo,
             marca,
             modelo,
             ano_inicio,
             ano_fim,
             placa,
             chassi,
             codigo_mecanico,
             codigo_mecanico_alterado,
             codigo_radio,
             codigo_radio_alterado,
             codigo_imobilizador,
             codigo_imobilizador_alterado,
             codigo_alarme,
             codigo_alarme_alterado,
             pin,
             pin_alterado,
             dados_extras,
             origem_id,
             fornecedor_id,
             confiabilidade,
             ativo
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            normalizarTexto(req.body.tipo, true) || 'SENHA',
            normalizarTexto(req.body.marca, true),
            normalizarTexto(req.body.modelo, true),
            normalizarAno(req.body.ano_inicio),
            normalizarAno(req.body.ano_fim),
            normalizarTexto(req.body.placa, true),
            chassi,
            codigoMecanico,
            codigoMecanicoAlterado,
            codigoRadio,
            codigoRadioAlterado,
            codigoImobilizador,
            codigoImobilizadorAlterado,
            codigoAlarme,
            codigoAlarmeAlterado,
            pin,
            pinAlterado,
            req.body.dados_extras
              ? JSON.stringify(req.body.dados_extras)
              : null,
            Number(req.body.origem_id) || null,
            Number(req.body.fornecedor_id) || null,
            confiabilidadeFinal
          ]
        );

        return res.status(201).json({
          ok: true,
          mensagem: 'Senha cadastrada com sucesso',
          senha_id: resultado.insertId
        });
      } catch (error) {
        console.error('Erro ao cadastrar senha:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao cadastrar senha'
        });
      }
    }
  );

  app.put(
    '/api/banco-senhas/:id',
    autenticarToken,
    exigirPermissao('BANCO_SENHAS', 'editar'),
    async (req, res) => {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Registro inválido'
        });
      }

      const chassi = normalizarTexto(
        req.body.chassi,
        true
      );

      const codigoMecanico = normalizarTexto(
        req.body.codigo_mecanico,
        true
      );
      const codigoRadio = normalizarTexto(
        req.body.codigo_radio,
        true
      );
      const codigoImobilizador = normalizarTexto(
        req.body.codigo_imobilizador,
        true
      );
      const codigoAlarme = normalizarTexto(
        req.body.codigo_alarme,
        true
      );
      const pin = normalizarTexto(
        req.body.pin,
        true
      );
        const codigoMecanicoAlterado = normalizarTexto(
          req.body.codigo_mecanico_alterado,
          true
        );
        const codigoRadioAlterado = normalizarTexto(
          req.body.codigo_radio_alterado,
          true
        );
        const codigoImobilizadorAlterado = normalizarTexto(
          req.body.codigo_imobilizador_alterado,
          true
        );
        const codigoAlarmeAlterado = normalizarTexto(
          req.body.codigo_alarme_alterado,
          true
        );
        const pinAlterado = normalizarTexto(
          req.body.pin_alterado,
          true
        );

      if (!chassi) {
        return res.status(400).json({
          ok: false,
          error: 'Chassi é obrigatório'
        });
      }

        if (
          !codigoMecanico &&
          !codigoMecanicoAlterado &&
          !codigoRadio &&
          !codigoRadioAlterado &&
          !codigoImobilizador &&
          !codigoImobilizadorAlterado &&
          !codigoAlarme &&
          !codigoAlarmeAlterado &&
          !pin &&
          !pinAlterado
        ) {
        return res.status(400).json({
          ok: false,
          error: 'Informe pelo menos um código'
        });
      }

      const confiabilidade = normalizarTexto(
        req.body.confiabilidade,
        true
      );

      const confiabilidadeFinal = [
        'BAIXA',
        'MEDIA',
        'ALTA',
        'CONFIRMADA'
      ].includes(confiabilidade)
        ? confiabilidade
        : 'MEDIA';

      const dadosNovos = {
        tipo:
          normalizarTexto(req.body.tipo, true) ||
          'SENHA',
        marca:
          normalizarTexto(req.body.marca, true),
        modelo:
          normalizarTexto(req.body.modelo, true),
        ano_inicio:
          normalizarAno(req.body.ano_inicio),
        ano_fim:
          normalizarAno(req.body.ano_fim),
        placa:
          normalizarTexto(req.body.placa, true),
        chassi,
        codigo_mecanico: codigoMecanico,
        codigo_mecanico_alterado: codigoMecanicoAlterado,
        codigo_radio: codigoRadio,
        codigo_radio_alterado: codigoRadioAlterado,
        codigo_imobilizador: codigoImobilizador,
        codigo_imobilizador_alterado: codigoImobilizadorAlterado,
        codigo_alarme: codigoAlarme,
        codigo_alarme_alterado: codigoAlarmeAlterado,
        pin,
        pin_alterado: pinAlterado,
        origem_id:
          Number(req.body.origem_id) || null,
        fornecedor_id:
          Number(req.body.fornecedor_id) || null,
        confiabilidade: confiabilidadeFinal
      };

      let conexao;

      try {
        conexao = await pool.getConnection();
        await conexao.beginTransaction();

        const [anteriores] = await conexao.query(
          `SELECT
             id,
             tipo,
             marca,
             modelo,
             ano_inicio,
             ano_fim,
             placa,
             chassi,
             codigo_mecanico,
             codigo_mecanico_alterado,
             codigo_radio,
             codigo_radio_alterado,
             codigo_imobilizador,
             codigo_imobilizador_alterado,
             codigo_alarme,
             codigo_alarme_alterado,
             pin,
             pin_alterado,
             origem_id,
             fornecedor_id,
             confiabilidade,
             ativo,
             quantidade_usos,
             quantidade_sucessos,
             quantidade_erros
           FROM banco_senhas
           WHERE id = ?
           FOR UPDATE`,
          [id]
        );

        if (!anteriores.length) {
          await conexao.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Senha não encontrada'
          });
        }

        const dadosAnteriores = anteriores[0];
        const usuarioId = usuarioDaRequisicao(req);

        const alteracaoAutorizada =
          await podeAlterarSenhaConsultada(
            conexao,
            usuarioId,
            id
          );

        if (!alteracaoAutorizada) {
          await conexao.rollback();

          return res.status(403).json({
            ok: false,
            error:
              'Consulte este chassi novamente antes de alterar a senha'
          });
        }

        const [duplicados] = await conexao.query(
          `SELECT id
           FROM banco_senhas
           WHERE chassi = ?
             AND id <> ?
           LIMIT 1`,
          [chassi, id]
        );

        if (duplicados.length) {
          await conexao.rollback();

          return res.status(409).json({
            ok: false,
            error:
              'Outro registro já utiliza este chassi',
            senha_id: duplicados[0].id
          });
        }

        await conexao.query(
          `UPDATE banco_senhas
           SET
             tipo = ?,
             marca = ?,
             modelo = ?,
             ano_inicio = ?,
             ano_fim = ?,
             placa = ?,
             chassi = ?,
             codigo_mecanico = ?,
             codigo_mecanico_alterado = ?,
             codigo_radio = ?,
             codigo_radio_alterado = ?,
             codigo_imobilizador = ?,
             codigo_imobilizador_alterado = ?,
             codigo_alarme = ?,
             codigo_alarme_alterado = ?,
             pin = ?,
             pin_alterado = ?,
             origem_id = ?,
             fornecedor_id = ?,
             confiabilidade = ?
           WHERE id = ?`,
          [
            dadosNovos.tipo,
            dadosNovos.marca,
            dadosNovos.modelo,
            dadosNovos.ano_inicio,
            dadosNovos.ano_fim,
            dadosNovos.placa,
            dadosNovos.chassi,
            dadosNovos.codigo_mecanico,
            dadosNovos.codigo_mecanico_alterado,
            dadosNovos.codigo_radio,
            dadosNovos.codigo_radio_alterado,
            dadosNovos.codigo_imobilizador,
            dadosNovos.codigo_imobilizador_alterado,
            dadosNovos.codigo_alarme,
            dadosNovos.codigo_alarme_alterado,
            dadosNovos.pin,
            dadosNovos.pin_alterado,
            dadosNovos.origem_id,
            dadosNovos.fornecedor_id,
            dadosNovos.confiabilidade,
            id
          ]
        );



        await conexao.query(
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            usuarioId,
            'BANCO_SENHAS',
            'ATUALIZAR',
            'BANCO_SENHA',
            String(id),
            'Registro de senha automotiva atualizado',
            JSON.stringify(dadosAnteriores),
            JSON.stringify({
              ...dadosNovos,
              ativo: dadosAnteriores.ativo,
              quantidade_usos:
                dadosAnteriores.quantidade_usos,
              quantidade_sucessos:
                dadosAnteriores.quantidade_sucessos,
              quantidade_erros:
                dadosAnteriores.quantidade_erros
            }),
            req.ip || null
          ]
        );

        await conexao.commit();

        return res.json({
          ok: true,
          mensagem:
            'Senha atualizada com histórico preservado'
        });
      } catch (error) {
        if (conexao) {
          await conexao.rollback();
        }

        console.error(
          'Erro ao atualizar senha:',
          error
        );

        return res.status(500).json({
          ok: false,
          error: 'Erro ao atualizar senha'
        });
      } finally {
        if (conexao) {
          conexao.release();
        }
      }
    }
  );

  app.patch(
    '/api/banco-senhas/:id/status',
    autenticarToken,
    exigirPermissao('BANCO_SENHAS', 'editar'),
    async (req, res) => {
      const id = Number(req.params.id);
      const ativo = Number(req.body.ativo);

      if (
        !Number.isInteger(id) ||
        id <= 0 ||
        ![0, 1].includes(ativo)
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Dados de alteração inválidos'
        });
      }

      let conexao;

      try {
        conexao = await pool.getConnection();
        await conexao.beginTransaction();

        const [registros] = await conexao.query(
          `SELECT id, chassi, ativo
           FROM banco_senhas
           WHERE id = ?
           FOR UPDATE`,
          [id]
        );

        if (!registros.length) {
          await conexao.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Senha não encontrada'
          });
        }

        const registro = registros[0];
        const usuarioId = usuarioDaRequisicao(req);

        const alteracaoAutorizada =
          await podeAlterarSenhaConsultada(
            conexao,
            usuarioId,
            id
          );

        if (!alteracaoAutorizada) {
          await conexao.rollback();

          return res.status(403).json({
            ok: false,
            error:
              'Consulte este chassi novamente antes de alterar o status'
          });
        }

        await conexao.query(
          `UPDATE banco_senhas
           SET ativo = ?
           WHERE id = ?`,
          [ativo, id]
        );

        await conexao.query(
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
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            usuarioId,
            'BANCO_SENHAS',
            'ALTERAR_STATUS',
            'BANCO_SENHA',
            id,
            ativo
              ? 'Senha ativada'
              : 'Senha bloqueada',
            JSON.stringify({
              chassi: registro.chassi,
              ativo: Number(registro.ativo)
            }),
            JSON.stringify({
              chassi: registro.chassi,
              ativo
            }),
            req.ip || null
          ]
        );

        await conexao.commit();

        return res.json({
          ok: true,
          mensagem: ativo
            ? 'Senha ativada com sucesso'
            : 'Senha bloqueada com sucesso'
        });
      } catch (error) {
        if (conexao) {
          await conexao.rollback();
        }

        console.error(
          'Erro ao alterar status da senha:',
          error
        );

        return res.status(500).json({
          ok: false,
          error: 'Erro ao alterar status da senha'
        });
      } finally {
        if (conexao) {
          conexao.release();
        }
      }
    }
  );

  app.post('/api/fornecedores', autenticarToken, exigirPermissao('FORNECEDORES', 'criar'), async (req, res) => {
    try {
      const {
        nome,
        contato,
        telefone,
        whatsapp,
        email,
        tipo = 'PESSOA',
        horario_inicio,
        horario_fim,
        observacoes
      } = req.body;

      if (!nome || !String(nome).trim()) {
        return res.status(400).json({
          ok: false,
          error: 'Nome do fornecedor é obrigatório'
        });
      }

      const [result] = await pool.query(`
        INSERT INTO fornecedores (
          nome,
          contato,
          telefone,
          whatsapp,
          email,
          tipo,
          horario_inicio,
          horario_fim,
          observacoes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        String(nome).trim(),
        contato || null,
        telefone || null,
        whatsapp || null,
        email || null,
        tipo,
        horario_inicio || null,
        horario_fim || null,
        observacoes || null
      ]);

      res.status(201).json({
        ok: true,
        mensagem: 'Fornecedor cadastrado com sucesso',
        fornecedor_id: result.insertId
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        ok: false,
        error: 'Erro ao cadastrar fornecedor'
      });
    }
  });
};
