'use strict';

const { cancelarPedido } = require('./cancelar-pedido');
const { estornarPagamentoManual } = require('./estornar-pagamento');

function responderErro(res, error) {
  if (error.codigo) {
    return res.status(error.statusHttp || 409).json({
      ok: false,
      codigo: error.codigo,
      error: error.message
    });
  }
  console.error('Erro no fluxo de estorno:', error);
  return res.status(500).json({ ok: false, error: 'Erro ao registrar estorno' });
}

module.exports = function (app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  app.post(
    '/api/pedidos/:id/estornar-pagamento',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'aprovar'),
    async (req, res) => {
      const pedidoId = Number(req.params.id);
      if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
        return res.status(400).json({ ok: false, error: 'Pedido inválido' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const estorno = await estornarPagamentoManual(connection, {
          pedidoId,
          usuarioId: req.usuario.id,
          dados: req.body,
          ip: req.ip || null
        });
        await connection.commit();
        return res.json({
          ok: true,
          mensagem: estorno.idempotente
            ? 'Estorno já registrado anteriormente'
            : 'Estorno registrado',
          estorno
        });
      } catch (error) {
        await connection.rollback();
        return responderErro(res, error);
      } finally {
        connection.release();
      }
    }
  );

  app.post(
    '/api/pedidos/:id/estornar-e-cancelar',
    autenticarToken,
    exigirPermissao('FINANCEIRO', 'aprovar'),
    exigirPermissao('PEDIDOS_SENHAS', 'editar'),
    async (req, res) => {
      const pedidoId = Number(req.params.id);
      if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
        return res.status(400).json({ ok: false, error: 'Pedido inválido' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const estorno = await estornarPagamentoManual(connection, {
          pedidoId,
          usuarioId: req.usuario.id,
          dados: req.body,
          ip: req.ip || null
        });
        const cancelamento = await cancelarPedido(connection, {
          pedidoId,
          usuarioId: req.usuario.id,
          motivo: req.body?.motivo_cancelamento || req.body?.motivo,
          ip: req.ip || null
        });
        await connection.commit();
        return res.json({
          ok: true,
          mensagem: 'Pagamento estornado e pedido cancelado',
          estorno,
          cancelamento
        });
      } catch (error) {
        await connection.rollback();
        return responderErro(res, error);
      } finally {
        connection.release();
      }
    }
  );
};
