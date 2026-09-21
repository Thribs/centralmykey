'use strict';

function dataIso(valor) {
  const texto = String(valor || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
}

function validarSemana(inicio, fim) {
  if (!inicio || !fim) return false;
  const dataInicio = new Date(`${inicio}T00:00:00Z`);
  const dataFim = new Date(`${fim}T00:00:00Z`);
  if (
    Number.isNaN(dataInicio.getTime()) ||
    Number.isNaN(dataFim.getTime()) ||
    dataInicio.toISOString().slice(0, 10) !== inicio ||
    dataFim.toISOString().slice(0, 10) !== fim
  ) return false;
  const dias = (dataFim - dataInicio) / 86400000;
  return dataInicio.getUTCDay() === 1 && dias === 6;
}

function erroNegocio(codigo, mensagem, status = 409) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.statusHttp = status;
  return erro;
}

async function buscarFechamento(connection, fechamentoId, bloquear = false) {
  const [registros] = await connection.query(
    `SELECT
       ff.id, ff.fornecedor_id, f.nome AS fornecedor,
       DATE_FORMAT(ff.periodo_inicio, '%Y-%m-%d') AS periodo_inicio,
       DATE_FORMAT(ff.periodo_fim, '%Y-%m-%d') AS periodo_fim,
       ff.moeda, ff.quantidade_itens, ff.valor_total, ff.status,
       ff.lancamento_financeiro_id, ff.fechado_em, ff.pago_em,
       IF(ff.periodo_fim < CURDATE(), 1, 0) AS periodo_encerrado,
       ff.criado_em, ff.atualizado_em
     FROM fechamentos_fornecedores ff
     INNER JOIN fornecedores f ON f.id = ff.fornecedor_id
     WHERE ff.id = ?
     LIMIT 1${bloquear ? ' FOR UPDATE' : ''}`,
    [fechamentoId]
  );
  return registros[0] || null;
}

async function registrarAuditoria(connection, {
  usuarioId,
  acao,
  fechamentoId,
  descricao,
  antes = null,
  depois = null,
  ip = null
}) {
  await connection.query(
    `INSERT INTO auditoria
       (usuario_id, modulo, acao, entidade, entidade_id,
        descricao, dados_antes, dados_depois, ip)
     VALUES (?, 'FINANCEIRO', ?, 'fechamentos_fornecedores', ?, ?, ?, ?, ?)`,
    [
      usuarioId,
      acao,
      String(fechamentoId),
      descricao,
      antes ? JSON.stringify(antes) : null,
      depois ? JSON.stringify(depois) : null,
      ip
    ]
  );
}

