module.exports = function(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  const somenteNumeros = valor =>
    String(valor === undefined || valor === null ? '' : valor)
      .replace(/\D/g, '');

  const texto = valor => {
    if (valor === undefined || valor === null) return null;
    const resultado = String(valor).trim();
    return resultado || null;
  };

  const validarCPF = valor => {
    const cpf = somenteNumeros(valor);

    if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;

    const calcular = tamanho => {
      let soma = 0;

      for (let i = 0; i < tamanho; i += 1) {
        soma += Number(cpf[i]) * (tamanho + 1 - i);
      }

      const resto = (soma * 10) % 11;
      return resto === 10 ? 0 : resto;
    };

    return calcular(9) === Number(cpf[9]) &&
      calcular(10) === Number(cpf[10]);
  };

  const validarCNPJ = valor => {
    const cnpj = somenteNumeros(valor);

    if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;

    const digito = base => {
      let peso = base.length - 7;
      let soma = 0;

      for (const numero of base) {
        soma += Number(numero) * peso;
        peso -= 1;
        if (peso === 1) peso = 9;
      }

      const resto = soma % 11;
      return resto < 2 ? 0 : 11 - resto;
    };

    const primeiro = digito(cnpj.slice(0, 12));
    const segundo = digito(cnpj.slice(0, 12) + primeiro);

    return cnpj.endsWith(`${primeiro}${segundo}`);
  };

  // ============================================================
  // CLIENTES
  // ============================================================

  app.get(
    '/api/clientes-resumo',
    autenticarToken,
    exigirPermissao('CLIENTES', 'visualizar'),
    async (req, res) => {
      try {
        const [rows] = await pool.query(`
          SELECT
            COUNT(*) AS total,
            SUM(ativo = 1) AS ativos,
            SUM(ativo = 0) AS bloqueados,
            SUM(cadastro_status = 'PROVISORIO') AS provisorios,
            SUM(cadastro_status = 'VALIDADO') AS validados,
            SUM(cadastro_status = 'COMPLETO') AS completos,
            SUM(tipo_cobranca = 'FATURAMENTO_SEMANAL') AS faturamento_semanal,
            SUM(credito_status = 'BLOQUEADO') AS credito_bloqueado
          FROM clientes
        `);

        return res.json({ ok: true, resumo: rows[0] });
      } catch (error) {
        console.error('Erro ao resumir clientes:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar resumo de clientes'
        });
      }
    }
  );

  app.get(
    '/api/clientes/:id',
    autenticarToken,
    exigirPermissao('CLIENTES', 'visualizar'),
    async (req, res) => {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Cliente inválido'
        });
      }

      try {
        const [rows] = await pool.query(`
          SELECT
            c.*,
            v.status AS vip_status,
            v.valor_mensalidade,
            v.proximo_vencimento,
            (
              SELECT COUNT(*)
              FROM pedidos_senha p
              WHERE p.cliente_id = c.id
            ) AS total_pedidos,
            (
              SELECT COUNT(*)
              FROM faturas_clientes f
              WHERE f.cliente_id = c.id
            ) AS total_faturas
          FROM clientes c
          LEFT JOIN cliente_vip v
            ON v.cliente_id = c.id
          WHERE c.id = ?
          LIMIT 1
        `, [id]);

        if (!rows.length) {
          return res.status(404).json({
            ok: false,
            error: 'Cliente não encontrado'
          });
        }

        return res.json({ ok: true, cliente: rows[0] });
      } catch (error) {
        console.error('Erro ao detalhar cliente:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao detalhar cliente'
        });
      }
    }
  );

  app.put(
    '/api/clientes/:id',
    autenticarToken,
    exigirPermissao('CLIENTES', 'editar'),
    async (req, res) => {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Cliente inválido'
        });
      }

      const nome = texto(req.body.nome);
      const telefone = texto(req.body.telefone);
      const telefoneNormalizado = somenteNumeros(telefone);
      const cpf = texto(req.body.cpf);
      const cnpj = texto(req.body.cnpj);
      const cpfNormalizado = cpf ? somenteNumeros(cpf) : null;
      const cnpjNormalizado = cnpj ? somenteNumeros(cnpj) : null;

      if (!nome || !telefoneNormalizado) {
        return res.status(400).json({
          ok: false,
          error: 'Nome e telefone são obrigatórios'
        });
      }

      if (cpfNormalizado && !validarCPF(cpfNormalizado)) {
        return res.status(400).json({
          ok: false,
          error: 'CPF inválido'
        });
      }

      if (cnpjNormalizado && !validarCNPJ(cnpjNormalizado)) {
        return res.status(400).json({
          ok: false,
          error: 'CNPJ inválido'
        });
      }

      const cadastroStatus = [
        'PROVISORIO',
        'VALIDADO',
        'COMPLETO'
      ].includes(req.body.cadastro_status)
        ? req.body.cadastro_status
        : 'PROVISORIO';

      const tipoCobranca = [
        'ANTECIPADO',
        'FATURAMENTO_SEMANAL'
      ].includes(req.body.tipo_cobranca)
        ? req.body.tipo_cobranca
        : 'ANTECIPADO';

      const creditoStatus = ['LIBERADO', 'BLOQUEADO'].includes(
        req.body.credito_status
      )
        ? req.body.credito_status
        : 'LIBERADO';

      try {
        const [duplicados] = await pool.query(`
          SELECT id, nome
          FROM clientes
          WHERE id <> ?
            AND (
              telefone_normalizado = ?
              OR (? IS NOT NULL AND cpf_normalizado = ?)
              OR (? IS NOT NULL AND cnpj_normalizado = ?)
            )
          LIMIT 1
        `, [
          id,
          telefoneNormalizado,
          cpfNormalizado,
          cpfNormalizado,
          cnpjNormalizado,
          cnpjNormalizado
        ]);

        if (duplicados.length) {
          return res.status(409).json({
            ok: false,
            error: 'Telefone, CPF ou CNPJ já utilizado por outro cliente',
            cliente: duplicados[0]
          });
        }

        const [resultado] = await pool.query(`
          UPDATE clientes
          SET
            nome = ?,
            telefone = ?,
            telefone_normalizado = ?,
            cpf = ?,
            cpf_normalizado = ?,
            cnpj = ?,
            cnpj_normalizado = ?,
            email = ?,
            cidade = ?,
            cadastro_status = ?,
            tipo_cobranca = ?,
            dia_fechamento = ?,
            prazo_pagamento_dias = ?,
            limite_credito = ?,
            credito_status = ?,
            credito_observacao = ?
          WHERE id = ?
        `, [
          nome,
          telefone,
          telefoneNormalizado,
          cpf,
          cpfNormalizado,
          cnpj,
          cnpjNormalizado,
          texto(req.body.email),
          texto(req.body.cidade),
          cadastroStatus,
          tipoCobranca,
          Number(req.body.dia_fechamento) || null,
          Math.max(Number(req.body.prazo_pagamento_dias) || 0, 0),
          req.body.limite_credito === '' ||
          req.body.limite_credito === null ||
          req.body.limite_credito === undefined
            ? null
            : Number(req.body.limite_credito),
          creditoStatus,
          texto(req.body.credito_observacao),
          id
        ]);

        if (!resultado.affectedRows) {
          return res.status(404).json({
            ok: false,
            error: 'Cliente não encontrado'
          });
        }

        return res.json({
          ok: true,
          mensagem: 'Cliente atualizado com sucesso'
        });
      } catch (error) {
        console.error('Erro ao atualizar cliente:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao atualizar cliente'
        });
      }
    }
  );

  app.patch(
    '/api/clientes/:id/status',
    autenticarToken,
    exigirPermissao('CLIENTES', 'editar'),
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
          'UPDATE clientes SET ativo = ? WHERE id = ?',
          [ativo, id]
        );

        if (!resultado.affectedRows) {
          return res.status(404).json({
            ok: false,
            error: 'Cliente não encontrado'
          });
        }

        return res.json({
          ok: true,
          mensagem: ativo
            ? 'Cliente ativado com sucesso'
            : 'Cliente bloqueado com sucesso'
        });
      } catch (error) {
        console.error('Erro ao alterar cliente:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao alterar status do cliente'
        });
      }
    }
  );

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
