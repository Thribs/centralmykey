const processarPedidoPago = require('./processar-pedido-pago');

module.exports = function (app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  // ============================================================
  // CONFIGURAR COBRANÇA E CRÉDITO DO CLIENTE
  // ============================================================

  app.patch(
    '/api/clientes/:id/cobranca',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'editar'),
    async (req, res) => {
      const connection = await pool.getConnection();

      try {
        const clienteId = Number(req.params.id);

        const {
          tipo_cobranca,
          dia_fechamento,
          prazo_pagamento_dias,
          limite_credito,
          credito_status,
          credito_observacao
        } = req.body;

        if (!Number.isInteger(clienteId) || clienteId <= 0) {
          return res.status(400).json({
            ok: false,
            error: 'Cliente inválido'
          });
        }

        const tiposPermitidos = [
          'ANTECIPADO',
          'FATURAMENTO_SEMANAL'
        ];

        const statusPermitidos = [
          'LIBERADO',
          'BLOQUEADO'
        ];

        if (!tiposPermitidos.includes(tipo_cobranca)) {
          return res.status(400).json({
            ok: false,
            error: 'Tipo de cobrança inválido'
          });
        }

        if (
          credito_status &&
          !statusPermitidos.includes(credito_status)
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Status de crédito inválido'
          });
        }

        let fechamento = null;
        let prazo = 0;

        if (tipo_cobranca === 'FATURAMENTO_SEMANAL') {
          fechamento = Number(
            dia_fechamento === undefined ? 0 : dia_fechamento
          );

          prazo = Number(
            prazo_pagamento_dias === undefined
              ? 3
              : prazo_pagamento_dias
          );

          if (
            !Number.isInteger(fechamento) ||
            fechamento < 0 ||
            fechamento > 6
          ) {
            return res.status(400).json({
              ok: false,
              error: 'Dia de fechamento deve estar entre 0 e 6'
            });
          }

          if (
            !Number.isInteger(prazo) ||
            prazo < 0 ||
            prazo > 60
          ) {
            return res.status(400).json({
              ok: false,
              error: 'Prazo de pagamento inválido'
            });
          }
        }

        let limite = null;

        if (
          limite_credito !== undefined &&
          limite_credito !== null &&
          limite_credito !== ''
        ) {
          limite = Number(limite_credito);

          if (!Number.isFinite(limite) || limite < 0) {
            return res.status(400).json({
              ok: false,
              error: 'Limite de crédito inválido'
            });
          }
        }

        await connection.beginTransaction();

        const [clientes] = await connection.query(
          `SELECT
             id,
             nome,
             tipo_cobranca,
             dia_fechamento,
             prazo_pagamento_dias,
             limite_credito,
             credito_status,
             credito_observacao
           FROM clientes
           WHERE id = ?
             AND ativo = 1
           LIMIT 1
           FOR UPDATE`,
          [clienteId]
        );

        if (!clientes.length) {
          await connection.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Cliente não encontrado ou inativo'
          });
        }

        const dadosAntes = clientes[0];

        const dadosDepois = {
          tipo_cobranca,
          dia_fechamento: fechamento,
          prazo_pagamento_dias: prazo,
          limite_credito: limite,
          credito_status: credito_status || 'LIBERADO',
          credito_observacao: credito_observacao
            ? String(credito_observacao).trim()
            : null
        };

        await connection.query(
          `UPDATE clientes
           SET tipo_cobranca = ?,
               dia_fechamento = ?,
               prazo_pagamento_dias = ?,
               limite_credito = ?,
               credito_status = ?,
               credito_observacao = ?
           WHERE id = ?`,
          [
            dadosDepois.tipo_cobranca,
            dadosDepois.dia_fechamento,
            dadosDepois.prazo_pagamento_dias,
            dadosDepois.limite_credito,
            dadosDepois.credito_status,
            dadosDepois.credito_observacao,
            clienteId
          ]
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
           VALUES (?, 'FINANCEIRO', 'ALTERAR_COBRANCA',
                   'clientes', ?, ?, ?, ?, ?)`,
          [
            req.usuario.id,
            String(clienteId),
            `Cobrança do cliente ${dadosAntes.nome} alterada`,
            JSON.stringify(dadosAntes),
            JSON.stringify(dadosDepois),
            req.ip || null
          ]
        );

        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Configuração de cobrança atualizada',
          cliente: {
            id: clienteId,
            nome: dadosAntes.nome,
            ...dadosDepois
          }
        });

      } catch (error) {
        await connection.rollback();

        console.error(
          'Erro ao configurar cobrança do cliente:',
          error
        );

        return res.status(500).json({
          ok: false,
          error: 'Erro ao configurar cobrança do cliente'
        });

      } finally {
        connection.release();
      }
    }
  );

  // ============================================================
  // CONFIRMAR PAGAMENTO MANUAL DE PEDIDO ANTECIPADO
  // ============================================================

  app.post(
    '/api/pedidos/:id/pagamento/confirmar-manual',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'aprovar'),
    async (req, res) => {
      const connection = await pool.getConnection();

      try {
        const pedidoId = Number(req.params.id);

        const {
          meio_pagamento,
          referencia_externa,
          comprovante_url,
          observacao
        } = req.body;

        if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
          return res.status(400).json({
            ok: false,
            error: 'Pedido invalido'
          });
        }

        const meiosPermitidos = [
          'PIX',
          'SICOOB',
          'PLUGPAY',
          'WBUY',
          'CARTAO',
          'DINHEIRO',
          'TRANSFERENCIA',
          'OUTRO'
        ];

        if (!meiosPermitidos.includes(meio_pagamento)) {
          return res.status(400).json({
            ok: false,
            error: 'Meio de pagamento invalido'
          });
        }

        if (!referencia_externa && !comprovante_url) {
          return res.status(400).json({
            ok: false,
            error:
              'Informe a referencia ou o comprovante do pagamento'
          });
        }

        if (
          referencia_externa &&
          String(referencia_externa).length > 120
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Referencia externa muito longa'
          });
        }

        await connection.beginTransaction();

        const [pedidos] = await connection.query(
          `SELECT
             p.id,
             p.protocolo,
             p.cliente_id,
             p.valor_venda,
             p.moeda,
             p.status,
             c.nome AS cliente,
             s.nome AS servico
           FROM pedidos_senha p
           INNER JOIN clientes c
             ON c.id = p.cliente_id
           INNER JOIN servicos s
             ON s.id = p.servico_id
           WHERE p.id = ?
           LIMIT 1
           FOR UPDATE`,
          [pedidoId]
        );

        if (!pedidos.length) {
          await connection.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Pedido nao encontrado'
          });
        }

        const pedido = pedidos[0];

        if (pedido.status !== 'AGUARDANDO_PAGAMENTO') {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Pedido nao esta aguardando pagamento',
            status_atual: pedido.status
          });
        }

        const valor = Number(pedido.valor_venda);

        if (!Number.isFinite(valor) || valor <= 0) {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Pedido sem valor valido para pagamento'
          });
        }

        const [lancamento] = await connection.query(
          `INSERT INTO lancamentos_financeiros (
             tipo,
             cliente_id,
             pedido_senha_id,
             descricao,
             valor,
             moeda,
             data_competencia,
             status,
             origem,
             criado_por
           )
           VALUES (
             'RECEITA',
             ?,
             ?,
             ?,
             ?,
             ?,
             CURDATE(),
             'RECEBIDO',
             'CONFIRMACAO_MANUAL',
             ?
           )`,
          [
            pedido.cliente_id,
            pedido.id,
            `Pagamento do pedido ${pedido.protocolo}`,
            valor,
            pedido.moeda,
            req.usuario.id
          ]
        );

        const [pagamento] = await connection.query(
          `INSERT INTO pagamentos (
             lancamento_id,
             valor,
             moeda,
             data_pagamento,
             meio_pagamento,
             referencia_externa,
             comprovante_url,
             observacao,
             registrado_por
           )
           VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
          [
            lancamento.insertId,
            valor,
            pedido.moeda,
            meio_pagamento,
            referencia_externa
              ? String(referencia_externa).trim()
              : null,
            comprovante_url
              ? String(comprovante_url).trim()
              : null,
            observacao
              ? String(observacao).trim()
              : null,
            req.usuario.id
          ]
        );

        await connection.query(
          `UPDATE pedidos_senha
           SET status = 'PAGO'
           WHERE id = ?`,
          [pedido.id]
        );

        const processamento = await processarPedidoPago(
          connection,
          pedido.id,
          req.usuario.id
        );

        await connection.query(
          `INSERT INTO pedido_historico (
             pedido_id,
             usuario_id,
             tipo,
             descricao,
             dados
           )
           VALUES (?, ?, 'PAGAMENTO_CONFIRMADO', ?, ?)`,
          [
            pedido.id,
            req.usuario.id,
            'Pagamento confirmado manualmente',
            JSON.stringify({
              pagamento_id: pagamento.insertId,
              valor,
              moeda: pedido.moeda,
              meio_pagamento,
              referencia_externa:
                referencia_externa || null
            })
          ]
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
             'FINANCEIRO',
             'CONFIRMAR_PAGAMENTO',
             'pedidos_senha',
             ?,
             ?,
             ?,
             ?,
             ?
           )`,
          [
            req.usuario.id,
            String(pedido.id),
            `Pagamento do pedido ${pedido.protocolo} confirmado`,
            JSON.stringify({
              status: 'AGUARDANDO_PAGAMENTO'
            }),
            JSON.stringify({
              status: processamento.status,
              pagamento_id: pagamento.insertId,
              lancamento_id: lancamento.insertId,
              valor,
              moeda: pedido.moeda,
              meio_pagamento
            }),
            req.ip || null
          ]
        );

        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Pagamento confirmado manualmente',
          pedido: {
            id: pedido.id,
            protocolo: pedido.protocolo,
            cliente: pedido.cliente,
            servico: pedido.servico,
            status: processamento.status
          },
          pagamento: {
            id: pagamento.insertId,
            lancamento_id: lancamento.insertId,
            valor,
            moeda: pedido.moeda,
            meio_pagamento,
            confirmado_por: req.usuario.nome
          },
        processamento
        });

      } catch (error) {
        await connection.rollback();

        console.error(
          'Erro ao confirmar pagamento manual:',
          error
        );

        return res.status(500).json({
          ok: false,
          error: 'Erro ao confirmar pagamento manual'
        });

      } finally {
        connection.release();
      }
    }
  );


  // ============================================================
  // LISTAR FATURAS SEMANAIS DOS CLIENTES
  // ============================================================

  app.get(
    '/api/faturas',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'visualizar'),
    async (req, res) => {
      try {
        const clienteId = req.query.cliente_id
          ? Number(req.query.cliente_id)
          : null;

        const statusFiltro = String(req.query.status || '')
          .trim()
          .toUpperCase();

        const statusPermitidos = new Set([
          'ABERTA',
          'FECHADA',
          'PAGA',
          'VENCIDA',
          'CANCELADA'
        ]);

        if (
          clienteId !== null &&
          (!Number.isInteger(clienteId) || clienteId <= 0)
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Cliente inválido'
          });
        }

        if (statusFiltro && !statusPermitidos.has(statusFiltro)) {
          return res.status(400).json({
            ok: false,
            error: 'Status de fatura inválido'
          });
        }

        let sql = `
          SELECT
            f.id,
            f.cliente_id,
            c.nome AS cliente,
            c.telefone,
            DATE_FORMAT(f.periodo_inicio, '%Y-%m-%d') AS periodo_inicio,
            DATE_FORMAT(f.periodo_fim, '%Y-%m-%d') AS periodo_fim,
            DATE_FORMAT(f.vencimento, '%Y-%m-%d') AS vencimento,
            f.moeda,
            f.valor_total,
            f.status AS status_registrado,
            CASE
              WHEN f.status IN ('ABERTA', 'FECHADA')
                   AND f.vencimento < CURDATE()
                THEN 'VENCIDA'
              ELSE f.status
            END AS status,
            (
              SELECT COUNT(*)
              FROM fatura_itens fi
              WHERE fi.fatura_id = f.id
            ) AS quantidade_pedidos,
            f.observacao,
            f.criado_em,
            f.fechado_em,
            f.pago_em
          FROM faturas_clientes f
          INNER JOIN clientes c
            ON c.id = f.cliente_id
          WHERE 1 = 1
        `;

        const params = [];

        if (clienteId !== null) {
          sql += ' AND f.cliente_id = ?';
          params.push(clienteId);
        }

        if (statusFiltro === 'VENCIDA') {
          sql += `
            AND (
              f.status = 'VENCIDA'
              OR (
                f.status IN ('ABERTA', 'FECHADA')
                AND f.vencimento < CURDATE()
              )
            )
          `;
        } else if (statusFiltro) {
          sql += ' AND f.status = ?';
          params.push(statusFiltro);
        }

        sql += `
          ORDER BY
            CASE
              WHEN f.status IN ('ABERTA', 'FECHADA')
                   AND f.vencimento < CURDATE()
                THEN 0
              ELSE 1
            END,
            f.vencimento ASC,
            f.id DESC
          LIMIT 200
        `;

        const [faturas] = await pool.query(sql, params);

        return res.json({
          ok: true,
          total: faturas.length,
          dados: faturas
        });

      } catch (error) {
        console.error('Erro ao listar faturas:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao listar faturas'
        });
      }
    }
  );


  // ============================================================
  // DETALHAR FATURA E PEDIDOS COBRADOS
  // ============================================================

  app.get(
    '/api/faturas/:id',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'visualizar'),
    async (req, res) => {
      try {
        const faturaId = Number(req.params.id);

        if (!Number.isInteger(faturaId) || faturaId <= 0) {
          return res.status(400).json({
            ok: false,
            error: 'Fatura inválida'
          });
        }

        const [faturas] = await pool.query(
          `SELECT
             f.id,
             f.cliente_id,
             c.nome AS cliente,
             c.telefone,
             c.email,
             c.tipo_cobranca,
             DATE_FORMAT(f.periodo_inicio, '%Y-%m-%d') AS periodo_inicio,
             DATE_FORMAT(f.periodo_fim, '%Y-%m-%d') AS periodo_fim,
             DATE_FORMAT(f.vencimento, '%Y-%m-%d') AS vencimento,
             f.moeda,
             f.valor_total,
             f.status AS status_registrado,
             CASE
               WHEN f.status IN ('ABERTA', 'FECHADA')
                    AND f.vencimento < CURDATE()
                 THEN 'VENCIDA'
               ELSE f.status
             END AS status,
             f.observacao,
             f.criado_em,
             f.fechado_em,
             f.pago_em
           FROM faturas_clientes f
           INNER JOIN clientes c
             ON c.id = f.cliente_id
           WHERE f.id = ?
           LIMIT 1`,
          [faturaId]
        );

        if (!faturas.length) {
          return res.status(404).json({
            ok: false,
            error: 'Fatura não encontrada'
          });
        }

        const [itens] = await pool.query(
          `SELECT
             fi.id,
             fi.pedido_senha_id,
             p.protocolo,
             s.codigo AS servico_codigo,
             s.nome AS servico,
             p.placa,
             p.chassi,
             p.marca,
             p.modelo,
             p.status AS pedido_status,
             fi.valor,
             p.moeda,
             p.criado_em
           FROM fatura_itens fi
           INNER JOIN pedidos_senha p
             ON p.id = fi.pedido_senha_id
           INNER JOIN servicos s
             ON s.id = p.servico_id
           WHERE fi.fatura_id = ?
           ORDER BY p.criado_em ASC, p.id ASC`,
          [faturaId]
        );

        return res.json({
          ok: true,
          fatura: faturas[0],
          total_itens: itens.length,
          itens
        });

      } catch (error) {
        console.error('Erro ao detalhar fatura:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao detalhar fatura'
        });
      }
    }
  );


  // ============================================================
  // CONFIRMAR PAGAMENTO MANUAL DE FATURA SEMANAL
  // ============================================================

  app.post(
    '/api/faturas/:id/pagamento/confirmar-manual',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'aprovar'),
    async (req, res) => {
      const connection = await pool.getConnection();

      try {
        const faturaId = Number(req.params.id);

        const {
          meio_pagamento,
          referencia_externa,
          comprovante_url,
          observacao
        } = req.body;

        if (!Number.isInteger(faturaId) || faturaId <= 0) {
          return res.status(400).json({
            ok: false,
            error: 'Fatura inválida'
          });
        }

        const meiosPermitidos = [
          'PIX',
          'SICOOB',
          'PLUGPAY',
          'WBUY',
          'CARTAO',
          'DINHEIRO',
          'TRANSFERENCIA',
          'OUTRO'
        ];

        if (!meiosPermitidos.includes(meio_pagamento)) {
          return res.status(400).json({
            ok: false,
            error: 'Meio de pagamento inválido'
          });
        }

        if (
          !referencia_externa &&
          !comprovante_url &&
          meio_pagamento !== 'DINHEIRO'
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Informe a referência ou o comprovante do pagamento'
          });
        }

        await connection.beginTransaction();

        const [faturas] = await connection.query(
          `SELECT
             f.id,
             f.cliente_id,
             f.periodo_inicio,
             f.periodo_fim,
             f.vencimento,
             f.moeda,
             f.valor_total,
             f.status,
             c.nome AS cliente
           FROM faturas_clientes f
           INNER JOIN clientes c
             ON c.id = f.cliente_id
           WHERE f.id = ?
           LIMIT 1
           FOR UPDATE`,
          [faturaId]
        );

        if (!faturas.length) {
          await connection.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Fatura não encontrada'
          });
        }

        const fatura = faturas[0];

        if (fatura.status === 'PAGA') {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Fatura já está paga'
          });
        }

        if (fatura.status === 'CANCELADA') {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Fatura cancelada não pode receber pagamento'
          });
        }

        const valor = Number(fatura.valor_total);

        if (!Number.isFinite(valor) || valor <= 0) {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Fatura sem valor válido para pagamento'
          });
        }

        const [lancamento] = await connection.query(
          `INSERT INTO lancamentos_financeiros (
             tipo,
             cliente_id,
             fatura_id,
             descricao,
             valor,
             moeda,
             data_competencia,
             vencimento,
             status,
             origem,
             criado_por
           )
           VALUES (
             'RECEITA',
             ?,
             ?,
             ?,
             ?,
             ?,
             CURDATE(),
             ?,
             'RECEBIDO',
             'FATURA_SEMANAL',
             ?
           )`,
          [
            fatura.cliente_id,
            fatura.id,
            `Pagamento da fatura semanal ${fatura.id}`,
            valor,
            fatura.moeda,
            fatura.vencimento,
            req.usuario.id
          ]
        );

        const [pagamento] = await connection.query(
          `INSERT INTO pagamentos (
             lancamento_id,
             valor,
             moeda,
             data_pagamento,
             meio_pagamento,
             referencia_externa,
             comprovante_url,
             observacao,
             registrado_por
           )
           VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
          [
            lancamento.insertId,
            valor,
            fatura.moeda,
            meio_pagamento,
            referencia_externa
              ? String(referencia_externa).trim()
              : null,
            comprovante_url
              ? String(comprovante_url).trim()
              : null,
            observacao
              ? String(observacao).trim()
              : null,
            req.usuario.id
          ]
        );

        await connection.query(
          `UPDATE faturas_clientes
           SET
             status = 'PAGA',
             fechado_em = COALESCE(fechado_em, NOW()),
             pago_em = NOW(),
             credito_analisado_por = ?
           WHERE id = ?`,
          [req.usuario.id, fatura.id]
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
             'FINANCEIRO',
             'CONFIRMAR_PAGAMENTO_FATURA',
             'faturas_clientes',
             ?,
             ?,
             ?,
             ?,
             ?
           )`,
          [
            req.usuario.id,
            String(fatura.id),
            `Pagamento da fatura semanal ${fatura.id} confirmado`,
            JSON.stringify({
              status: fatura.status
            }),
            JSON.stringify({
              status: 'PAGA',
              pagamento_id: pagamento.insertId,
              lancamento_id: lancamento.insertId,
              valor,
              moeda: fatura.moeda,
              meio_pagamento
            }),
            req.ip || null
          ]
        );

        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Pagamento da fatura confirmado manualmente',
          fatura: {
            id: fatura.id,
            cliente_id: fatura.cliente_id,
            cliente: fatura.cliente,
            status: 'PAGA',
            valor,
            moeda: fatura.moeda
          },
          pagamento: {
            id: pagamento.insertId,
            lancamento_id: lancamento.insertId,
            meio_pagamento,
            confirmado_por: req.usuario.nome
          }
        });

      } catch (error) {
        await connection.rollback();

        console.error(
          'Erro ao confirmar pagamento da fatura:',
          error
        );

        return res.status(500).json({
          ok: false,
          error: 'Erro ao confirmar pagamento da fatura'
        });

      } finally {
        connection.release();
      }
    }
  );


  // ============================================================
  // FECHAR FATURA SEMANAL
  // ============================================================

  app.post(
    '/api/faturas/:id/fechar',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'editar'),
    async (req, res) => {
      const connection = await pool.getConnection();

      try {
        const faturaId = Number(req.params.id);

        if (!Number.isInteger(faturaId) || faturaId <= 0) {
          return res.status(400).json({
            ok: false,
            error: 'Fatura inválida'
          });
        }

        await connection.beginTransaction();

        const [faturas] = await connection.query(
          `SELECT
             f.id,
             f.cliente_id,
             f.moeda,
             f.valor_total,
             f.status,
             f.periodo_inicio,
             f.periodo_fim,
             c.nome AS cliente
           FROM faturas_clientes f
           INNER JOIN clientes c
             ON c.id = f.cliente_id
           WHERE f.id = ?
           LIMIT 1
           FOR UPDATE`,
          [faturaId]
        );

        if (!faturas.length) {
          await connection.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Fatura não encontrada'
          });
        }

        const fatura = faturas[0];

        if (fatura.status !== 'ABERTA') {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Somente fatura aberta pode ser fechada',
            status_atual: fatura.status
          });
        }

        const [totais] = await connection.query(
          `SELECT
             COUNT(*) AS quantidade_itens,
             COALESCE(SUM(valor), 0) AS valor_total
           FROM fatura_itens
           WHERE fatura_id = ?`,
          [fatura.id]
        );

        const quantidadeItens = Number(totais[0].quantidade_itens);
        const valorTotal = Number(totais[0].valor_total);

        if (quantidadeItens <= 0 || valorTotal <= 0) {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Fatura sem pedidos válidos para fechamento'
          });
        }

        await connection.query(
          `UPDATE faturas_clientes
           SET
             valor_total = ?,
             status = 'FECHADA',
             fechado_em = NOW(),
             credito_analisado_por = ?
           WHERE id = ?`,
          [
            valorTotal,
            req.usuario.id,
            fatura.id
          ]
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
             'FINANCEIRO',
             'FECHAR_FATURA',
             'faturas_clientes',
             ?,
             ?,
             ?,
             ?,
             ?
           )`,
          [
            req.usuario.id,
            String(fatura.id),
            `Fatura semanal ${fatura.id} fechada`,
            JSON.stringify({
              status: fatura.status,
              valor_total: Number(fatura.valor_total)
            }),
            JSON.stringify({
              status: 'FECHADA',
              valor_total: valorTotal,
              quantidade_itens: quantidadeItens
            }),
            req.ip || null
          ]
        );

        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Fatura fechada com sucesso',
          fatura: {
            id: fatura.id,
            cliente_id: fatura.cliente_id,
            cliente: fatura.cliente,
            status: 'FECHADA',
            valor_total: valorTotal,
            moeda: fatura.moeda,
            quantidade_itens: quantidadeItens
          }
        });

      } catch (error) {
        await connection.rollback();

        console.error('Erro ao fechar fatura:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao fechar fatura'
        });

      } finally {
        connection.release();
      }
    }
  );

};
