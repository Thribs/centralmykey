'use strict';

function dataIso(valor) {
  const texto = String(valor || '').trim();
  if (!texto) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const data = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(data.getTime()) &&
    data.toISOString().slice(0, 10) === texto
    ? texto
    : false;
}

function somenteAdministrador(req, res, next) {
  if (Number(req.usuario?.perfil_id) !== 1) {
    return res.status(403).json({
      ok: false,
      error: 'Acesso permitido somente ao administrador'
    });
  }
  next();
}

module.exports = function (app, pool) {
  const autenticarToken = app.locals.autenticarToken;

  app.get(
    '/api/auditoria',
    autenticarToken,
    somenteAdministrador,
    async (req, res) => {
      const inicio = dataIso(req.query.inicio);
      const fim = dataIso(req.query.fim);
      const modulo = String(req.query.modulo || '').trim().toUpperCase();
      const busca = String(req.query.busca || '').trim().slice(0, 100);
      const usuarioId = Number(req.query.usuario_id) || null;
      const antesDe = Number(req.query.antes_de) || null;
      const limiteSolicitado = Number(req.query.limite || 50);
      const limite = Number.isInteger(limiteSolicitado) &&
        limiteSolicitado >= 1 && limiteSolicitado <= 100
        ? limiteSolicitado
        : 50;
      if (inicio === false || fim === false || (inicio && fim && inicio > fim)) {
        return res.status(400).json({ ok: false, error: 'Período inválido' });
      }
      if (modulo && !/^[A-Z0-9_]{2,60}$/.test(modulo)) {
        return res.status(400).json({ ok: false, error: 'Módulo inválido' });
      }
      try {
        const filtros = [];
        const parametros = [];
        if (inicio) {
          filtros.push('a.criado_em >= ?');
          parametros.push(`${inicio} 00:00:00`);
        }
        if (fim) {
          filtros.push('a.criado_em < DATE_ADD(?, INTERVAL 1 DAY)');
          parametros.push(`${fim} 00:00:00`);
        }
        if (modulo) {
          filtros.push('a.modulo = ?');
          parametros.push(modulo);
        }
        if (usuarioId) {
          filtros.push('a.usuario_id = ?');
          parametros.push(usuarioId);
        }
        if (antesDe) {
          filtros.push('a.id < ?');
          parametros.push(antesDe);
        }
        if (busca) {
          filtros.push(`(
            a.descricao LIKE ? OR a.acao LIKE ? OR
            a.entidade LIKE ? OR a.entidade_id LIKE ? OR
            u.nome LIKE ? OR u.login LIKE ?
          )`);
          const termo = `%${busca}%`;
          parametros.push(termo, termo, termo, termo, termo, termo);
        }
        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
        const [dados] = await pool.query(
          `SELECT
             a.id, a.criado_em, a.modulo, a.acao,
             a.entidade, a.entidade_id, a.descricao,
             u.id AS usuario_id, u.nome AS usuario, u.login
           FROM auditoria a
           LEFT JOIN usuarios u ON u.id = a.usuario_id
           ${where}
           ORDER BY a.id DESC
           LIMIT ${limite + 1}`,
          parametros
        );
        const possuiMais = dados.length > limite;
        const pagina = possuiMais ? dados.slice(0, limite) : dados;
        return res.json({
          ok: true,
          total: pagina.length,
          dados: pagina,
          proximo_cursor: possuiMais ? pagina[pagina.length - 1].id : null
        });
      } catch (error) {
        console.error('Erro ao consultar auditoria:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar auditoria' });
      }
    }
  );

  app.get(
    '/api/auditoria/filtros',
    autenticarToken,
    somenteAdministrador,
    async (req, res) => {
      try {
        const [modulos] = await pool.query(
          `SELECT DISTINCT modulo
             FROM auditoria
            WHERE modulo IS NOT NULL AND modulo <> ''
            ORDER BY modulo`
        );
        const [usuarios] = await pool.query(
          `SELECT DISTINCT u.id, u.nome
             FROM auditoria a
             INNER JOIN usuarios u ON u.id = a.usuario_id
            ORDER BY u.nome`
        );
        return res.json({ ok: true, modulos, usuarios });
      } catch (error) {
        console.error('Erro ao consultar filtros de auditoria:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar auditoria' });
      }
    }
  );
};
