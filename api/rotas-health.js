'use strict';

module.exports = function registrarRotasHealth(app, pool) {
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
};
