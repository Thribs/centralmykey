'use strict';

const { obterConfiguracaoSicoob } = require('./configuracoes-integracoes');
const { criarCobrancaPedidoSicoob } = require('./sicoob-pix');

module.exports = function registrarRotasIntegracoes(app, pool, opcoes = {}) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  app.post('/api/pedidos/:id/pagamentos/sicoob', autenticarToken,
    exigirPermissao('FINANCEIRO', 'editar'), async (req, res) => {
      const pedidoId = Number(req.params.id);
      if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
        return res.status(400).json({ ok: false, error: 'Pedido inválido' });
      }
      try {
        const config = opcoes.configuracaoSicoob || await obterConfiguracaoSicoob(pool);
        const resultado = await criarCobrancaPedidoSicoob(pool, pedidoId, config, {
          expiracaoSegundos: req.body?.expiracao_segundos,
          solicitacaoPagador: req.body?.solicitacao_pagador,
          transporte: opcoes.transporteSicoob,
          usuarioId: req.usuario?.id || null,
          ip: req.ip || null
        });
        return res.status(201).json(resultado);
      } catch (error) {
        const status = Number(error.status) || 500;
        if (status >= 500) console.error('Erro ao criar cobrança Sicoob:', error.codigo || error.message);
        return res.status(status).json({ ok: false,
          error: status >= 500 ? 'Integração Sicoob indisponível' : error.message,
          codigo: error.codigo || 'ERRO_SICOOB' });
      }
    });

  app.get('/api/integracoes/eventos', autenticarToken,
    exigirPermissao('CONFIGURACOES', 'visualizar'), async (req, res) => {
      const provedor = String(req.query.provedor || '').trim().toUpperCase();
      const status = String(req.query.status || '').trim().toUpperCase();
      const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);
      const provedores = ['SICOOB', 'PLUGPAY', 'WBUY'];
      const estados = ['RECEBIDO', 'PROCESSADO', 'IGNORADO', 'FALHOU'];
      if (provedor && !provedores.includes(provedor)) {
        return res.status(400).json({ ok: false, error: 'Provedor inválido' });
      }
      if (status && !estados.includes(status)) {
        return res.status(400).json({ ok: false, error: 'Status inválido' });
      }
      try {
        const filtros = [];
        const params = [];
        if (provedor) { filtros.push('provedor = ?'); params.push(provedor); }
        if (status) { filtros.push('status = ?'); params.push(status); }
        params.push(limite);
        const [dados] = await pool.query(
          `SELECT id, provedor, evento_externo_id, tipo, referencia_externa,
                  entidade, entidade_id, lancamento_id, pagamento_id, status,
                  tentativas, erro_codigo, erro_detalhe, recebido_em,
                  processado_em, atualizado_em
             FROM integracao_eventos
             ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
            ORDER BY id DESC LIMIT ?`,
          params
        );
        return res.json({ ok: true, total: dados.length, dados });
      } catch (error) {
        console.error('Erro ao listar eventos de integração:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar eventos de integração' });
      }
    });

  app.get('/api/integracoes/referencias-pagamento', autenticarToken,
    exigirPermissao('CONFIGURACOES', 'visualizar'), async (req, res) => {
      const provedor = String(req.query.provedor || '').trim().toUpperCase();
      const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);
      if (provedor && !['SICOOB', 'PLUGPAY', 'WBUY'].includes(provedor)) {
        return res.status(400).json({ ok: false, error: 'Provedor inválido' });
      }
      try {
        const params = [];
        const filtro = provedor ? 'WHERE provedor=?' : '';
        if (provedor) params.push(provedor);
        params.push(limite);
        const [dados] = await pool.query(
          `SELECT id, provedor, entidade, entidade_id, referencia_provedor,
                  valor, moeda, status, identificador_pagamento, location,
                  pix_copia_cola, erro_codigo,
                  erro_detalhe, criada_em, registrada_em, paga_em, atualizada_em
             FROM integracao_referencias_pagamento ${filtro}
            ORDER BY id DESC LIMIT ?`,
          params
        );
        return res.json({ ok: true, total: dados.length, dados });
      } catch (error) {
        console.error('Erro ao listar referências de pagamento:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar referências de pagamento' });
      }
    });
};
