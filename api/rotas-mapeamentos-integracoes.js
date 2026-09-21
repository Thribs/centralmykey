'use strict';

const PROVEDORES = ['WBUY', 'BLING'];

function texto(valor, limite) {
  const resultado = String(valor ?? '').trim();
  return resultado ? resultado.slice(0, limite) : null;
}

async function buscarMapeamento(connection, id) {
  const [linhas] = await connection.query(
    `SELECT m.id, m.provedor, m.produto_externo_id, m.sku, m.nome_externo,
            m.servico_id, s.codigo AS servico_codigo, s.nome AS servico_nome,
            m.ativo, m.criado_em, m.atualizado_em
       FROM integracao_produto_mapeamentos m
       JOIN servicos s ON s.id=m.servico_id
      WHERE m.id=? LIMIT 1`,
    [id]
  );
  return linhas[0];
}

module.exports = function registrarRotasMapeamentosIntegracoes(app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  app.get('/api/integracoes/mapeamentos-produtos', autenticarToken,
    exigirPermissao('INTEGRACOES', 'visualizar'), async (req, res) => {
      const provedor = String(req.query.provedor || '').trim().toUpperCase();
      if (provedor && !PROVEDORES.includes(provedor)) {
        return res.status(400).json({ ok: false, error: 'Provedor inválido' });
      }
      try {
        const [dados] = await pool.query(
          `SELECT m.id, m.provedor, m.produto_externo_id, m.sku, m.nome_externo,
                  m.servico_id, s.codigo AS servico_codigo, s.nome AS servico_nome,
                  m.ativo, m.criado_em, m.atualizado_em
             FROM integracao_produto_mapeamentos m
             JOIN servicos s ON s.id=m.servico_id
            ${provedor ? 'WHERE m.provedor=?' : ''}
            ORDER BY m.provedor, m.nome_externo, m.sku, m.id`,
          provedor ? [provedor] : []
        );
        const [servicos] = await pool.query(
          `SELECT id, codigo, nome FROM servicos WHERE ativo=1 ORDER BY nome`
        );
        return res.json({ ok: true, total: dados.length, dados, servicos });
      } catch (error) {
        console.error('Erro ao listar mapeamentos externos:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar mapeamentos externos' });
      }
    });

  app.post('/api/integracoes/mapeamentos-produtos', autenticarToken,
    exigirPermissao('INTEGRACOES', 'editar'), async (req, res) => {
      const provedor = String(req.body?.provedor || '').trim().toUpperCase();
      const produtoExternoId = texto(req.body?.produto_externo_id, 160);
      const sku = texto(req.body?.sku, 120)?.toUpperCase() || null;
      const nomeExterno = texto(req.body?.nome_externo, 255);
      const servicoId = Number(req.body?.servico_id);
      if (!PROVEDORES.includes(provedor) || (!produtoExternoId && !sku) ||
          !Number.isInteger(servicoId) || servicoId <= 0) {
        return res.status(400).json({ ok: false,
          error: 'Provedor, produto ou SKU e serviço são obrigatórios' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [servicos] = await connection.query(
          'SELECT id FROM servicos WHERE id=? AND ativo=1 LIMIT 1', [servicoId]
        );
        if (!servicos.length) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Serviço ativo não encontrado' });
        }
        const [existentes] = await connection.query(
          `SELECT id, provedor, produto_externo_id, sku, nome_externo, servico_id, ativo
             FROM integracao_produto_mapeamentos
            WHERE provedor=? AND
              ((? IS NOT NULL AND produto_externo_id=?) OR (? IS NOT NULL AND sku=?))
            FOR UPDATE`,
          [provedor, produtoExternoId, produtoExternoId, sku, sku]
        );
        if (new Set(existentes.map(item => Number(item.id))).size > 1) {
          await connection.rollback();
          return res.status(409).json({ ok: false,
            error: 'Produto externo e SKU apontam para mapeamentos diferentes' });
        }
        let id;
        let antes = null;
        let criado = false;
        if (existentes.length) {
          antes = existentes[0];
          id = Number(antes.id);
          await connection.query(
            `UPDATE integracao_produto_mapeamentos
                SET produto_externo_id=?, sku=?, nome_externo=?, servico_id=?,
                    ativo=1, atualizado_por=? WHERE id=?`,
            [produtoExternoId, sku, nomeExterno, servicoId,
              req.usuario?.id || null, id]
          );
        } else {
          const [insercao] = await connection.query(
            `INSERT INTO integracao_produto_mapeamentos
               (provedor, produto_externo_id, sku, nome_externo, servico_id,
                ativo, criado_por, atualizado_por)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
            [provedor, produtoExternoId, sku, nomeExterno, servicoId,
              req.usuario?.id || null, req.usuario?.id || null]
          );
          id = insercao.insertId;
          criado = true;
        }
        const dados = await buscarMapeamento(connection, id);
        await connection.query(
          `INSERT INTO auditoria
             (usuario_id, modulo, acao, entidade, entidade_id, descricao,
              dados_antes, dados_depois, ip)
           VALUES (?, 'INTEGRACOES', ?, 'integracao_produto_mapeamentos', ?, ?, ?, ?, ?)`,
          [req.usuario?.id || null, criado ? 'CRIAR_MAPEAMENTO' : 'ATUALIZAR_MAPEAMENTO',
            String(id), `Mapeamento ${provedor} para ${dados.servico_codigo}`,
            antes ? JSON.stringify(antes) : null, JSON.stringify(dados), req.ip || null]
        );
        await connection.commit();
        return res.status(criado ? 201 : 200).json({ ok: true, criado, dados });
      } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ ok: false,
            error: 'Produto externo ou SKU já está mapeado' });
        }
        console.error('Erro ao salvar mapeamento externo:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao salvar mapeamento externo' });
      } finally {
        connection.release();
      }
    });

  app.patch('/api/integracoes/mapeamentos-produtos/:id/status', autenticarToken,
    exigirPermissao('INTEGRACOES', 'editar'), async (req, res) => {
      const id = Number(req.params.id);
      const ativo = req.body?.ativo;
      if (!Number.isInteger(id) || id <= 0 || typeof ativo !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'Mapeamento ou status inválido' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [linhas] = await connection.query(
          'SELECT * FROM integracao_produto_mapeamentos WHERE id=? LIMIT 1 FOR UPDATE', [id]
        );
        if (!linhas.length) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Mapeamento não encontrado' });
        }
        await connection.query(
          'UPDATE integracao_produto_mapeamentos SET ativo=?, atualizado_por=? WHERE id=?',
          [ativo ? 1 : 0, req.usuario?.id || null, id]
        );
        const dados = await buscarMapeamento(connection, id);
        await connection.query(
          `INSERT INTO auditoria
             (usuario_id, modulo, acao, entidade, entidade_id, descricao,
              dados_antes, dados_depois, ip)
           VALUES (?, 'INTEGRACOES', 'ALTERAR_STATUS_MAPEAMENTO',
                   'integracao_produto_mapeamentos', ?, ?, ?, ?, ?)`,
          [req.usuario?.id || null, String(id),
            `${ativo ? 'Ativação' : 'Desativação'} de mapeamento externo`,
            JSON.stringify(linhas[0]), JSON.stringify(dados), req.ip || null]
        );
        await connection.commit();
        return res.json({ ok: true, dados });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao alterar mapeamento externo:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao alterar mapeamento externo' });
      } finally {
        connection.release();
      }
    });
};
