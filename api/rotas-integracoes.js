'use strict';

const {
  obterConfiguracaoSicoob,
  obterConfiguracaoBling,
  obterConfiguracaoWBuy
} = require('./configuracoes-integracoes');
const {
  criarCobrancaPedidoSicoob,
  processarWebhookSicoob
} = require('./sicoob-pix');
const { receberEventoBling } = require('./webhook-bling');
const { sincronizarPedidoWBuy } = require('./wbuy-pedidos');

module.exports = function registrarRotasIntegracoes(app, pool, opcoes = {}) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  const proxyMtlsConfirmado = req => {
    const endereco = String(req.socket?.remoteAddress || '');
    const local = endereco === '127.0.0.1' || endereco === '::1' ||
      endereco === '::ffff:127.0.0.1';
    return local && req.get('x-client-cert-verify') === 'SUCCESS';
  };

  app.post('/webhooks/sicoob', async (req, res) => {
    try {
      const config = opcoes.configuracaoSicoob || await obterConfiguracaoSicoob(pool);
      if (!config.webhookHabilitado) {
        return res.status(503).json({ ok: false,
          codigo: 'SICOOB_WEBHOOK_DESABILITADO',
          error: 'Webhook Sicoob desabilitado' });
      }
      if (!proxyMtlsConfirmado(req)) {
        return res.status(401).json({ ok: false,
          codigo: 'CERTIFICADO_CLIENTE_INVALIDO',
          error: 'Certificado de cliente inválido' });
      }
      const corpoBruto = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      const resultado = await processarWebhookSicoob(pool, corpoBruto);
      return res.status(200).json(resultado);
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) {
        console.error('Erro ao receber webhook Sicoob:', error.codigo || error.message);
      }
      return res.status(status).json({ ok: false,
        codigo: error.codigo || 'ERRO_WEBHOOK_SICOOB',
        error: status >= 500 ? 'Webhook Sicoob indisponível' : error.message });
    }
  });

  app.post('/webhooks/bling', async (req, res) => {
    try {
      const config = opcoes.configuracaoBling || await obterConfiguracaoBling(pool);
      const resultado = await receberEventoBling(pool, {
        payload: req.body,
        corpoBruto: req.rawBody || Buffer.from(''),
        assinatura: req.get('x-bling-signature-256'),
        segredo: config.clientSecret
      });
      return res.status(resultado.idempotente ? 200 : 202).json(resultado);
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) {
        console.error('Erro ao receber webhook Bling:', error.codigo || error.message);
      }
      return res.status(status).json({
        ok: false,
        codigo: error.codigo || 'ERRO_WEBHOOK_BLING',
        error: status >= 500 ? 'Webhook Bling indisponível' : error.message
      });
    }
  });

  app.get('/api/pagamentos/sicoob/status', autenticarToken,
    exigirPermissao('FINANCEIRO', 'visualizar'), async (req, res) => {
      try {
        const config = opcoes.configuracaoSicoob || await obterConfiguracaoSicoob(pool);
        const disponivel = Boolean(config.habilitado && config.webhookHabilitado);
        return res.json({
          ok: true,
          disponivel,
          codigo: disponivel ? 'PRONTO' : 'HOMOLOGACAO_PENDENTE'
        });
      } catch (error) {
        console.error('Erro ao consultar disponibilidade Sicoob:', error.message);
        return res.status(500).json({
          ok: false,
          disponivel: false,
          codigo: 'ERRO_STATUS_SICOOB',
          error: 'Não foi possível consultar a disponibilidade do Sicoob'
        });
      }
    });

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
    exigirPermissao('INTEGRACOES', 'visualizar'), async (req, res) => {
      const provedor = String(req.query.provedor || '').trim().toUpperCase();
      const status = String(req.query.status || '').trim().toUpperCase();
      const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);
      const provedores = ['SICOOB', 'PLUGPAY', 'WBUY', 'BLING'];
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
        if (provedor) { filtros.push('e.provedor = ?'); params.push(provedor); }
        if (status) { filtros.push('e.status = ?'); params.push(status); }
        params.push(limite);
        const [dados] = await pool.query(
          `SELECT e.id, e.provedor, e.evento_externo_id, e.tipo,
                  e.referencia_externa, e.entidade, e.entidade_id,
                  e.lancamento_id, e.pagamento_id, e.status, e.tentativas,
                  e.erro_codigo, e.erro_detalhe, e.recebido_em,
                  e.processado_em, e.atualizado_em,
                  pg.valor AS valor_pagamento, pg.moeda AS moeda_pagamento
             FROM integracao_eventos e
             LEFT JOIN pagamentos pg ON pg.id = e.pagamento_id
             ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
            ORDER BY e.id DESC LIMIT ?`,
          params
        );
        return res.json({ ok: true, total: dados.length, dados });
      } catch (error) {
        console.error('Erro ao listar eventos de integração:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar eventos de integração' });
      }
    });

  app.get('/api/integracoes/referencias-pagamento', autenticarToken,
    exigirPermissao('INTEGRACOES', 'visualizar'), async (req, res) => {
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

  app.post('/api/integracoes/wbuy/pedidos/:id/sincronizar', autenticarToken,
    exigirPermissao('INTEGRACOES', 'editar'), async (req, res) => {
      try {
        const config = opcoes.configuracaoWBuy || await obterConfiguracaoWBuy(pool);
        const resultado = await sincronizarPedidoWBuy(pool, config, req.params.id, {
          transporte: opcoes.transporteWBuy,
          timeoutMs: opcoes.timeoutWBuyMs,
          usuarioId: req.usuario?.id || null,
          ip: req.ip || null
        });
        return res.status(resultado.idempotente ? 200 : 201).json(resultado);
      } catch (error) {
        const status = Number(error.status) || 500;
        if (status >= 500) {
          console.error('Erro ao sincronizar pedido WBuy:', error.codigo || error.message);
        }
        return res.status(status).json({
          ok: false,
          codigo: error.codigo || 'ERRO_WBUY',
          error: status >= 500 && !error.codigo
            ? 'Integração WBuy indisponível'
            : error.message
        });
      }
    });
};
