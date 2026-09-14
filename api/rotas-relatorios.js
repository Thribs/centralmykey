module.exports = function(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  function periodo(req) {
    const fim = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fim || ''))
      ? String(req.query.fim)
      : null;

    const inicio = /^\d{4}-\d{2}-\d{2}$/.test(
      String(req.query.inicio || '')
    )
      ? String(req.query.inicio)
      : null;

    return { inicio, fim };
  }

  // ============================================================
  // RESUMO FINANCEIRO
  // ============================================================

  app.get(
    '/api/financeiro/resumo',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'visualizar'),
    async (req, res) => {
      try {
        const [lancamentos] = await pool.query(`
          SELECT
            moeda,
            SUM(tipo = 'RECEITA') AS quantidade_receitas,
            SUM(tipo = 'DESPESA') AS quantidade_despesas,
            SUM(
              CASE
                WHEN tipo = 'RECEITA'
                     AND status IN ('RECEBIDO', 'PAGO')
                  THEN valor
                ELSE 0
              END
            ) AS receitas_realizadas,
            SUM(
              CASE
                WHEN tipo = 'DESPESA'
                     AND status IN ('PAGO', 'RECEBIDO')
                  THEN valor
                ELSE 0
              END
            ) AS despesas_realizadas,
            SUM(
              CASE
                WHEN tipo = 'RECEITA'
                     AND status IN ('PREVISTO', 'PENDENTE', 'VENCIDO')
                  THEN valor
                ELSE 0
              END
            ) AS contas_receber,
            SUM(
              CASE
                WHEN tipo = 'DESPESA'
                     AND status IN ('PREVISTO', 'PENDENTE', 'VENCIDO')
                  THEN valor
                ELSE 0
              END
            ) AS contas_pagar
          FROM lancamentos_financeiros
          GROUP BY moeda
          ORDER BY moeda
        `);

        const [faturas] = await pool.query(`
          SELECT
            moeda,
            COUNT(*) AS total,
            SUM(status = 'ABERTA') AS abertas,
            SUM(status = 'FECHADA') AS fechadas,
            SUM(status = 'PAGA') AS pagas,
            SUM(
              status = 'VENCIDA'
              OR (
                status IN ('ABERTA', 'FECHADA')
                AND vencimento < CURDATE()
              )
            ) AS vencidas,
            SUM(
              CASE
                WHEN status IN ('ABERTA', 'FECHADA')
                  THEN valor_total
                ELSE 0
              END
            ) AS valor_em_aberto,
            SUM(
              CASE
                WHEN status = 'PAGA'
                  THEN valor_total
                ELSE 0
              END
            ) AS valor_pago
          FROM faturas_clientes
          GROUP BY moeda
          ORDER BY moeda
        `);

        const [hoje] = await pool.query(`
          SELECT
            moeda,
            COUNT(*) AS quantidade,
            SUM(valor) AS valor
          FROM pagamentos
          WHERE DATE(data_pagamento) = CURDATE()
          GROUP BY moeda
          ORDER BY moeda
        `);

        return res.json({
          ok: true,
          lancamentos,
          faturas,
          pagamentos_hoje: hoje
        });
      } catch (error) {
        console.error('Erro ao resumir financeiro:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar resumo financeiro'
        });
      }
    }
  );

  // ============================================================
  // LANÇAMENTOS FINANCEIROS
  // ============================================================

  app.get(
    '/api/lancamentos-financeiros',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'visualizar'),
    async (req, res) => {
      try {
        const tipo = String(req.query.tipo || '').toUpperCase();
        const status = String(req.query.status || '').toUpperCase();
        const busca = String(req.query.busca || '').trim();
        const moeda = String(req.query.moeda || '').toUpperCase();

        const filtros = [];
        const parametros = [];

        if (['RECEITA', 'DESPESA'].includes(tipo)) {
          filtros.push('lf.tipo = ?');
          parametros.push(tipo);
        }

        if (
          ['PREVISTO', 'PENDENTE', 'PAGO', 'RECEBIDO',
            'VENCIDO', 'CANCELADO'].includes(status)
        ) {
          filtros.push('lf.status = ?');
          parametros.push(status);
        }

        if (['BRL', 'USD', 'PYG'].includes(moeda)) {
          filtros.push('lf.moeda = ?');
          parametros.push(moeda);
        }

        if (busca) {
          filtros.push(`(
            lf.descricao LIKE ?
            OR c.nome LIKE ?
            OR f.nome LIKE ?
            OR p.protocolo LIKE ?
          )`);

          const termo = `%${busca}%`;
          parametros.push(termo, termo, termo, termo);
        }

        const where = filtros.length
          ? `WHERE ${filtros.join(' AND ')}`
          : '';

        const [dados] = await pool.query(`
          SELECT
            lf.id,
            lf.tipo,
            lf.descricao,
            lf.valor,
            lf.moeda,
            DATE_FORMAT(lf.data_competencia, '%Y-%m-%d')
              AS data_competencia,
            DATE_FORMAT(lf.vencimento, '%Y-%m-%d') AS vencimento,
            lf.status,
            lf.origem,
            lf.cliente_id,
            c.nome AS cliente,
            lf.fornecedor_id,
            f.nome AS fornecedor,
            lf.pedido_senha_id,
            p.protocolo,
            cf.nome AS categoria,
            lf.criado_em
          FROM lancamentos_financeiros lf
          LEFT JOIN clientes c
            ON c.id = lf.cliente_id
          LEFT JOIN fornecedores f
            ON f.id = lf.fornecedor_id
          LEFT JOIN pedidos_senha p
            ON p.id = lf.pedido_senha_id
          LEFT JOIN categorias_financeiras cf
            ON cf.id = lf.categoria_id
          ${where}
          ORDER BY lf.data_competencia DESC, lf.id DESC
          LIMIT 300
        `, parametros);

        return res.json({
          ok: true,
          total: dados.length,
          dados
        });
      } catch (error) {
        console.error('Erro ao listar lançamentos:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao consultar lançamentos financeiros'
        });
      }
    }
  );

  // ============================================================
  // RELATÓRIO OPERACIONAL
  // ============================================================

  app.get(
    '/api/relatorios/operacional',
    autenticarToken,
    exigirPermissao('RELATORIOS', 'visualizar'),
    async (req, res) => {
      try {
        const { inicio, fim } = periodo(req);
        const filtros = [];
        const parametros = [];

        if (inicio) {
          filtros.push('DATE(p.criado_em) >= ?');
          parametros.push(inicio);
        } else {
          filtros.push('DATE(p.criado_em) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)');
        }

        if (fim) {
          filtros.push('DATE(p.criado_em) <= ?');
          parametros.push(fim);
        }

        const where = `WHERE ${filtros.join(' AND ')}`;

        const [resumo] = await pool.query(`
          SELECT
            COUNT(*) AS total_pedidos,
            SUM(p.status = 'CONCLUIDO') AS concluidos,
            SUM(p.status = 'CANCELADO') AS cancelados,
            SUM(p.status = 'ERRO') AS erros,
            SUM(p.status IN (
              'ABERTO',
              'AGUARDANDO_DADOS',
              'EM_CONSULTA',
              'AGUARDANDO_PAGAMENTO',
              'PAGO'
            )) AS em_andamento,
            COALESCE(SUM(p.valor_venda), 0) AS valor_vendas,
            COALESCE(SUM(p.custo), 0) AS custo_total,
            COALESCE(SUM(p.valor_venda - p.custo), 0) AS resultado_bruto,
            COUNT(DISTINCT p.cliente_id) AS clientes_atendidos
          FROM pedidos_senha p
          ${where}
        `, parametros);

        const [porStatus] = await pool.query(`
          SELECT
            p.status,
            COUNT(*) AS quantidade,
            COALESCE(SUM(p.valor_venda), 0) AS valor_vendas,
            COALESCE(SUM(p.custo), 0) AS custo
          FROM pedidos_senha p
          ${where}
          GROUP BY p.status
          ORDER BY quantidade DESC
        `, parametros);

        const [porFornecedor] = await pool.query(`
          SELECT
            COALESCE(f.nome, 'Base própria / não definido') AS fornecedor,
            COUNT(*) AS quantidade,
            COALESCE(SUM(p.valor_venda), 0) AS valor_vendas,
            COALESCE(SUM(p.custo), 0) AS custo
          FROM pedidos_senha p
          LEFT JOIN fornecedores f
            ON f.id = p.fornecedor_id
          ${where}
          GROUP BY p.fornecedor_id, f.nome
          ORDER BY quantidade DESC
        `, parametros);

        const [porOrigem] = await pool.query(`
          SELECT
            COALESCE(os.nome, 'Não definida') AS origem,
            COUNT(*) AS quantidade,
            COALESCE(SUM(p.valor_venda), 0) AS valor_vendas,
            COALESCE(SUM(p.custo), 0) AS custo
          FROM pedidos_senha p
          LEFT JOIN origens_senha os
            ON os.id = p.origem_id
          ${where}
          GROUP BY p.origem_id, os.nome
          ORDER BY quantidade DESC
        `, parametros);

        const [porDia] = await pool.query(`
          SELECT
            DATE_FORMAT(DATE(p.criado_em), '%Y-%m-%d') AS data,
            COUNT(*) AS quantidade,
            COALESCE(SUM(p.valor_venda), 0) AS valor_vendas,
            COALESCE(SUM(p.custo), 0) AS custo
          FROM pedidos_senha p
          ${where}
          GROUP BY DATE_FORMAT(DATE(p.criado_em), '%Y-%m-%d')
          ORDER BY data
        `, parametros);

        return res.json({
          ok: true,
          periodo: {
            inicio: inicio || null,
            fim: fim || null,
            padrao_dias: inicio ? null : 30
          },
          resumo: resumo[0],
          por_status: porStatus,
          por_fornecedor: porFornecedor,
          por_origem: porOrigem,
          por_dia: porDia
        });
      } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao gerar relatório operacional'
        });
      }
    }
  );
};
