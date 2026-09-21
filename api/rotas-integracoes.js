'use strict';

module.exports = function registrarRotasIntegracoes(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

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
};
