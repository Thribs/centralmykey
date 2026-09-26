'use strict';

const {
  MOEDAS_COMERCIO,
  ORIGENS_IDENTIDADE,
  PAPEIS_IDENTIDADE,
  chaveIdentidade,
  chaveMoeda,
  obterPoliticaComercio
} = require('./politicas-comercio');

const PROVEDORES = ['WBUY', 'BLING'];
const DOMINIOS_AUTORIDADE = [
  'PEDIDO', 'PAGAMENTO', 'CLIENTE', 'COMPRADOR', 'PAGADOR', 'FISCAL', 'ESTOQUE'
];
const AUTORIDADES = ['CENTRAL', 'WBUY', 'BLING', 'MANUAL'];
const DOMINIOS_STATUS = ['PEDIDO', 'PAGAMENTO'];
const SITUACOES_STATUS = ['PENDENTE', 'CONFIRMADO', 'CANCELADO', 'IGNORADO'];

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

  app.get('/api/integracoes/autoridades', autenticarToken,
    exigirPermissao('INTEGRACOES', 'visualizar'), async (req, res) => {
      try {
        const [linhas] = await pool.query(
          `SELECT dominio, autoridade, atualizado_em
             FROM integracao_autoridades ORDER BY dominio`
        );
        const porDominio = new Map(linhas.map(item => [item.dominio, item]));
        const dados = DOMINIOS_AUTORIDADE.map(dominio => porDominio.get(dominio) || {
          dominio, autoridade: null, atualizado_em: null
        });
        const pendentes = dados.filter(item => !item.autoridade)
          .map(item => item.dominio);
        return res.json({
          ok: true,
          completa: pendentes.length === 0,
          pendentes,
          dados,
          opcoes: AUTORIDADES
        });
      } catch (error) {
        console.error('Erro ao listar matriz de autoridade:', error);
        return res.status(500).json({
          ok: false, error: 'Erro ao consultar matriz de autoridade'
        });
      }
    });

  app.put('/api/integracoes/autoridades/:dominio', autenticarToken,
    exigirPermissao('INTEGRACOES', 'editar'), async (req, res) => {
      const dominio = String(req.params.dominio || '').trim().toUpperCase();
      const autoridade = String(req.body?.autoridade || '').trim().toUpperCase();
      if (!DOMINIOS_AUTORIDADE.includes(dominio) || !AUTORIDADES.includes(autoridade)) {
        return res.status(400).json({ ok: false,
          error: 'Domínio ou autoridade inválida' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[antes]] = await connection.query(
          `SELECT dominio, autoridade FROM integracao_autoridades
            WHERE dominio=? LIMIT 1 FOR UPDATE`,
          [dominio]
        );
        await connection.query(
          `INSERT INTO integracao_autoridades
             (dominio, autoridade, atualizado_por)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE autoridade=VALUES(autoridade),
             atualizado_por=VALUES(atualizado_por), atualizado_em=NOW()`,
          [dominio, autoridade, req.usuario?.id || null]
        );
        const depois = { dominio, autoridade };
        const alterada = antes?.autoridade !== autoridade;
        if (alterada) {
          await connection.query(
            `INSERT INTO auditoria
               (usuario_id, modulo, acao, entidade, entidade_id, descricao,
                dados_antes, dados_depois, ip)
             VALUES (?, 'INTEGRACOES', 'DEFINIR_AUTORIDADE_INTEGRACAO',
                     'integracao_autoridades', ?, ?, ?, ?, ?)`,
            [req.usuario?.id || null, dominio,
              `Autoridade do domínio ${dominio} definida como ${autoridade}`,
              antes ? JSON.stringify(antes) : null,
              JSON.stringify(depois), req.ip || null]
          );
        }
        await connection.commit();
        return res.json({ ok: true, alterada, dados: depois });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao definir autoridade de integração:', error);
        return res.status(500).json({
          ok: false, error: 'Erro ao salvar autoridade de integração'
        });
      } finally {
        connection.release();
      }
    });

  app.get('/api/integracoes/mapeamentos-status', autenticarToken,
    exigirPermissao('INTEGRACOES', 'visualizar'), async (req, res) => {
      try {
        const [dados] = await pool.query(
          `SELECT id, provedor, dominio, status_externo_id, status_externo_nome,
                  situacao, ativo, atualizado_em
             FROM integracao_status_mapeamentos
            ORDER BY provedor, dominio, status_externo_id`
        );
        return res.json({ ok: true, total: dados.length, dados,
          provedores: PROVEDORES, dominios: DOMINIOS_STATUS,
          situacoes: SITUACOES_STATUS });
      } catch (error) {
        console.error('Erro ao listar mapeamentos de status:', error);
        return res.status(500).json({ ok: false,
          error: 'Erro ao consultar mapeamentos de status' });
      }
    });

  app.get('/api/integracoes/politicas-comercio', autenticarToken,
    exigirPermissao('INTEGRACOES', 'visualizar'), async (req, res) => {
      try {
        const dados = await Promise.all(PROVEDORES.map(
          provedor => obterPoliticaComercio(pool, provedor)
        ));
        return res.json({ ok: true, dados, moedas: MOEDAS_COMERCIO,
          origens_identidade: ORIGENS_IDENTIDADE });
      } catch (error) {
        console.error('Erro ao consultar políticas do comércio eletrônico:', error);
        return res.status(500).json({ ok: false,
          error: 'Erro ao consultar políticas do comércio eletrônico' });
      }
    });

  app.put('/api/integracoes/politicas-comercio/:provedor', autenticarToken,
    exigirPermissao('INTEGRACOES', 'editar'), async (req, res) => {
      const provedor = String(req.params.provedor || '').trim().toUpperCase();
      const moeda = String(req.body?.moeda || '').trim().toUpperCase();
      const identidades = Object.fromEntries(PAPEIS_IDENTIDADE.map(papel => [
        papel.toLowerCase(), String(req.body?.identidades?.[papel.toLowerCase()] || '')
          .trim().toUpperCase()
      ]));
      if (!PROVEDORES.includes(provedor) || !MOEDAS_COMERCIO.includes(moeda) ||
          Object.values(identidades).some(valor => !ORIGENS_IDENTIDADE.includes(valor))) {
        return res.status(400).json({ ok: false,
          error: 'Provedor, moeda e origem dos três papéis são obrigatórios' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const antes = await obterPoliticaComercio(connection, provedor);
        const valores = [[chaveMoeda(provedor), moeda,
          `Moeda dos pedidos ${provedor} durante a transição`],
        ...PAPEIS_IDENTIDADE.map(papel => [
          chaveIdentidade(provedor, papel), identidades[papel.toLowerCase()],
          `Origem do papel ${papel} nos pedidos ${provedor}`
        ])];
        for (const [chave, valor, descricao] of valores) {
          await connection.query(
            `INSERT INTO configuracoes (chave, valor, descricao)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE valor=VALUES(valor), descricao=VALUES(descricao)`,
            [chave, valor, descricao]
          );
        }
        const depois = await obterPoliticaComercio(connection, provedor);
        const alterada = JSON.stringify(antes) !== JSON.stringify(depois);
        if (alterada) {
          await connection.query(
            `INSERT INTO auditoria
               (usuario_id, modulo, acao, entidade, entidade_id, descricao,
                dados_antes, dados_depois, ip)
             VALUES (?, 'INTEGRACOES', 'DEFINIR_POLITICA_COMERCIO',
                     'configuracoes_integracoes_comercio', ?, ?, ?, ?, ?)`,
            [req.usuario?.id || null, provedor,
              `Política comercial ${provedor} definida`, JSON.stringify(antes),
              JSON.stringify(depois), req.ip || null]
          );
        }
        await connection.commit();
        return res.json({ ok: true, alterada, dados: depois });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao salvar política do comércio eletrônico:', error);
        return res.status(500).json({ ok: false,
          error: 'Erro ao salvar política do comércio eletrônico' });
      } finally {
        connection.release();
      }
    });

  app.post('/api/integracoes/mapeamentos-status', autenticarToken,
    exigirPermissao('INTEGRACOES', 'editar'), async (req, res) => {
      const provedor = String(req.body?.provedor || '').trim().toUpperCase();
      const dominio = String(req.body?.dominio || '').trim().toUpperCase();
      const statusExternoId = texto(req.body?.status_externo_id, 80);
      const statusExternoNome = texto(req.body?.status_externo_nome, 160);
      const situacao = String(req.body?.situacao || '').trim().toUpperCase();
      if (!PROVEDORES.includes(provedor) || !DOMINIOS_STATUS.includes(dominio) ||
          !statusExternoId || !SITUACOES_STATUS.includes(situacao)) {
        return res.status(400).json({ ok: false,
          error: 'Provedor, domínio, status externo e situação são obrigatórios' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[antes]] = await connection.query(
          `SELECT id, provedor, dominio, status_externo_id, status_externo_nome,
                  situacao, ativo
             FROM integracao_status_mapeamentos
            WHERE provedor=? AND dominio=? AND status_externo_id=?
            LIMIT 1 FOR UPDATE`,
          [provedor, dominio, statusExternoId]
        );
        const [gravacao] = await connection.query(
          `INSERT INTO integracao_status_mapeamentos
             (provedor, dominio, status_externo_id, status_externo_nome,
              situacao, ativo, criado_por, atualizado_por)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)
           ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),
             status_externo_nome=VALUES(status_externo_nome),
             situacao=VALUES(situacao), ativo=1,
             atualizado_por=VALUES(atualizado_por), atualizado_em=NOW()`,
          [provedor, dominio, statusExternoId, statusExternoNome, situacao,
            req.usuario?.id || null, req.usuario?.id || null]
        );
        const id = Number(gravacao.insertId);
        const [[depois]] = await connection.query(
          `SELECT id, provedor, dominio, status_externo_id, status_externo_nome,
                  situacao, ativo
             FROM integracao_status_mapeamentos WHERE id=?`, [id]
        );
        const alterada = JSON.stringify(antes || null) !== JSON.stringify(depois);
        if (alterada) {
          await connection.query(
            `INSERT INTO auditoria
               (usuario_id, modulo, acao, entidade, entidade_id, descricao,
                dados_antes, dados_depois, ip)
             VALUES (?, 'INTEGRACOES', 'MAPEAR_STATUS_EXTERNO',
                     'integracao_status_mapeamentos', ?, ?, ?, ?, ?)`,
            [req.usuario?.id || null, String(id),
              `Status ${provedor}/${dominio} mapeado como ${situacao}`,
              antes ? JSON.stringify(antes) : null, JSON.stringify(depois), req.ip || null]
          );
        }
        await connection.commit();
        return res.status(antes ? 200 : 201).json({ ok: true, alterada, dados: depois });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao mapear status externo:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao salvar mapeamento de status' });
      } finally {
        connection.release();
      }
    });

  app.get('/api/integracoes/prontidao-comercio', autenticarToken,
    exigirPermissao('INTEGRACOES', 'visualizar'), async (req, res) => {
      try {
        const [[autoridades], [status], [produtos], [snapshots], politicaWBuy] = await Promise.all([
          pool.query(`SELECT COUNT(*) AS definidos FROM integracao_autoridades`),
          pool.query(`SELECT COUNT(*) AS confirmados
            FROM integracao_status_mapeamentos
            WHERE provedor='WBUY' AND dominio='PAGAMENTO'
              AND situacao='CONFIRMADO' AND ativo=1`),
          pool.query(`SELECT COUNT(*) AS mapeados
            FROM integracao_produto_mapeamentos
            WHERE provedor='WBUY' AND ativo=1`),
          pool.query(`SELECT COUNT(*) AS recebidos FROM integracao_eventos
            WHERE provedor='WBUY' AND tipo='ORDER.SNAPSHOT' AND status='RECEBIDO'`),
          obterPoliticaComercio(pool, 'WBUY')
        ]);
        const bloqueios = [];
        if (Number(autoridades[0]?.definidos || 0) < DOMINIOS_AUTORIDADE.length) {
          bloqueios.push('MATRIZ_AUTORIDADE_INCOMPLETA');
        }
        if (Number(status[0]?.confirmados || 0) === 0) {
          bloqueios.push('STATUS_PAGAMENTO_WBUY_SEM_CONFIRMACAO');
        }
        if (Number(produtos[0]?.mapeados || 0) === 0) {
          bloqueios.push('PRODUTOS_WBUY_SEM_MAPEAMENTO');
        }
        if (!politicaWBuy.moeda_definida) bloqueios.push('MOEDA_WBUY_NAO_DEFINIDA');
        if (!politicaWBuy.identidades_definidas) {
          bloqueios.push('RECONCILIACAO_IDENTIDADES_NAO_DEFINIDA');
        }
        bloqueios.push('CONVERSOR_WBUY_NAO_IMPLEMENTADO');
        return res.json({ ok: true, pronto_para_converter: false, bloqueios,
          contagens: {
            autoridades_definidas: Number(autoridades[0]?.definidos || 0),
            autoridades_total: DOMINIOS_AUTORIDADE.length,
            status_pagamento_confirmados: Number(status[0]?.confirmados || 0),
            produtos_wbuy_mapeados: Number(produtos[0]?.mapeados || 0),
            snapshots_recebidos: Number(snapshots[0]?.recebidos || 0)
          },
          politica_wbuy: politicaWBuy
        });
      } catch (error) {
        console.error('Erro ao consultar prontidão do comércio eletrônico:', error);
        return res.status(500).json({ ok: false,
          error: 'Erro ao consultar prontidão do comércio eletrônico' });
      }
    });
};
