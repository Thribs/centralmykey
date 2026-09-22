'use strict';

const { obterEstadoBackup } = require('./estado-backup');

module.exports = function registrarRotasHealth(app, pool, opcoes = {}) {
  const inteiroConfigurado = (valor, padrao, minimo = 1, maximo = 10080) => {
    const numero = Number(valor);
    return Number.isInteger(numero) && numero >= minimo && numero <= maximo
      ? numero
      : padrao;
  };

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'Central MyKey API' });
  });

  app.get('/health/ready', async (req, res) => {
    try {
      await pool.query('SELECT 1 AS ok');
      return res.json({
        ok: true,
        service: 'Central MyKey API',
        dependencies: { database: 'ready' }
      });
    } catch (erro) {
      console.error('Falha de prontidão do banco:', erro.code || erro.message);
      return res.status(503).json({
        ok: false,
        service: 'Central MyKey API',
        dependencies: { database: 'unavailable' }
      });
    }
  });

  app.get(
    '/health/db',
    app.locals.autenticarToken,
    app.locals.exigirPermissao('CONFIGURACOES', 'visualizar'),
    async (req, res) => {
      try {
        const [rows] = await pool.query(`
          SELECT
            DATABASE() AS database_name,
            VERSION() AS mysql_version,
            NOW() AS server_time
        `);
        return res.json({ ok: true, database: rows[0] });
      } catch (erro) {
        console.error('Falha na conexão com o banco:', erro.code || erro.message);
        return res.status(500).json({
          ok: false,
          error: 'Falha na conexão com o banco'
        });
      }
    }
  );

  app.get(
    '/api/monitoramento/resumo',
    app.locals.autenticarToken,
    app.locals.exigirPermissao('CONFIGURACOES', 'visualizar'),
    async (req, res) => {
      const limites = {
        pedido_atraso_minutos: inteiroConfigurado(
          process.env.MONITORAMENTO_PEDIDO_ATRASO_MINUTOS,
          30
        ),
        outbox_atraso_minutos: inteiroConfigurado(
          process.env.MONITORAMENTO_OUTBOX_ATRASO_MINUTOS,
          10
        ),
        evento_atraso_minutos: inteiroConfigurado(
          process.env.MONITORAMENTO_EVENTO_ATRASO_MINUTOS,
          10
        )
      };

      try {
        const estadoBackup = await (
          opcoes.obterEstadoBackup || obterEstadoBackup
        )();
        const [[pedidos]] = await pool.query(`
          SELECT
            SUM(status = 'AGUARDANDO_PAGAMENTO'
                AND atualizado_em <= DATE_SUB(NOW(), INTERVAL ? MINUTE))
              AS aguardando_pagamento_atrasados,
            SUM(status = 'AGUARDANDO_DADOS'
                AND atualizado_em <= DATE_SUB(NOW(), INTERVAL ? MINUTE))
              AS aguardando_dados_atrasados,
            SUM(status = 'EM_CONSULTA'
                AND atualizado_em <= DATE_SUB(NOW(), INTERVAL ? MINUTE))
              AS em_consulta_atrasados,
            SUM(status = 'PAGO'
                AND atualizado_em <= DATE_SUB(NOW(), INTERVAL ? MINUTE))
              AS pagos_atrasados,
            SUM(
              status = 'ABERTO'
              AND fornecedor_id IS NULL
              AND origem_id IS NULL
              AND EXISTS (
                SELECT 1
                  FROM pedido_historico h
                 WHERE h.pedido_id = pedidos_senha.id
                   AND h.id = (
                     SELECT MAX(h2.id)
                       FROM pedido_historico h2
                      WHERE h2.pedido_id = pedidos_senha.id
                   )
                   AND h.tipo IN ('API_JOELPIRES_INDISPONIVEL',
                                  'FORNECEDOR_GM_INDISPONIVEL')
                   AND h.criado_em <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
              )
            ) AS aguardando_reprocessamento_gm
          FROM pedidos_senha
        `, [limites.pedido_atraso_minutos, limites.pedido_atraso_minutos,
          limites.pedido_atraso_minutos, limites.pedido_atraso_minutos,
          limites.pedido_atraso_minutos]);

        const [[comunicacoes]] = await pool.query(`
          SELECT
            SUM(status = 'PENDENTE') AS pendentes,
            SUM(status = 'PENDENTE'
                AND processar_apos <= DATE_SUB(NOW(), INTERVAL ? MINUTE))
              AS pendentes_atrasadas,
            SUM(status = 'PROCESSANDO'
                AND atualizado_em <= DATE_SUB(NOW(), INTERVAL ? MINUTE))
              AS processando_atrasadas,
            SUM(status = 'FALHOU') AS falhas,
            SUM(status = 'INCERTA') AS incertas,
            MIN(CASE
              WHEN status IN ('PENDENTE', 'PROCESSANDO', 'FALHOU', 'INCERTA')
                THEN criado_em
              ELSE NULL
            END) AS pendencia_mais_antiga_em
          FROM comunicacoes_outbox
        `, [limites.outbox_atraso_minutos, limites.outbox_atraso_minutos]);

        const [[integracoes]] = await pool.query(`
          SELECT
            SUM(status = 'RECEBIDO') AS recebidos,
            SUM(status = 'RECEBIDO'
                AND recebido_em <= DATE_SUB(NOW(), INTERVAL ? MINUTE))
              AS recebidos_atrasados,
            SUM(status = 'FALHOU') AS falhas,
            MIN(CASE
              WHEN status IN ('RECEBIDO', 'FALHOU') THEN recebido_em
              ELSE NULL
            END) AS pendencia_mais_antiga_em
          FROM integracao_eventos
        `, [limites.evento_atraso_minutos]);

        const [[notificacoes]] = await pool.query(`
          SELECT
            SUM(status = 'ATIVA') AS ativas,
            SUM(status = 'ATIVA' AND nivel = 'CRITICA') AS criticas,
            SUM(status = 'ATIVA' AND nivel = 'ATENCAO') AS atencoes
          FROM notificacoes
        `);

        const numerico = objeto => Object.fromEntries(
          Object.entries(objeto).map(([chave, valor]) => [
            chave,
            chave.endsWith('_em') ? valor : Number(valor || 0)
          ])
        );
        const dados = {
          pedidos: numerico(pedidos),
          comunicacoes: numerico(comunicacoes),
          integracoes: numerico(integracoes),
          notificacoes: numerico(notificacoes),
          backup: estadoBackup
        };
        const critico = dados.comunicacoes.falhas +
          dados.comunicacoes.incertas +
          dados.integracoes.falhas +
          dados.notificacoes.criticas +
          (dados.backup.status === 'OK' ? 0 : 1);
        const atencao = dados.pedidos.aguardando_pagamento_atrasados +
          dados.pedidos.aguardando_dados_atrasados +
          dados.pedidos.em_consulta_atrasados +
          dados.pedidos.pagos_atrasados +
          dados.pedidos.aguardando_reprocessamento_gm +
          dados.comunicacoes.pendentes_atrasadas +
          dados.comunicacoes.processando_atrasadas +
          dados.integracoes.recebidos_atrasados +
          dados.notificacoes.atencoes;

        return res.json({
          ok: true,
          status: critico > 0 ? 'CRITICO' : atencao > 0 ? 'ATENCAO' : 'OK',
          verificado_em: new Date().toISOString(),
          limites,
          ...dados
        });
      } catch (erro) {
        console.error('Falha ao resumir monitoramento:', erro.code || erro.message);
        return res.status(500).json({
          ok: false,
          error: 'Falha ao consultar monitoramento operacional'
        });
      }
    }
  );
};
