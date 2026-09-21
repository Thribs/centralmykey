module.exports = function(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  const texto = valor => {
    if (valor === undefined || valor === null) return null;
    const resultado = String(valor).trim();
    return resultado || null;
  };

  const inteiroOpcional = valor => {
    if (valor === undefined || valor === null || valor === '') return null;
    const numero = Number(valor);
    return Number.isInteger(numero) ? numero : NaN;
  };

  const validarServicoFornecedor = corpo => {
    const codigoServico = texto(corpo.codigo_servico)?.toUpperCase();
    const custo = Number(corpo.custo);
    const moeda = texto(corpo.moeda)?.toUpperCase() || 'BRL';
    const anoInicio = inteiroOpcional(corpo.ano_inicio);
    const anoFim = inteiroOpcional(corpo.ano_fim);
    const prazo = inteiroOpcional(corpo.prazo_estimado_minutos);
    const ativo = corpo.ativo === undefined ? 1 : Number(corpo.ativo);

    if (!codigoServico || !Number.isFinite(custo) || custo < 0) {
      return { erro: 'Serviço e custo não negativo são obrigatórios' };
    }
    if (!['BRL', 'USD', 'PYG'].includes(moeda)) {
      return { erro: 'Moeda inválida' };
    }
    if (
      (anoInicio !== null && (!Number.isInteger(anoInicio) || anoInicio < 1900 || anoInicio > 2200)) ||
      (anoFim !== null && (!Number.isInteger(anoFim) || anoFim < 1900 || anoFim > 2200)) ||
      (anoInicio !== null && anoFim !== null && anoInicio > anoFim)
    ) {
      return { erro: 'Intervalo de anos inválido' };
    }
    if (prazo !== null && (!Number.isInteger(prazo) || prazo < 0)) {
      return { erro: 'Prazo estimado inválido' };
    }
    if (![0, 1].includes(ativo)) {
      return { erro: 'Status do serviço inválido' };
    }

    return {
      dados: {
        codigo_servico: codigoServico,
        descricao: texto(corpo.descricao),
        marca: texto(corpo.marca),
        modelo: texto(corpo.modelo),
        ano_inicio: anoInicio,
        ano_fim: anoFim,
        custo,
        moeda,
        prazo_estimado_minutos: prazo,
        ativo
      }
    };
  };

  const registrarAuditoriaFornecedor = async (
    connection,
    req,
    { acao, entidade = 'fornecedores', entidadeId, descricao, antes, depois }
  ) => {
    await connection.query(`
      INSERT INTO auditoria
        (usuario_id, modulo, acao, entidade, entidade_id, descricao,
         dados_antes, dados_depois, ip)
      VALUES (?, 'FORNECEDORES', ?, ?, ?, ?, ?, ?, ?)
    `, [req.usuario?.id || null, acao, entidade, String(entidadeId), descricao,
      antes ? JSON.stringify(antes) : null,
      depois ? JSON.stringify(depois) : null,
      req.ip || null]);
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
      const tipo = String(req.body.tipo || 'PESSOA').toUpperCase();

      if (!nome || !['PESSOA', 'EMPRESA', 'SISTEMA', 'API'].includes(tipo)) {
        return res.status(400).json({
          ok: false,
          error: 'Nome e tipo válido do fornecedor são obrigatórios'
        });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [atuais] = await connection.query(`
          SELECT id, nome, contato, telefone, whatsapp, email, tipo,
                 horario_inicio, horario_fim, ativo, observacoes
            FROM fornecedores
           WHERE id = ? LIMIT 1 FOR UPDATE
        `, [id]);
        if (!atuais.length) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Fornecedor não encontrado' });
        }

        const depois = {
          ...atuais[0],
          nome,
          contato: texto(req.body.contato),
          telefone: texto(req.body.telefone),
          whatsapp: texto(req.body.whatsapp),
          email: texto(req.body.email),
          tipo,
          horario_inicio: texto(req.body.horario_inicio),
          horario_fim: texto(req.body.horario_fim),
          observacoes: texto(req.body.observacoes)
        };
        await connection.query(`
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
        `, [depois.nome, depois.contato, depois.telefone, depois.whatsapp,
          depois.email, depois.tipo, depois.horario_inicio, depois.horario_fim,
          depois.observacoes, id]);
        await registrarAuditoriaFornecedor(connection, req, {
          acao: 'EDITAR',
          entidadeId: id,
          descricao: 'Cadastro do fornecedor atualizado',
          antes: atuais[0],
          depois
        });
        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Fornecedor atualizado com sucesso'
        });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao atualizar fornecedor:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao atualizar fornecedor'
        });
      } finally {
        connection.release();
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

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [atuais] = await connection.query(
          `SELECT id, nome, ativo FROM fornecedores
            WHERE id = ? LIMIT 1 FOR UPDATE`,
          [id]
        );
        if (!atuais.length) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Fornecedor não encontrado' });
        }
        await connection.query(
          'UPDATE fornecedores SET ativo = ? WHERE id = ?',
          [ativo, id]
        );
        await registrarAuditoriaFornecedor(connection, req, {
          acao: ativo ? 'ATIVAR' : 'BLOQUEAR',
          entidadeId: id,
          descricao: ativo ? 'Fornecedor ativado' : 'Fornecedor bloqueado',
          antes: atuais[0],
          depois: { ...atuais[0], ativo }
        });
        await connection.commit();

        return res.json({
          ok: true,
          mensagem: ativo
            ? 'Fornecedor ativado com sucesso'
            : 'Fornecedor bloqueado com sucesso'
        });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao alterar fornecedor:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao alterar status do fornecedor'
        });
      } finally {
        connection.release();
      }
    }
  );

  app.get(
    '/api/fornecedores/:id/servicos',
    autenticarToken,
    exigirPermissao('FORNECEDORES', 'visualizar'),
    async (req, res) => {
      const fornecedorId = Number(req.params.id);
      if (!Number.isInteger(fornecedorId) || fornecedorId <= 0) {
        return res.status(400).json({ ok: false, error: 'Fornecedor inválido' });
      }

      try {
        const [fornecedores] = await pool.query(
          'SELECT id, nome FROM fornecedores WHERE id = ? LIMIT 1',
          [fornecedorId]
        );
        if (!fornecedores.length) {
          return res.status(404).json({ ok: false, error: 'Fornecedor não encontrado' });
        }

        const [servicos] = await pool.query(`
          SELECT fs.id, fs.fornecedor_id, fs.codigo_servico, fs.descricao,
                 fs.marca, fs.modelo, fs.ano_inicio, fs.ano_fim, fs.custo,
                 fs.moeda, fs.prazo_estimado_minutos, fs.ativo,
                 s.nome AS servico_nome, s.ativo AS servico_ativo
            FROM fornecedor_servicos fs
            LEFT JOIN servicos s ON s.codigo = fs.codigo_servico
           WHERE fs.fornecedor_id = ?
           ORDER BY fs.ativo DESC, fs.codigo_servico, fs.marca, fs.modelo,
                    fs.ano_inicio, fs.id
        `, [fornecedorId]);
        const [catalogo] = await pool.query(`
          SELECT codigo, nome, categoria, marca, moeda
            FROM servicos
           WHERE ativo = 1
           ORDER BY nome, codigo
        `);

        return res.json({
          ok: true,
          fornecedor: fornecedores[0],
          total: servicos.length,
          dados: servicos,
          catalogo
        });
      } catch (error) {
        console.error('Erro ao listar serviços do fornecedor:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar serviços do fornecedor'
        });
      }
    }
  );

  const salvarServicoFornecedor = criar => async (req, res) => {
    const fornecedorId = Number(req.params.id);
    const vinculoId = criar ? null : Number(req.params.servicoId);
    if (
      !Number.isInteger(fornecedorId) || fornecedorId <= 0 ||
      (!criar && (!Number.isInteger(vinculoId) || vinculoId <= 0))
    ) {
      return res.status(400).json({ ok: false, error: 'Identificador inválido' });
    }

    const validacao = validarServicoFornecedor(req.body || {});
    if (validacao.erro) {
      return res.status(400).json({ ok: false, error: validacao.erro });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [fornecedores] = await connection.query(
        'SELECT id FROM fornecedores WHERE id = ? LIMIT 1 FOR UPDATE',
        [fornecedorId]
      );
      if (!fornecedores.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, error: 'Fornecedor não encontrado' });
      }

      const dados = validacao.dados;
      const [catalogo] = await connection.query(
        'SELECT codigo, nome FROM servicos WHERE codigo = ? LIMIT 1',
        [dados.codigo_servico]
      );
      if (!catalogo.length) {
        await connection.rollback();
        return res.status(400).json({ ok: false, error: 'Serviço não cadastrado' });
      }
      dados.descricao = dados.descricao || catalogo[0].nome;

      let antes = null;
      if (!criar) {
        const [atuais] = await connection.query(
          `SELECT id, fornecedor_id, codigo_servico, descricao, marca, modelo,
                  ano_inicio, ano_fim, custo, moeda, prazo_estimado_minutos, ativo
             FROM fornecedor_servicos
            WHERE id = ? AND fornecedor_id = ? LIMIT 1 FOR UPDATE`,
          [vinculoId, fornecedorId]
        );
        if (!atuais.length) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Serviço do fornecedor não encontrado' });
        }
        antes = atuais[0];
      }

      const [duplicados] = await connection.query(
        `SELECT id FROM fornecedor_servicos
          WHERE fornecedor_id = ? AND codigo_servico = ?
            AND marca <=> ? AND modelo <=> ?
            AND ano_inicio <=> ? AND ano_fim <=> ?
            AND (? IS NULL OR id <> ?)
          LIMIT 1 FOR UPDATE`,
        [fornecedorId, dados.codigo_servico, dados.marca, dados.modelo,
         dados.ano_inicio, dados.ano_fim, vinculoId, vinculoId]
      );
      if (duplicados.length) {
        await connection.rollback();
        return res.status(409).json({
          ok: false,
          error: 'Já existe uma regra para esse serviço, marca, modelo e período'
        });
      }

      let id = vinculoId;
      if (criar) {
        const [resultado] = await connection.query(`
          INSERT INTO fornecedor_servicos
            (fornecedor_id, codigo_servico, descricao, marca, modelo,
             ano_inicio, ano_fim, custo, moeda, prazo_estimado_minutos, ativo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [fornecedorId, dados.codigo_servico, dados.descricao, dados.marca,
          dados.modelo, dados.ano_inicio, dados.ano_fim, dados.custo,
          dados.moeda, dados.prazo_estimado_minutos, dados.ativo]);
        id = resultado.insertId;
      } else {
        await connection.query(`
          UPDATE fornecedor_servicos
             SET codigo_servico = ?, descricao = ?, marca = ?, modelo = ?,
                 ano_inicio = ?, ano_fim = ?, custo = ?, moeda = ?,
                 prazo_estimado_minutos = ?, ativo = ?
           WHERE id = ? AND fornecedor_id = ?
        `, [dados.codigo_servico, dados.descricao, dados.marca, dados.modelo,
          dados.ano_inicio, dados.ano_fim, dados.custo, dados.moeda,
          dados.prazo_estimado_minutos, dados.ativo, id, fornecedorId]);
      }

      const depois = { id, fornecedor_id: fornecedorId, ...dados };
      await registrarAuditoriaFornecedor(connection, req, {
        acao: criar ? 'CRIAR_SERVICO' : 'EDITAR_SERVICO',
        entidade: 'fornecedor_servicos',
        entidadeId: id,
        descricao: criar
          ? 'Serviço vinculado ao fornecedor'
          : 'Serviço do fornecedor atualizado',
        antes,
        depois
      });

      await connection.commit();
      return res.status(criar ? 201 : 200).json({
        ok: true,
        servico_id: id,
        mensagem: criar
          ? 'Serviço vinculado ao fornecedor'
          : 'Serviço do fornecedor atualizado'
      });
    } catch (error) {
      await connection.rollback();
      console.error('Erro ao salvar serviço do fornecedor:', error);
      return res.status(500).json({ ok: false, error: 'Erro ao salvar serviço do fornecedor' });
    } finally {
      connection.release();
    }
  };

  app.post(
    '/api/fornecedores/:id/servicos',
    autenticarToken,
    exigirPermissao('FORNECEDORES', 'editar'),
    salvarServicoFornecedor(true)
  );

  app.put(
    '/api/fornecedores/:id/servicos/:servicoId',
    autenticarToken,
    exigirPermissao('FORNECEDORES', 'editar'),
    salvarServicoFornecedor(false)
  );
};