module.exports = function (app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  app.get(
    '/api/fechamentos-fornecedores',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'visualizar'),
    async (req, res) => {
      const status = String(req.query.status || '').trim().toUpperCase();
      const moeda = String(req.query.moeda || '').trim().toUpperCase();
      const fornecedorId = Number(req.query.fornecedor_id) || null;
      const permitidos = ['RASCUNHO', 'FECHADO', 'PAGO', 'CANCELADO'];
      if (status && !permitidos.includes(status)) {
        return res.status(400).json({ ok: false, error: 'Status inválido' });
      }
      if (moeda && !['BRL', 'USD', 'PYG'].includes(moeda)) {
        return res.status(400).json({ ok: false, error: 'Moeda inválida' });
      }
      try {
        const filtros = [];
        const parametros = [];
        if (status) {
          filtros.push('ff.status = ?');
          parametros.push(status);
        }
        if (fornecedorId) {
          filtros.push('ff.fornecedor_id = ?');
          parametros.push(fornecedorId);
        }
        if (moeda) {
          filtros.push('ff.moeda = ?');
          parametros.push(moeda);
        }
        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
        const [dados] = await pool.query(
          `SELECT
             ff.id, ff.fornecedor_id, f.nome AS fornecedor,
             DATE_FORMAT(ff.periodo_inicio, '%Y-%m-%d') AS periodo_inicio,
             DATE_FORMAT(ff.periodo_fim, '%Y-%m-%d') AS periodo_fim,
             ff.moeda, ff.quantidade_itens, ff.valor_total, ff.status,
             ff.lancamento_financeiro_id, ff.fechado_em, ff.pago_em,
             ff.criado_em
           FROM fechamentos_fornecedores ff
           INNER JOIN fornecedores f ON f.id = ff.fornecedor_id
           ${where}
           ORDER BY ff.periodo_fim DESC, f.nome, ff.id DESC
           LIMIT 300`,
          parametros
        );
        return res.json({ ok: true, total: dados.length, dados });
      } catch (error) {
        console.error('Erro ao listar fechamentos de fornecedores:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao listar fechamentos de fornecedores'
        });
      }
    }
  );

  app.get(
    '/api/fechamentos-fornecedores/fornecedores',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'visualizar'),
    async (req, res) => {
      try {
        const [dados] = await pool.query(
          `SELECT DISTINCT f.id, f.nome
             FROM fornecedores f
             INNER JOIN fornecedor_servicos fs ON fs.fornecedor_id = f.id
            WHERE f.ativo = 1 AND fs.ativo = 1
            ORDER BY f.nome`
        );
        return res.json({ ok: true, dados });
      } catch (error) {
        console.error('Erro ao listar fornecedores para fechamento:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao listar fornecedores para fechamento'
        });
      }
    }
  );

  app.get(
    '/api/fechamentos-fornecedores/:id',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'visualizar'),
    async (req, res) => {
      const fechamentoId = Number(req.params.id);
      if (!Number.isInteger(fechamentoId) || fechamentoId <= 0) {
        return res.status(400).json({ ok: false, error: 'Fechamento inválido' });
      }
      try {
        const fechamento = await buscarFechamento(pool, fechamentoId);
        if (!fechamento) {
          return res.status(404).json({ ok: false, error: 'Fechamento não encontrado' });
        }
        const [itens] = await pool.query(
          `SELECT
             ffi.id, ffi.pedido_senha_id, p.protocolo,
             ffi.resultado_id, ffi.custo, pr.status AS resultado_status,
             pr.criado_em AS resultado_recebido_em
           FROM fechamento_fornecedor_itens ffi
           INNER JOIN pedidos_senha p ON p.id = ffi.pedido_senha_id
           INNER JOIN pedido_resultados pr ON pr.id = ffi.resultado_id
           WHERE ffi.fechamento_id = ?
           ORDER BY pr.criado_em, ffi.id`,
          [fechamentoId]
        );
        return res.json({ ok: true, fechamento, itens });
      } catch (error) {
        console.error('Erro ao detalhar fechamento de fornecedor:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao detalhar fechamento de fornecedor'
        });
      }
    }
  );

  app.post(
    '/api/fornecedores/:id/fechamentos/gerar',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'editar'),
    async (req, res) => {
      const fornecedorId = Number(req.params.id);
      const inicio = dataIso(req.body?.periodo_inicio);
      const fim = dataIso(req.body?.periodo_fim);
      const moeda = String(req.body?.moeda || 'BRL').trim().toUpperCase();
      if (!Number.isInteger(fornecedorId) || fornecedorId <= 0) {
        return res.status(400).json({ ok: false, error: 'Fornecedor inválido' });
      }
      if (!validarSemana(inicio, fim)) {
        return res.status(400).json({
          ok: false,
          error: 'O período deve começar na segunda-feira e terminar no domingo'
        });
      }
      if (!['BRL', 'USD', 'PYG'].includes(moeda)) {
        return res.status(400).json({ ok: false, error: 'Moeda inválida' });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[fornecedor]] = await connection.query(
          'SELECT id, nome FROM fornecedores WHERE id = ? LIMIT 1 FOR UPDATE',
          [fornecedorId]
        );
        if (!fornecedor) {
          throw erroNegocio('FORNECEDOR_NAO_ENCONTRADO', 'Fornecedor não encontrado', 404);
        }

        let [[fechamento]] = await connection.query(
          `SELECT id, status, quantidade_itens, valor_total
             FROM fechamentos_fornecedores
            WHERE fornecedor_id = ? AND periodo_inicio = ?
              AND periodo_fim = ? AND moeda = ?
            LIMIT 1 FOR UPDATE`,
          [fornecedorId, inicio, fim, moeda]
        );
        if (fechamento && fechamento.status !== 'RASCUNHO') {
          await connection.rollback();
          const existente = await buscarFechamento(pool, fechamento.id);
          return res.json({ ok: true, idempotente: true, fechamento: existente });
        }
        if (!fechamento) {
          const [novo] = await connection.query(
            `INSERT INTO fechamentos_fornecedores
               (fornecedor_id, periodo_inicio, periodo_fim, moeda, gerado_por)
             VALUES (?, ?, ?, ?, ?)`,
            [fornecedorId, inicio, fim, moeda, req.usuario.id]
          );
          fechamento = { id: novo.insertId, status: 'RASCUNHO' };
        } else {
          await connection.query(
            'DELETE FROM fechamento_fornecedor_itens WHERE fechamento_id = ?',
            [fechamento.id]
          );
        }

        const [resultados] = await connection.query(
          `SELECT pr.id AS resultado_id, pr.pedido_id, pr.custo
             FROM pedido_resultados pr
             INNER JOIN pedidos_senha p ON p.id = pr.pedido_id
             LEFT JOIN fechamento_fornecedor_itens ffi
               ON ffi.resultado_id = pr.id
            WHERE pr.fornecedor_id = ?
              AND pr.status = 'CONFIRMADO'
              AND pr.custo > 0
              AND p.moeda = ?
              AND p.status <> 'CANCELADO'
              AND DATE(pr.criado_em) BETWEEN ? AND ?
              AND ffi.id IS NULL
            ORDER BY pr.criado_em, pr.id
            FOR UPDATE`,
          [fornecedorId, moeda, inicio, fim]
        );
        if (!resultados.length) {
          await connection.query(
            'DELETE FROM fechamentos_fornecedores WHERE id = ?',
            [fechamento.id]
          );
          throw erroNegocio(
            'SEM_ITENS_PARA_FECHAR',
            'Nenhum resultado confirmado encontrado para o período'
          );
        }

        let total = 0;
        for (const item of resultados) {
          total += Number(item.custo);
          await connection.query(
            `INSERT INTO fechamento_fornecedor_itens
               (fechamento_id, pedido_senha_id, resultado_id, custo)
             VALUES (?, ?, ?, ?)`,
            [fechamento.id, item.pedido_id, item.resultado_id, Number(item.custo)]
          );
        }
        total = Number(total.toFixed(2));
        await connection.query(
          `UPDATE fechamentos_fornecedores
              SET quantidade_itens = ?, valor_total = ?, gerado_por = ?
            WHERE id = ?`,
          [resultados.length, total, req.usuario.id, fechamento.id]
        );
        await registrarAuditoria(connection, {
          usuarioId: req.usuario.id,
          acao: 'GERAR_FECHAMENTO_FORNECEDOR',
          fechamentoId: fechamento.id,
          descricao: `Fechamento semanal de ${fornecedor.nome} gerado`,
          depois: {
            fornecedor_id: fornecedorId,
            periodo_inicio: inicio,
            periodo_fim: fim,
            moeda,
            quantidade_itens: resultados.length,
            valor_total: total
          },
          ip: req.ip || null
        });
        await connection.commit();
        return res.status(201).json({
          ok: true,
          idempotente: false,
          fechamento: await buscarFechamento(pool, fechamento.id)
        });
      } catch (error) {
        await connection.rollback();
        if (error.codigo) {
          return res.status(error.statusHttp || 409).json({
            ok: false,
            codigo: error.codigo,
            error: error.message
          });
        }
        console.error('Erro ao gerar fechamento de fornecedor:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao gerar fechamento' });
      } finally {
        connection.release();
      }
    }
  );

  app.post(
    '/api/fechamentos-fornecedores/:id/fechar',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'aprovar'),
    async (req, res) => {
      const fechamentoId = Number(req.params.id);
      if (!Number.isInteger(fechamentoId) || fechamentoId <= 0) {
        return res.status(400).json({ ok: false, error: 'Fechamento inválido' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const fechamento = await buscarFechamento(connection, fechamentoId, true);
        if (!fechamento) throw erroNegocio('FECHAMENTO_NAO_ENCONTRADO', 'Fechamento não encontrado', 404);
        if (['FECHADO', 'PAGO'].includes(fechamento.status)) {
          await connection.rollback();
          return res.json({ ok: true, idempotente: true, fechamento });
        }
        if (fechamento.status !== 'RASCUNHO' || Number(fechamento.quantidade_itens) <= 0) {
          throw erroNegocio('FECHAMENTO_NAO_APROVAVEL', 'Fechamento não pode ser aprovado');
        }
        if (!Number(fechamento.periodo_encerrado)) {
          throw erroNegocio(
            'PERIODO_AINDA_ABERTO',
            'O fechamento só pode ser aprovado após o término da semana'
          );
        }
        const [lancamento] = await connection.query(
          `INSERT INTO lancamentos_financeiros
             (tipo, fornecedor_id, descricao, valor, moeda,
              data_competencia, status, origem, criado_por)
           VALUES ('DESPESA', ?, ?, ?, ?, ?, 'PENDENTE',
                   'FECHAMENTO_FORNECEDOR', ?)`,
          [
            fechamento.fornecedor_id,
            `Fechamento semanal ${fechamento.periodo_inicio} a ${fechamento.periodo_fim}`,
            Number(fechamento.valor_total),
            fechamento.moeda,
            fechamento.periodo_fim,
            req.usuario.id
          ]
        );
        await connection.query(
          `UPDATE fechamentos_fornecedores
              SET status = 'FECHADO', lancamento_financeiro_id = ?,
                  fechado_por = ?, fechado_em = NOW()
            WHERE id = ?`,
          [lancamento.insertId, req.usuario.id, fechamento.id]
        );
        await registrarAuditoria(connection, {
          usuarioId: req.usuario.id,
          acao: 'APROVAR_FECHAMENTO_FORNECEDOR',
          fechamentoId: fechamento.id,
          descricao: `Fechamento semanal de ${fechamento.fornecedor} aprovado`,
          antes: { status: 'RASCUNHO' },
          depois: { status: 'FECHADO', lancamento_id: lancamento.insertId },
          ip: req.ip || null
        });
        await connection.commit();
        return res.json({
          ok: true,
          idempotente: false,
          fechamento: await buscarFechamento(pool, fechamento.id)
        });
      } catch (error) {
        await connection.rollback();
        if (error.codigo) {
          return res.status(error.statusHttp || 409).json({
            ok: false, codigo: error.codigo, error: error.message
          });
        }
        console.error('Erro ao aprovar fechamento de fornecedor:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao aprovar fechamento' });
      } finally {
        connection.release();
      }
    }
  );

  app.post(
    '/api/fechamentos-fornecedores/:id/pagar',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'aprovar'),
    async (req, res) => {
      const fechamentoId = Number(req.params.id);
      const meio = String(req.body?.meio_pagamento || '').trim().toUpperCase();
      const referencia = req.body?.referencia_externa
        ? String(req.body.referencia_externa).trim()
        : null;
      const comprovante = req.body?.comprovante_url
        ? String(req.body.comprovante_url).trim()
        : null;
      const observacao = req.body?.observacao
        ? String(req.body.observacao).trim()
        : null;
      const meios = ['PIX', 'SICOOB', 'DINHEIRO', 'TRANSFERENCIA', 'OUTRO'];
      if (!Number.isInteger(fechamentoId) || fechamentoId <= 0) {
        return res.status(400).json({ ok: false, error: 'Fechamento inválido' });
      }
      if (!meios.includes(meio)) {
        return res.status(400).json({ ok: false, error: 'Meio de pagamento inválido' });
      }
      if (meio !== 'DINHEIRO' && !referencia && !comprovante) {
        return res.status(400).json({
          ok: false,
          error: 'Informe a referência ou o comprovante do pagamento'
        });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const fechamento = await buscarFechamento(connection, fechamentoId, true);
        if (!fechamento) throw erroNegocio('FECHAMENTO_NAO_ENCONTRADO', 'Fechamento não encontrado', 404);
        const [pagamentos] = fechamento.lancamento_financeiro_id
          ? await connection.query(
              `SELECT id, meio_pagamento, referencia_externa, comprovante_url
                 FROM pagamentos WHERE lancamento_id = ?
                 ORDER BY id DESC LIMIT 1`,
              [fechamento.lancamento_financeiro_id]
            )
          : [[]];
        const existente = pagamentos[0] || null;
        const mesmaConfirmacao = existente &&
          existente.meio_pagamento === meio &&
          (existente.referencia_externa || null) === referencia &&
          (existente.comprovante_url || null) === comprovante;
        if (fechamento.status === 'PAGO' && mesmaConfirmacao) {
          await connection.rollback();
          return res.json({ ok: true, idempotente: true, fechamento, pagamento: existente });
        }
        if (fechamento.status !== 'FECHADO' || !fechamento.lancamento_financeiro_id) {
          throw erroNegocio('FECHAMENTO_NAO_PAGAVEL', 'Fechamento não está pronto para pagamento');
        }
        const [pagamento] = await connection.query(
          `INSERT INTO pagamentos
             (lancamento_id, valor, moeda, data_pagamento, meio_pagamento,
              referencia_externa, comprovante_url, observacao, registrado_por)
           VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
          [
            fechamento.lancamento_financeiro_id,
            Number(fechamento.valor_total),
            fechamento.moeda,
            meio,
            referencia,
            comprovante,
            observacao,
            req.usuario.id
          ]
        );
        await connection.query(
          `UPDATE lancamentos_financeiros SET status = 'PAGO'
            WHERE id = ?`,
          [fechamento.lancamento_financeiro_id]
        );
        await connection.query(
          `UPDATE fechamentos_fornecedores
              SET status = 'PAGO', pago_por = ?, pago_em = NOW()
            WHERE id = ?`,
          [req.usuario.id, fechamento.id]
        );
        await registrarAuditoria(connection, {
          usuarioId: req.usuario.id,
          acao: 'PAGAR_FECHAMENTO_FORNECEDOR',
          fechamentoId: fechamento.id,
          descricao: `Fechamento semanal de ${fechamento.fornecedor} pago`,
          antes: { status: 'FECHADO' },
          depois: {
            status: 'PAGO',
            pagamento_id: pagamento.insertId,
            meio_pagamento: meio
          },
          ip: req.ip || null
        });
        await connection.commit();
        return res.json({
          ok: true,
          idempotente: false,
          fechamento: await buscarFechamento(pool, fechamento.id),
          pagamento: { id: pagamento.insertId, meio_pagamento: meio }
        });
      } catch (error) {
        await connection.rollback();
        if (error.codigo) {
          return res.status(error.statusHttp || 409).json({
            ok: false, codigo: error.codigo, error: error.message
          });
        }
        console.error('Erro ao pagar fechamento de fornecedor:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao pagar fechamento' });
      } finally {
        connection.release();
      }
    }
  );
};

module.exports.validarSemana = validarSemana;
