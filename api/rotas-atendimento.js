const fs = require('fs');
const path = require('path');

module.exports = function (app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  // ============================================================
  // LISTAR ATENDENTES DISPONÍVEIS PARA TRANSFERÊNCIA
  // ============================================================

  app.get(
    '/api/atendentes-disponiveis',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'editar'),
    async (req, res) => {
      try {
        const [usuarios] = await pool.query(
          `SELECT DISTINCT
             u.id,
             u.nome,
             u.login,
             p.nome AS perfil
           FROM usuarios u
           INNER JOIN perfis p
             ON p.id = u.perfil_id
           INNER JOIN usuario_permissoes up
             ON up.usuario_id = u.id
           INNER JOIN modulos m
             ON m.id = up.modulo_id
           WHERE u.status = 'ATIVO'
             AND m.codigo = 'ATENDIMENTO'
             AND m.ativo = 1
             AND up.editar = 1
             AND u.id <> ?
           ORDER BY u.nome`,
          [req.usuario.id]
        );

        return res.json({
          ok: true,
          total: usuarios.length,
          dados: usuarios
        });

      } catch (error) {
        console.error(
          'Erro ao listar atendentes disponíveis:',
          error
        );

        return res.status(500).json({
          ok: false,
          error: 'Erro ao listar atendentes disponíveis'
        });
      }
    }
  );

  // ============================================================
  // LISTAR FILA E ATENDIMENTOS
  // ============================================================

  app.get(
    '/api/atendimentos',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'visualizar'),
    async (req, res) => {
      try {
        const statusFiltro = String(req.query.status || '')
          .trim()
          .toUpperCase();

        const modoFiltro = String(req.query.modo || '')
          .trim()
          .toUpperCase();

        const somenteMeus =
          String(req.query.meus || '').toLowerCase() === 'true' ||
          String(req.query.meus || '') === '1';

        const busca = String(req.query.busca || '').trim();

        const statusPermitidos = new Set([
          'FILA',
          'EM_ATENDIMENTO',
          'AGUARDANDO_CLIENTE',
          'AGUARDANDO_PAGAMENTO',
          'AGUARDANDO_FORNECEDOR',
          'REVISAO',
          'PRONTO_ENVIO',
          'FINALIZADO',
          'CANCELADO'
        ]);

        const modosPermitidos = new Set([
          'ELETRONICO',
          'HUMANO'
        ]);

        if (
          statusFiltro &&
          !statusPermitidos.has(statusFiltro)
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Status de atendimento inválido'
          });
        }

        if (
          modoFiltro &&
          !modosPermitidos.has(modoFiltro)
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Modo de atendimento inválido'
          });
        }

        let sql = `
          SELECT
            a.id,
            a.protocolo,
            a.cliente_id,
            COALESCE(c.nome, 'Cliente não identificado') AS cliente,
            a.telefone,
            a.canal,
            a.responsavel_id,
            u.nome AS responsavel,
            a.modo,
            a.status,
            a.prioridade,
            a.assunto,
            a.iniciado_em,
            a.ultima_mensagem_em,
            a.finalizado_em,
            (
              SELECT am.texto
              FROM atendimento_mensagens am
              WHERE am.atendimento_id = a.id
              ORDER BY am.id DESC
              LIMIT 1
            ) AS ultima_mensagem,
            (
              SELECT COUNT(*)
              FROM atendimento_mensagens am
              WHERE am.atendimento_id = a.id
            ) AS quantidade_mensagens
          FROM atendimentos a
          LEFT JOIN clientes c
            ON c.id = a.cliente_id
          LEFT JOIN usuarios u
            ON u.id = a.responsavel_id
          WHERE 1 = 1
        `;

        const params = [];

        if (statusFiltro) {
          sql += ' AND a.status = ?';
          params.push(statusFiltro);
        }

        if (modoFiltro) {
          sql += ' AND a.modo = ?';
          params.push(modoFiltro);
        }

        if (somenteMeus) {
          sql += ' AND a.responsavel_id = ?';
          params.push(req.usuario.id);
        }

        if (busca) {
          const numeros = busca.replace(/\D/g, '');

          sql += `
            AND (
              a.protocolo LIKE ?
              OR a.telefone_normalizado LIKE ?
              OR c.nome LIKE ?
              OR a.assunto LIKE ?
            )
          `;

          params.push(
            `%${busca}%`,
            `%${numeros}%`,
            `%${busca}%`,
            `%${busca}%`
          );
        }

        sql += `
          ORDER BY
            CASE a.prioridade
              WHEN 'CRITICA' THEN 0
              WHEN 'ALTA' THEN 1
              ELSE 2
            END,
            CASE
              WHEN a.status = 'FILA' THEN 0
              WHEN a.status = 'EM_ATENDIMENTO' THEN 1
              ELSE 2
            END,
            COALESCE(a.ultima_mensagem_em, a.iniciado_em) DESC
          LIMIT 200
        `;

        const [atendimentos] = await pool.query(sql, params);

        return res.json({
          ok: true,
          total: atendimentos.length,
          dados: atendimentos
        });

      } catch (error) {
        console.error('Erro ao listar atendimentos:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao listar atendimentos'
        });
      }
    }
  );

  // ============================================================
  // DETALHAR ATENDIMENTO, MENSAGENS E ANEXOS
  // ============================================================

  app.get(
    '/api/atendimentos/:id',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'visualizar'),
    async (req, res) => {
      try {
        const atendimentoId = Number(req.params.id);

        if (
          !Number.isInteger(atendimentoId) ||
          atendimentoId <= 0
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Atendimento inválido'
          });
        }

        const [atendimentos] = await pool.query(
          `SELECT
             a.id,
             a.protocolo,
             a.cliente_id,
             COALESCE(c.nome, 'Cliente não identificado') AS cliente,
             c.email,
             a.telefone,
             a.canal,
             a.responsavel_id,
             u.nome AS responsavel,
             a.modo,
             a.status,
             a.prioridade,
             a.assunto,
             a.iniciado_em,
             a.ultima_mensagem_em,
             a.finalizado_em,
             (
               SELECT MAX(am.criado_em)
               FROM atendimento_mensagens am
               WHERE am.atendimento_id = a.id
                 AND am.direcao = 'ENTRADA'
                 AND am.autor_tipo = 'CLIENTE'
             ) AS ultima_entrada_cliente_em,
             EXISTS (
               SELECT 1
               FROM atendimento_mensagens am
               WHERE am.atendimento_id = a.id
                 AND am.direcao = 'ENTRADA'
                 AND am.autor_tipo = 'CLIENTE'
                 AND am.criado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
             ) AS janela_whatsapp_ativa
           FROM atendimentos a
           LEFT JOIN clientes c
             ON c.id = a.cliente_id
           LEFT JOIN usuarios u
             ON u.id = a.responsavel_id
           WHERE a.id = ?
           LIMIT 1`,
          [atendimentoId]
        );

        if (!atendimentos.length) {
          return res.status(404).json({
            ok: false,
            error: 'Atendimento não encontrado'
          });
        }

        const [mensagens] = await pool.query(
            `SELECT
               m.id,
               m.direcao,
               m.autor_tipo,
               m.usuario_id,
               u.nome AS usuario,
               m.tipo_conteudo,
               m.texto,
               m.mensagem_externa_id,
               m.status_entrega,
               m.status_atualizado_em,
               m.erro_codigo,
               m.erro_detalhe,
               m.criado_em
             FROM atendimento_mensagens m
             LEFT JOIN usuarios u ON u.id = m.usuario_id
             WHERE m.atendimento_id = ?
             ORDER BY m.id ASC`,
            [atendimentoId]
          );

          const [anexos] = await pool.query(
            `SELECT
               id,
               mensagem_id,
               nome_arquivo,
               tipo_mime,
               tamanho_bytes,
               CASE
                 WHEN caminho_arquivo LIKE 'meta://%' THEN 'PENDENTE'
                 WHEN caminho_arquivo IS NULL THEN 'INDISPONIVEL'
                 ELSE 'DISPONIVEL'
               END AS status_arquivo,
               CONCAT(
                 '/api/atendimentos/',
                 atendimento_id,
                 '/anexos/',
                 id
               ) AS url_download,
               expira_em,
               criado_em
             FROM atendimento_anexos
             WHERE atendimento_id = ?
               AND excluido_em IS NULL
             ORDER BY id ASC`,
            [atendimentoId]
          );

          return res.json({
          ok: true,
          atendimento: atendimentos[0],
          total_mensagens: mensagens.length,
          mensagens,
          total_anexos: anexos.length,
          anexos
        });

      } catch (error) {
        console.error('Erro ao detalhar atendimento:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao detalhar atendimento'
        });
      }
    }
  );

  // ============================================================
  // ASSUMIR ATENDIMENTO DA FILA
  // ============================================================

  app.post(
    '/api/atendimentos/:id/assumir',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'editar'),
    async (req, res) => {
      const connection = await pool.getConnection();

      try {
        const atendimentoId = Number(req.params.id);

        if (
          !Number.isInteger(atendimentoId) ||
          atendimentoId <= 0
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Atendimento inválido'
          });
        }

        await connection.beginTransaction();

        const [atendimentos] = await connection.query(
          `SELECT
             a.id,
             a.protocolo,
             a.responsavel_id,
             a.modo,
             a.status,
             u.nome AS responsavel
           FROM atendimentos a
           LEFT JOIN usuarios u
             ON u.id = a.responsavel_id
           WHERE a.id = ?
           LIMIT 1
           FOR UPDATE`,
          [atendimentoId]
        );

        if (!atendimentos.length) {
          await connection.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Atendimento não encontrado'
          });
        }

        const atendimento = atendimentos[0];

        if (
          atendimento.status === 'FINALIZADO' ||
          atendimento.status === 'CANCELADO'
        ) {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Atendimento encerrado não pode ser assumido',
            status_atual: atendimento.status
          });
        }

        if (
          atendimento.responsavel_id &&
          Number(atendimento.responsavel_id) !==
            Number(req.usuario.id)
        ) {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Atendimento já atribuído a outro usuário',
            responsavel_id: atendimento.responsavel_id,
            responsavel: atendimento.responsavel
          });
        }

        if (
          Number(atendimento.responsavel_id) ===
            Number(req.usuario.id) &&
          atendimento.modo === 'HUMANO'
        ) {
          await connection.rollback();

          return res.json({
            ok: true,
            mensagem: 'Atendimento já pertence a este usuário',
            atendimento: {
              id: atendimento.id,
              protocolo: atendimento.protocolo,
              responsavel_id: req.usuario.id,
              responsavel: req.usuario.nome,
              modo: atendimento.modo,
              status: atendimento.status
            }
          });
        }

        const novoStatus =
          atendimento.status === 'FILA'
            ? 'EM_ATENDIMENTO'
            : atendimento.status;

        await connection.query(
          `UPDATE atendimentos
           SET
             responsavel_id = ?,
             modo = 'HUMANO',
             status = ?
           WHERE id = ?`,
          [
            req.usuario.id,
            novoStatus,
            atendimento.id
          ]
        );

        await connection.query(
          `INSERT INTO atendimento_transferencias (
             atendimento_id,
             de_usuario_id,
             para_usuario_id,
             motivo
           )
           VALUES (?, NULL, ?, 'Atendimento assumido da fila')`,
          [
            atendimento.id,
            req.usuario.id
          ]
        );

        await connection.query(
          `INSERT INTO atendimento_mensagens (
             atendimento_id,
             direcao,
             autor_tipo,
             usuario_id,
             tipo_conteudo,
             texto
           )
           VALUES (
             ?,
             'INTERNA',
             'SISTEMA',
             ?,
             'TEXTO',
             ?
           )`,
          [
            atendimento.id,
            req.usuario.id,
            `Atendimento assumido por ${req.usuario.nome}`
          ]
        );

        await connection.query(
          `INSERT INTO auditoria (
             usuario_id,
             modulo,
             acao,
             entidade,
             entidade_id,
             descricao,
             dados_antes,
             dados_depois,
             ip
           )
           VALUES (
             ?,
             'ATENDIMENTO',
             'ASSUMIR_ATENDIMENTO',
             'atendimentos',
             ?,
             ?,
             ?,
             ?,
             ?
           )`,
          [
            req.usuario.id,
            String(atendimento.id),
            `Atendimento ${atendimento.protocolo} assumido`,
            JSON.stringify({
              responsavel_id: atendimento.responsavel_id,
              modo: atendimento.modo,
              status: atendimento.status
            }),
            JSON.stringify({
              responsavel_id: req.usuario.id,
              modo: 'HUMANO',
              status: novoStatus
            }),
            req.ip || null
          ]
        );

        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Atendimento assumido com sucesso',
          atendimento: {
            id: atendimento.id,
            protocolo: atendimento.protocolo,
            responsavel_id: req.usuario.id,
            responsavel: req.usuario.nome,
            modo: 'HUMANO',
            status: novoStatus
          }
        });

      } catch (error) {
        await connection.rollback();

        console.error('Erro ao assumir atendimento:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao assumir atendimento'
        });

      } finally {
        connection.release();
      }
    }
  );


  // ============================================================
  // TRANSFERIR ATENDIMENTO
  // ============================================================

  app.post(
    '/api/atendimentos/:id/transferir',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'editar'),
    async (req, res) => {
      const connection = await pool.getConnection();

      try {
        const atendimentoId = Number(req.params.id);
        const paraUsuarioId = Number(req.body.para_usuario_id);
        const motivo = req.body.motivo
          ? String(req.body.motivo).trim()
          : null;

        if (
          !Number.isInteger(atendimentoId) ||
          atendimentoId <= 0
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Atendimento inválido'
          });
        }

        if (
          !Number.isInteger(paraUsuarioId) ||
          paraUsuarioId <= 0
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Usuário de destino inválido'
          });
        }

        if (paraUsuarioId === Number(req.usuario.id)) {
          return res.status(400).json({
            ok: false,
            error: 'O atendimento já está sendo enviado para você'
          });
        }

        await connection.beginTransaction();

        const [atendimentos] = await connection.query(
          `SELECT
             a.id,
             a.protocolo,
             a.responsavel_id,
             a.modo,
             a.status,
             u.nome AS responsavel
           FROM atendimentos a
           LEFT JOIN usuarios u
             ON u.id = a.responsavel_id
           WHERE a.id = ?
           LIMIT 1
           FOR UPDATE`,
          [atendimentoId]
        );

        if (!atendimentos.length) {
          await connection.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Atendimento não encontrado'
          });
        }

        const atendimento = atendimentos[0];

        if (
          atendimento.status === 'FINALIZADO' ||
          atendimento.status === 'CANCELADO'
        ) {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Atendimento encerrado não pode ser transferido',
            status_atual: atendimento.status
          });
        }

        const ehAdministrador =
          req.usuario.perfil === 'Administrador';

        if (
          atendimento.responsavel_id &&
          Number(atendimento.responsavel_id) !==
            Number(req.usuario.id) &&
          !ehAdministrador
        ) {
          await connection.rollback();

          return res.status(403).json({
            ok: false,
            error:
              'Somente o responsável atual pode transferir este atendimento',
            responsavel_id: atendimento.responsavel_id,
            responsavel: atendimento.responsavel
          });
        }

        const [destinos] = await connection.query(
          `SELECT
             u.id,
             u.nome,
             u.login
           FROM usuarios u
           INNER JOIN usuario_permissoes up
             ON up.usuario_id = u.id
           INNER JOIN modulos m
             ON m.id = up.modulo_id
           WHERE u.id = ?
             AND u.status = 'ATIVO'
             AND m.codigo = 'ATENDIMENTO'
             AND m.ativo = 1
             AND up.editar = 1
           LIMIT 1`,
          [paraUsuarioId]
        );

        if (!destinos.length) {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error:
              'Usuário de destino não está ativo ou não possui permissão de atendimento'
          });
        }

        const destino = destinos[0];

        await connection.query(
          `UPDATE atendimentos
           SET
             responsavel_id = ?,
             modo = 'HUMANO',
             status = CASE
               WHEN status = 'FILA' THEN 'EM_ATENDIMENTO'
               ELSE status
             END
           WHERE id = ?`,
          [
            destino.id,
            atendimento.id
          ]
        );

        await connection.query(
          `INSERT INTO atendimento_transferencias (
             atendimento_id,
             de_usuario_id,
             para_usuario_id,
             motivo
           )
           VALUES (?, ?, ?, ?)`,
          [
            atendimento.id,
            atendimento.responsavel_id || req.usuario.id,
            destino.id,
            motivo
          ]
        );

        await connection.query(
          `INSERT INTO atendimento_mensagens (
             atendimento_id,
             direcao,
             autor_tipo,
             usuario_id,
             tipo_conteudo,
             texto
           )
           VALUES (
             ?,
             'INTERNA',
             'SISTEMA',
             ?,
             'TEXTO',
             ?
           )`,
          [
            atendimento.id,
            req.usuario.id,
            `Atendimento transferido por ${req.usuario.nome} para ${destino.nome}${motivo ? `: ${motivo}` : ''}`
          ]
        );

        await connection.query(
          `INSERT INTO auditoria (
             usuario_id,
             modulo,
             acao,
             entidade,
             entidade_id,
             descricao,
             dados_antes,
             dados_depois,
             ip
           )
           VALUES (
             ?,
             'ATENDIMENTO',
             'TRANSFERIR_ATENDIMENTO',
             'atendimentos',
             ?,
             ?,
             ?,
             ?,
             ?
           )`,
          [
            req.usuario.id,
            String(atendimento.id),
            `Atendimento ${atendimento.protocolo} transferido para ${destino.nome}`,
            JSON.stringify({
              responsavel_id: atendimento.responsavel_id,
              responsavel: atendimento.responsavel
            }),
            JSON.stringify({
              responsavel_id: destino.id,
              responsavel: destino.nome,
              motivo
            }),
            req.ip || null
          ]
        );

        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Atendimento transferido com sucesso',
          atendimento: {
            id: atendimento.id,
            protocolo: atendimento.protocolo,
            responsavel_id: destino.id,
            responsavel: destino.nome,
            modo: 'HUMANO',
            status:
              atendimento.status === 'FILA'
                ? 'EM_ATENDIMENTO'
                : atendimento.status
          },
          motivo
        });

      } catch (error) {
        await connection.rollback();

        console.error('Erro ao transferir atendimento:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao transferir atendimento'
        });

      } finally {
        connection.release();
      }
    }
  );


  // ============================================================
  // ALTERAR ETAPA DO ATENDIMENTO
  // ============================================================

  app.patch(
    '/api/atendimentos/:id/status',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'editar'),
    async (req, res) => {
      const connection = await pool.getConnection();

      try {
        const atendimentoId = Number(req.params.id);
        const novoStatus = String(req.body.status || '')
          .trim()
          .toUpperCase();

        const observacao = req.body.observacao
          ? String(req.body.observacao).trim()
          : null;

        if (
          !Number.isInteger(atendimentoId) ||
          atendimentoId <= 0
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Atendimento inválido'
          });
        }

        const transicoes = {
          FILA: [
            'EM_ATENDIMENTO',
            'CANCELADO'
          ],
          EM_ATENDIMENTO: [
            'AGUARDANDO_CLIENTE',
            'AGUARDANDO_PAGAMENTO',
            'AGUARDANDO_FORNECEDOR',
            'REVISAO',
            'PRONTO_ENVIO',
            'FINALIZADO',
            'CANCELADO'
          ],
          AGUARDANDO_CLIENTE: [
            'EM_ATENDIMENTO',
            'AGUARDANDO_PAGAMENTO',
            'AGUARDANDO_FORNECEDOR',
            'REVISAO',
            'CANCELADO'
          ],
          AGUARDANDO_PAGAMENTO: [
            'EM_ATENDIMENTO',
            'AGUARDANDO_FORNECEDOR',
            'REVISAO',
            'CANCELADO'
          ],
          AGUARDANDO_FORNECEDOR: [
            'EM_ATENDIMENTO',
            'REVISAO',
            'PRONTO_ENVIO',
            'CANCELADO'
          ],
          REVISAO: [
            'EM_ATENDIMENTO',
            'AGUARDANDO_CLIENTE',
            'AGUARDANDO_FORNECEDOR',
            'PRONTO_ENVIO',
            'CANCELADO'
          ],
          PRONTO_ENVIO: [
            'EM_ATENDIMENTO',
            'REVISAO',
            'FINALIZADO',
            'CANCELADO'
          ],
          FINALIZADO: [],
          CANCELADO: []
        };

        const todosStatus = new Set(Object.keys(transicoes));

        if (!todosStatus.has(novoStatus)) {
          return res.status(400).json({
            ok: false,
            error: 'Status de atendimento inválido'
          });
        }

        await connection.beginTransaction();

        const [atendimentos] = await connection.query(
          `SELECT
             a.id,
             a.protocolo,
             a.responsavel_id,
             a.status,
             u.nome AS responsavel
           FROM atendimentos a
           LEFT JOIN usuarios u
             ON u.id = a.responsavel_id
           WHERE a.id = ?
           LIMIT 1
           FOR UPDATE`,
          [atendimentoId]
        );

        if (!atendimentos.length) {
          await connection.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Atendimento não encontrado'
          });
        }

        const atendimento = atendimentos[0];

        const ehAdministrador =
          req.usuario.perfil === 'Administrador';

        if (
          atendimento.responsavel_id &&
          Number(atendimento.responsavel_id) !==
            Number(req.usuario.id) &&
          !ehAdministrador
        ) {
          await connection.rollback();

          return res.status(403).json({
            ok: false,
            error:
              'Somente o responsável atual pode alterar este atendimento',
            responsavel_id: atendimento.responsavel_id,
            responsavel: atendimento.responsavel
          });
        }

        if (atendimento.status === novoStatus) {
          await connection.rollback();

          return res.json({
            ok: true,
            mensagem: 'Atendimento já está neste status',
            atendimento: {
              id: atendimento.id,
              protocolo: atendimento.protocolo,
              status: atendimento.status
            }
          });
        }

        if (
          !transicoes[atendimento.status] ||
          !transicoes[atendimento.status].includes(novoStatus)
        ) {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Transição de status não permitida',
            status_atual: atendimento.status,
            status_solicitado: novoStatus,
            permitidos: transicoes[atendimento.status] || []
          });
        }

        const encerrado =
          novoStatus === 'FINALIZADO' ||
          novoStatus === 'CANCELADO';

        await connection.query(
          `UPDATE atendimentos
           SET
             status = ?,
             finalizado_em = CASE
               WHEN ? = 1 THEN NOW()
               ELSE NULL
             END
           WHERE id = ?`,
          [
            novoStatus,
            encerrado ? 1 : 0,
            atendimento.id
          ]
        );

        const descricao =
          `Status alterado de ${atendimento.status} para ${novoStatus}` +
          (observacao ? `: ${observacao}` : '');

        await connection.query(
          `INSERT INTO atendimento_mensagens (
             atendimento_id,
             direcao,
             autor_tipo,
             usuario_id,
             tipo_conteudo,
             texto
           )
           VALUES (
             ?,
             'INTERNA',
             'SISTEMA',
             ?,
             'TEXTO',
             ?
           )`,
          [
            atendimento.id,
            req.usuario.id,
            descricao
          ]
        );

        await connection.query(
          `INSERT INTO auditoria (
             usuario_id,
             modulo,
             acao,
             entidade,
             entidade_id,
             descricao,
             dados_antes,
             dados_depois,
             ip
           )
           VALUES (
             ?,
             'ATENDIMENTO',
             'ALTERAR_STATUS',
             'atendimentos',
             ?,
             ?,
             ?,
             ?,
             ?
           )`,
          [
            req.usuario.id,
            String(atendimento.id),
            `Status do atendimento ${atendimento.protocolo} alterado`,
            JSON.stringify({
              status: atendimento.status
            }),
            JSON.stringify({
              status: novoStatus,
              observacao
            }),
            req.ip || null
          ]
        );

        await connection.commit();

        return res.json({
          ok: true,
          mensagem: 'Status do atendimento alterado com sucesso',
          atendimento: {
            id: atendimento.id,
            protocolo: atendimento.protocolo,
            status_anterior: atendimento.status,
            status: novoStatus,
            finalizado: encerrado
          }
        });

      } catch (error) {
        await connection.rollback();

        console.error(
          'Erro ao alterar status do atendimento:',
          error
        );

        return res.status(500).json({
          ok: false,
          error: 'Erro ao alterar status do atendimento'
        });

      } finally {
        connection.release();
      }
    }
  );


  // ============================================================
  // ADICIONAR NOTA INTERNA AO ATENDIMENTO
  // ============================================================

  app.post(
    '/api/atendimentos/:id/mensagens/interna',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'editar'),
    async (req, res) => {
      const connection = await pool.getConnection();

      try {
        const atendimentoId = Number(req.params.id);
        const textoNota = String(req.body.texto || '').trim();

        if (
          !Number.isInteger(atendimentoId) ||
          atendimentoId <= 0
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Atendimento inválido'
          });
        }

        if (!textoNota) {
          return res.status(400).json({
            ok: false,
            error: 'O texto da nota é obrigatório'
          });
        }

        if (textoNota.length > 5000) {
          return res.status(400).json({
            ok: false,
            error: 'A nota deve possuir no máximo 5.000 caracteres'
          });
        }

        await connection.beginTransaction();

        const [atendimentos] = await connection.query(
          `SELECT
             a.id,
             a.protocolo,
             a.responsavel_id,
             a.status,
             u.nome AS responsavel
           FROM atendimentos a
           LEFT JOIN usuarios u
             ON u.id = a.responsavel_id
           WHERE a.id = ?
           LIMIT 1
           FOR UPDATE`,
          [atendimentoId]
        );

        if (!atendimentos.length) {
          await connection.rollback();

          return res.status(404).json({
            ok: false,
            error: 'Atendimento não encontrado'
          });
        }

        const atendimento = atendimentos[0];

        if (
          atendimento.status === 'FINALIZADO' ||
          atendimento.status === 'CANCELADO'
        ) {
          await connection.rollback();

          return res.status(409).json({
            ok: false,
            error: 'Atendimento encerrado não aceita novas notas'
          });
        }

        const ehAdministrador =
          req.usuario.perfil === 'Administrador';

        if (
          atendimento.responsavel_id &&
          Number(atendimento.responsavel_id) !==
            Number(req.usuario.id) &&
          !ehAdministrador
        ) {
          await connection.rollback();

          return res.status(403).json({
            ok: false,
            error:
              'Somente o responsável atual pode registrar nota neste atendimento',
            responsavel_id: atendimento.responsavel_id,
            responsavel: atendimento.responsavel
          });
        }

        const [mensagem] = await connection.query(
          `INSERT INTO atendimento_mensagens (
             atendimento_id,
             direcao,
             autor_tipo,
             usuario_id,
             tipo_conteudo,
             texto
           )
           VALUES (
             ?,
             'INTERNA',
             'ATENDENTE',
             ?,
             'TEXTO',
             ?
           )`,
          [
            atendimento.id,
            req.usuario.id,
            textoNota
          ]
        );

        await connection.query(
          `UPDATE atendimentos
           SET ultima_mensagem_em = NOW()
           WHERE id = ?`,
          [atendimento.id]
        );

        await connection.query(
          `INSERT INTO auditoria (
             usuario_id,
             modulo,
             acao,
             entidade,
             entidade_id,
             descricao,
             dados_antes,
             dados_depois,
             ip
           )
           VALUES (
             ?,
             'ATENDIMENTO',
             'ADICIONAR_NOTA_INTERNA',
             'atendimentos',
             ?,
             ?,
             NULL,
             ?,
             ?
           )`,
          [
            req.usuario.id,
            String(atendimento.id),
            `Nota interna adicionada ao atendimento ${atendimento.protocolo}`,
            JSON.stringify({
              mensagem_id: mensagem.insertId
            }),
            req.ip || null
          ]
        );

        await connection.commit();

        return res.status(201).json({
          ok: true,
          mensagem: 'Nota interna registrada com sucesso',
          nota: {
            id: mensagem.insertId,
            atendimento_id: atendimento.id,
            autor_tipo: 'ATENDENTE',
            usuario_id: req.usuario.id,
            usuario: req.usuario.nome,
            tipo_conteudo: 'TEXTO',
            texto: textoNota
          }
        });

      } catch (error) {
        await connection.rollback();

        console.error('Erro ao adicionar nota interna:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao adicionar nota interna'
        });

      } finally {
        connection.release();
      }
    }
  );



  // ============================================================
  // ENVIAR MENSAGEM DE WHATSAPP AO CLIENTE
  // ============================================================

  app.post(
    '/api/atendimentos/:id/mensagens/whatsapp',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'editar'),
    async (req, res) => {
      const atendimentoId = Number(req.params.id);
      const textoMensagem = String(req.body?.texto || '').trim();

      if (!Number.isInteger(atendimentoId) || atendimentoId <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Atendimento inválido'
        });
      }

      if (!textoMensagem || textoMensagem.length > 4096) {
        return res.status(400).json({
          ok: false,
          error:
            'A mensagem é obrigatória e deve possuir no máximo 4.096 caracteres'
        });
      }

      try {
        const [atendimentos] = await pool.query(
          `SELECT
             a.id,
             a.protocolo,
             a.telefone_normalizado,
             a.canal,
             a.responsavel_id,
             a.status,
             u.nome AS responsavel,
             (
               SELECT MAX(am.criado_em)
               FROM atendimento_mensagens am
               WHERE am.atendimento_id = a.id
                 AND am.direcao = 'ENTRADA'
                 AND am.autor_tipo = 'CLIENTE'
             ) AS ultima_entrada_cliente_em,
             EXISTS (
               SELECT 1
               FROM atendimento_mensagens am
               WHERE am.atendimento_id = a.id
                 AND am.direcao = 'ENTRADA'
                 AND am.autor_tipo = 'CLIENTE'
                 AND am.criado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
             ) AS janela_whatsapp_ativa
           FROM atendimentos a
           LEFT JOIN usuarios u ON u.id = a.responsavel_id
           WHERE a.id = ?
           LIMIT 1`,
          [atendimentoId]
        );

        if (!atendimentos.length) {
          return res.status(404).json({
            ok: false,
            error: 'Atendimento não encontrado'
          });
        }

        const atendimento = atendimentos[0];
        const ehAdministrador =
          req.usuario.perfil === 'Administrador';

        if (atendimento.canal !== 'WHATSAPP') {
          return res.status(409).json({
            ok: false,
            error: 'Este atendimento não pertence ao canal WhatsApp'
          });
        }

        if (
          atendimento.status === 'FINALIZADO' ||
          atendimento.status === 'CANCELADO'
        ) {
          return res.status(409).json({
            ok: false,
            error: 'Atendimento encerrado não aceita novas mensagens'
          });
        }

        if (!atendimento.responsavel_id && !ehAdministrador) {
          return res.status(409).json({
            ok: false,
            error: 'Assuma o atendimento antes de responder ao cliente'
          });
        }

        if (
          atendimento.responsavel_id &&
          Number(atendimento.responsavel_id) !==
            Number(req.usuario.id) &&
          !ehAdministrador
        ) {
          return res.status(403).json({
            ok: false,
            error:
              'Somente o responsável atual pode responder neste atendimento',
            responsavel_id: atendimento.responsavel_id,
            responsavel: atendimento.responsavel
          });
        }

        if (Number(atendimento.janela_whatsapp_ativa) !== 1) {
          return res.status(409).json({
            ok: false,
            codigo: 'JANELA_24H_ENCERRADA',
            error:
              'A janela de 24 horas do WhatsApp está encerrada. Use um modelo aprovado pela Meta.',
            ultima_entrada_cliente_em:
              atendimento.ultima_entrada_cliente_em
          });
        }

        const enviar = app.locals.enviarMensagemWhatsapp;

        if (typeof enviar !== 'function') {
          return res.status(503).json({
            ok: false,
            error: 'Integração do WhatsApp indisponível'
          });
        }

        const envio = await enviar({
          telefone: atendimento.telefone_normalizado,
          texto: textoMensagem
        });

        const connection = await pool.getConnection();

        try {
          await connection.beginTransaction();

          const [mensagem] = await connection.query(
            `INSERT INTO atendimento_mensagens
               (atendimento_id, direcao, autor_tipo, usuario_id,
                tipo_conteudo, texto, mensagem_externa_id,
                status_entrega, status_atualizado_em)
             VALUES (?, 'SAIDA', 'ATENDENTE', ?, 'TEXTO', ?, ?,
                     'ENVIADA', NOW())`,
            [
              atendimento.id,
              req.usuario.id,
              textoMensagem,
              envio.mensagem_externa_id
            ]
          );

          await connection.query(
            `UPDATE atendimentos
             SET modo = 'HUMANO',
                 status = 'EM_ATENDIMENTO',
                 ultima_mensagem_em = NOW()
             WHERE id = ?`,
            [atendimento.id]
          );

          await connection.query(
            `INSERT INTO auditoria
               (usuario_id, modulo, acao, entidade, entidade_id,
                descricao, dados_antes, dados_depois, ip)
             VALUES (?, 'ATENDIMENTO', 'ENVIAR_MENSAGEM_WHATSAPP',
                     'atendimentos', ?, ?, NULL, ?, ?)`,
            [
              req.usuario.id,
              String(atendimento.id),
              `Mensagem enviada no atendimento ${atendimento.protocolo}`,
              JSON.stringify({
                mensagem_id: mensagem.insertId,
                mensagem_externa_id: envio.mensagem_externa_id
              }),
              req.ip || null
            ]
          );

          await connection.commit();

          return res.status(201).json({
            ok: true,
            mensagem: 'Mensagem enviada com sucesso',
            envio: {
              id: mensagem.insertId,
              atendimento_id: atendimento.id,
              texto: textoMensagem,
              mensagem_externa_id: envio.mensagem_externa_id
            }
          });
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      } catch (error) {
        if (error.codigo === 'WHATSAPP_NAO_CONFIGURADO') {
          return res.status(503).json({
            ok: false,
            error:
              'Envio ainda não configurado. Faltam as credenciais oficiais da Meta.'
          });
        }

        if (error.codigo === 'WHATSAPP_ENVIO_FALHOU') {
          console.error(
            'Meta recusou mensagem:',
            error.statusMeta,
            error.dadosMeta
          );

          return res.status(502).json({
            ok: false,
            error: 'A Meta recusou o envio da mensagem'
          });
        }

        console.error('Erro ao enviar mensagem pelo WhatsApp:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao enviar mensagem pelo WhatsApp'
        });
      }
    }
  );



  // ============================================================
  // DOWNLOAD PROTEGIDO DE ANEXO
  // ============================================================

  app.get(
    '/api/atendimentos/:atendimentoId/anexos/:anexoId',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'visualizar'),
    async (req, res) => {
      try {
        const atendimentoId = Number(req.params.atendimentoId);
        const anexoId = Number(req.params.anexoId);

        if (
          !Number.isInteger(atendimentoId) ||
          atendimentoId <= 0 ||
          !Number.isInteger(anexoId) ||
          anexoId <= 0
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Identificação do anexo inválida'
          });
        }

        const [anexos] = await pool.query(
          `SELECT
             id,
             atendimento_id,
             nome_arquivo,
             tipo_mime,
             caminho_arquivo,
             excluido_em,
             expira_em,
             (
               expira_em IS NOT NULL
               AND expira_em <= NOW()
             ) AS expirado
           FROM atendimento_anexos
           WHERE id = ?
             AND atendimento_id = ?
           LIMIT 1`,
          [anexoId, atendimentoId]
        );

        if (!anexos.length) {
          return res.status(404).json({
            ok: false,
            error: 'Anexo não encontrado'
          });
        }

        const anexo = anexos[0];

        if (anexo.excluido_em || Number(anexo.expirado) === 1) {
          return res.status(410).json({
            ok: false,
            error: 'Este anexo expirou e não está mais disponível'
          });
        }

        if (
          !anexo.caminho_arquivo ||
          String(anexo.caminho_arquivo).startsWith('meta://')
        ) {
          return res.status(409).json({
            ok: false,
            error: 'O arquivo ainda está sendo processado'
          });
        }

        const diretorio = path.resolve(
          process.env.WHATSAPP_MEDIA_DIR ||
          '/opt/central-mykey-api/storage/whatsapp'
        );

        const caminho = path.resolve(
          diretorio,
          String(anexo.caminho_arquivo)
        );

        if (
          caminho !== diretorio &&
          !caminho.startsWith(diretorio + path.sep)
        ) {
          console.error(
            'Caminho de anexo bloqueado:',
            anexo.id
          );

          return res.status(403).json({
            ok: false,
            error: 'Acesso ao arquivo bloqueado'
          });
        }

        try {
          await fs.promises.access(caminho, fs.constants.R_OK);
        } catch {
          return res.status(404).json({
            ok: false,
            error: 'Arquivo físico não encontrado'
          });
        }

        if (anexo.tipo_mime) {
          res.type(anexo.tipo_mime);
        }

        return res.download(
          caminho,
          anexo.nome_arquivo || `anexo-${anexo.id}`,
          error => {
            if (error && !res.headersSent) {
              console.error('Erro no download do anexo:', error);
              res.status(500).json({
                ok: false,
                error: 'Erro ao baixar o anexo'
              });
            }
          }
        );
      } catch (error) {
        console.error('Erro ao localizar anexo:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao localizar o anexo'
        });
      }
    }
  );



  // ============================================================
  // LISTAR MODELOS APROVADOS DO WHATSAPP
  // ============================================================

  app.get(
    '/api/whatsapp/modelos/aprovados',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'visualizar'),
    async (req, res) => {
      try {
        const [modelos] = await pool.query(
          `SELECT
             id,
             nome,
             idioma,
             categoria,
             componentes_json,
             atualizado_em
           FROM whatsapp_modelos
           WHERE status = 'APROVADO'
             AND ativo = 1
           ORDER BY nome ASC`
        );

        return res.json({
          ok: true,
          total: modelos.length,
          dados: modelos
        });
      } catch (error) {
        console.error('Erro ao listar modelos do WhatsApp:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao listar modelos do WhatsApp'
        });
      }
    }
  );

  // ============================================================
  // ENVIAR MODELO DO WHATSAPP
  // ============================================================

  app.post(
    '/api/atendimentos/:id/mensagens/modelo',
    autenticarToken,
    exigirPermissao('ATENDIMENTO', 'editar'),
    async (req, res) => {
      const atendimentoId = Number(req.params.id);
      const modeloId = Number(req.body?.modelo_id);
      const parametros = req.body?.parametros ?? [];

      if (
        !Number.isInteger(atendimentoId) ||
        atendimentoId <= 0 ||
        !Number.isInteger(modeloId) ||
        modeloId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Atendimento ou modelo inválido'
        });
      }

      if (
        !Array.isArray(parametros) ||
        parametros.length > 10
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Parâmetros do modelo inválidos'
        });
      }

      try {
        const [atendimentos] = await pool.query(
          `SELECT
             a.id,
             a.protocolo,
             a.telefone_normalizado,
             a.canal,
             a.responsavel_id,
             a.status,
             u.nome AS responsavel
           FROM atendimentos a
           LEFT JOIN usuarios u ON u.id = a.responsavel_id
           WHERE a.id = ?
           LIMIT 1`,
          [atendimentoId]
        );

        if (!atendimentos.length) {
          return res.status(404).json({
            ok: false,
            error: 'Atendimento não encontrado'
          });
        }

        const atendimento = atendimentos[0];
        const ehAdministrador =
          req.usuario.perfil === 'Administrador';

        if (atendimento.canal !== 'WHATSAPP') {
          return res.status(409).json({
            ok: false,
            error: 'Este atendimento não pertence ao canal WhatsApp'
          });
        }

        if (
          atendimento.status === 'FINALIZADO' ||
          atendimento.status === 'CANCELADO'
        ) {
          return res.status(409).json({
            ok: false,
            error: 'Atendimento encerrado não aceita novos envios'
          });
        }

        if (!atendimento.responsavel_id && !ehAdministrador) {
          return res.status(409).json({
            ok: false,
            error: 'Assuma o atendimento antes de enviar o modelo'
          });
        }

        if (
          atendimento.responsavel_id &&
          Number(atendimento.responsavel_id) !==
            Number(req.usuario.id) &&
          !ehAdministrador
        ) {
          return res.status(403).json({
            ok: false,
            error:
              'Somente o responsável atual pode enviar neste atendimento',
            responsavel_id: atendimento.responsavel_id,
            responsavel: atendimento.responsavel
          });
        }

        const [modelos] = await pool.query(
          `SELECT id, nome, idioma, categoria
           FROM whatsapp_modelos
           WHERE id = ?
             AND status = 'APROVADO'
             AND ativo = 1
           LIMIT 1`,
          [modeloId]
        );

        if (!modelos.length) {
          return res.status(404).json({
            ok: false,
            error: 'Modelo aprovado e ativo não encontrado'
          });
        }

        const modelo = modelos[0];
        const enviar = app.locals.enviarModeloWhatsapp;

        if (typeof enviar !== 'function') {
          return res.status(503).json({
            ok: false,
            error: 'Integração do WhatsApp indisponível'
          });
        }

        const envio = await enviar({
          telefone: atendimento.telefone_normalizado,
          nome: modelo.nome,
          idioma: modelo.idioma,
          parametros
        });

        const connection = await pool.getConnection();

        try {
          await connection.beginTransaction();

          const resumo =
            `[Modelo: ${modelo.nome}]` +
            (
              parametros.length
                ? ` ${parametros.map(String).join(' | ')}`
                : ''
            );

          const [mensagem] = await connection.query(
            `INSERT INTO atendimento_mensagens
               (atendimento_id, direcao, autor_tipo, usuario_id,
                tipo_conteudo, texto, mensagem_externa_id,
                status_entrega, status_atualizado_em)
             VALUES (?, 'SAIDA', 'ATENDENTE', ?, 'TEXTO', ?, ?,
                     'ENVIADA', NOW())`,
            [
              atendimento.id,
              req.usuario.id,
              resumo.slice(0, 5000),
              envio.mensagem_externa_id
            ]
          );

          await connection.query(
            `UPDATE atendimentos
             SET modo = 'HUMANO',
                 ultima_mensagem_em = NOW()
             WHERE id = ?`,
            [atendimento.id]
          );

          await connection.query(
            `INSERT INTO auditoria
               (usuario_id, modulo, acao, entidade, entidade_id,
                descricao, dados_antes, dados_depois, ip)
             VALUES (?, 'ATENDIMENTO', 'ENVIAR_MODELO_WHATSAPP',
                     'atendimentos', ?, ?, NULL, ?, ?)`,
            [
              req.usuario.id,
              String(atendimento.id),
              `Modelo ${modelo.nome} enviado no atendimento ${atendimento.protocolo}`,
              JSON.stringify({
                mensagem_id: mensagem.insertId,
                modelo_id: modelo.id,
                modelo: modelo.nome,
                mensagem_externa_id: envio.mensagem_externa_id
              }),
              req.ip || null
            ]
          );

          await connection.commit();

          return res.status(201).json({
            ok: true,
            mensagem: 'Modelo enviado com sucesso',
            envio: {
              id: mensagem.insertId,
              atendimento_id: atendimento.id,
              modelo_id: modelo.id,
              modelo: modelo.nome,
              mensagem_externa_id: envio.mensagem_externa_id
            }
          });
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      } catch (error) {
        if (error.codigo === 'WHATSAPP_NAO_CONFIGURADO') {
          return res.status(503).json({
            ok: false,
            error:
              'Envio ainda não configurado. Faltam as credenciais oficiais da Meta.'
          });
        }

        if (
          error.codigo === 'WHATSAPP_DADOS_INVALIDOS' ||
          error.codigo === 'WHATSAPP_CONFIGURACAO_INVALIDA'
        ) {
          return res.status(400).json({
            ok: false,
            error: 'Dados ou configuração do modelo inválidos'
          });
        }

        if (error.codigo === 'WHATSAPP_ENVIO_FALHOU') {
          console.error(
            'Meta recusou modelo:',
            error.statusMeta,
            error.dadosMeta
          );

          return res.status(502).json({
            ok: false,
            error: 'A Meta recusou o envio do modelo'
          });
        }

        console.error('Erro ao enviar modelo do WhatsApp:', error);

        return res.status(500).json({
          ok: false,
          error: 'Erro ao enviar modelo do WhatsApp'
        });
      }
    }
  );

};
