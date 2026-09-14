module.exports = function (app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;


  // ============================================================
  // CENTRAL MYKEY - PEDIDOS DE SENHA
  // ============================================================

  // Criar novo pedido
  app.post('/api/pedidos', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'criar'), async (req, res) => {

    const connection = await pool.getConnection();

    try {

      const {
        cliente_id,
        servico_id,
        placa,
        chassi,
        marca,
        modelo,
        ano,
        atendente_id
      } = req.body;

      if (!cliente_id || !servico_id) {
        return res.status(400).json({
          ok: false,
          error: 'cliente_id e servico_id são obrigatórios'
        });
      }

      await connection.beginTransaction();

      // --------------------------------------------------------
      // 1. Buscar serviço
      // --------------------------------------------------------

      const [servicos] = await connection.query(
        `SELECT *
         FROM servicos
         WHERE id = ?
           AND ativo = 1
         LIMIT 1`,
        [servico_id]
      );

      if (!servicos.length) {
        await connection.rollback();

        return res.status(404).json({
          ok: false,
          error: 'Serviço não encontrado'
        });
      }

      const servico = servicos[0];

      // --------------------------------------------------------
      // 2. Validar dados exigidos pelo serviço
      // --------------------------------------------------------

      if (servico.exige_placa && !placa) {
        await connection.rollback();

        return res.status(400).json({
          ok: false,
          error: 'Placa obrigatória para este serviço'
        });
      }

      if (servico.exige_chassi && !chassi) {
        await connection.rollback();

        return res.status(400).json({
          ok: false,
          error: 'Chassi obrigatório para este serviço'
        });
      }

      // --------------------------------------------------------
      // 3. Buscar fornecedor disponível com menor custo
      // --------------------------------------------------------
      // --------------------------------------------------------
// 3. Prioridade: banco próprio -> fornecedor externo
// --------------------------------------------------------


// --------------------------------------------------------
// Validar cliente e modalidade de cobranca
// --------------------------------------------------------

const [clientes] = await connection.query(
  `SELECT
      id,
      nome,
      tipo_cobranca,
      dia_fechamento,
      prazo_pagamento_dias,
      limite_credito,
      credito_status
   FROM clientes
   WHERE id = ?
     AND ativo = 1
   LIMIT 1
   FOR UPDATE`,
  [cliente_id]
);

if (!clientes.length) {
  await connection.rollback();

  return res.status(404).json({
    ok: false,
    error: 'Cliente nao encontrado ou inativo'
  });
}

const cliente = clientes[0];

if (
  cliente.tipo_cobranca === 'FATURAMENTO_SEMANAL' &&
  cliente.credito_status === 'BLOQUEADO'
) {
  await connection.rollback();

  return res.status(403).json({
    ok: false,
    error: 'Credito bloqueado. Solicite analise do financeiro.'
  });
}

if (cliente.tipo_cobranca === 'ANTECIPADO') {
  const protocoloPagamento =
    'MK' +
    Date.now().toString() +
    Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0');

  const [pedidoAguardando] = await connection.query(
    `INSERT INTO pedidos_senha (
       protocolo,
       cliente_id,
       servico_id,
       placa,
       chassi,
       marca,
       modelo,
       ano,
       status,
       valor_venda,
       custo,
       fornecedor_id,
       origem_id,
       atendente_id
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?,
             'AGUARDANDO_PAGAMENTO',
             ?, 0, NULL, NULL, ?)`,
    [
      protocoloPagamento,
      cliente_id,
      servico_id,
      placa || null,
      chassi ? String(chassi).trim().toUpperCase() : null,
      marca || servico.marca || null,
      modelo || null,
      ano || null,
      Number(servico.preco_base || 0),
      req.usuario.id
    ]
  );

  await connection.query(
    `INSERT INTO pedido_historico (
       pedido_id,
       usuario_id,
       tipo,
       descricao,
       dados
     )
     VALUES (?, ?, 'AGUARDANDO_PAGAMENTO', ?, ?)`,
    [
      pedidoAguardando.insertId,
      req.usuario.id,
      'Pedido criado aguardando confirmacao do pagamento',
      JSON.stringify({
        tipo_cobranca: cliente.tipo_cobranca,
        valor: Number(servico.preco_base || 0),
        moeda: servico.moeda || 'BRL'
      })
    ]
  );

  await connection.commit();

  return res.status(201).json({
    ok: true,
    message: 'Pedido criado aguardando pagamento',
    pedido: {
      id: pedidoAguardando.insertId,
      protocolo: protocoloPagamento,
      cliente: cliente.nome,
      servico: servico.nome,
      valor_venda: Number(servico.preco_base || 0),
      moeda: servico.moeda || 'BRL',
      status: 'AGUARDANDO_PAGAMENTO',
      pagamento_necessario: true
    }
  });
}

let fornecedorId = null;
let fornecedorNome = null;
let custo = 0;
let origemId = null;
let bancoSenhaId = null;
let origemNome = null;

// --------------------------------------------------------
// 3.1 Buscar primeiro na BASE PRÓPRIA pelo chassi
// --------------------------------------------------------

let bancoProprio = [];

if (chassi) {

  const chassiNormalizado = String(chassi)
    .trim()
    .toUpperCase();

  [bancoProprio] = await connection.query(
    `SELECT
        bs.id,
        bs.origem_id,
        bs.codigo_mecanico,
        bs.codigo_imobilizador,
        bs.codigo_radio,
        bs.pin,
        bs.confiabilidade
     FROM banco_senhas bs
     INNER JOIN origens_senha os
       ON os.id = bs.origem_id
     WHERE UPPER(bs.chassi) = ?
       AND bs.ativo = 1
       AND os.codigo = 'BASE_PROPRIA'
       AND os.ativo = 1
     ORDER BY
       CASE bs.confiabilidade
         WHEN 'CONFIRMADA' THEN 1
         WHEN 'ALTA' THEN 2
         WHEN 'MEDIA' THEN 3
         WHEN 'BAIXA' THEN 4
         ELSE 5
       END,
       bs.id DESC
     LIMIT 1`,
    [chassiNormalizado]
  );
}

// --------------------------------------------------------
// 3.2 Se encontrou no banco próprio, custo é zero
// --------------------------------------------------------

if (bancoProprio.length) {

  bancoSenhaId = bancoProprio[0].id;
  origemId = bancoProprio[0].origem_id;
  origemNome = 'BASE_PROPRIA';
  custo = 0;

} else {

  // ------------------------------------------------------
  // 3.3 Não encontrou na base própria:
  // buscar fornecedor ativo, disponível e de menor custo
  // ------------------------------------------------------

  const [fornecedores] = await connection.query(
    `SELECT
        fs.fornecedor_id,
        fs.custo,
        f.nome AS fornecedor,
        f.horario_inicio,
        f.horario_fim
     FROM fornecedor_servicos fs
     INNER JOIN fornecedores f
       ON f.id = fs.fornecedor_id
     WHERE fs.codigo_servico = ?
       AND fs.ativo = 1
       AND f.ativo = 1
       AND (
         f.horario_inicio IS NULL
         OR f.horario_fim IS NULL
         OR CURTIME() BETWEEN f.horario_inicio AND f.horario_fim
       )
     ORDER BY fs.custo ASC
     LIMIT 1`,
    [servico.codigo]
  );

  if (fornecedores.length) {

    fornecedorId = fornecedores[0].fornecedor_id;
    fornecedorNome = fornecedores[0].fornecedor;
    custo = Number(fornecedores[0].custo);

    origemId = 2;
    origemNome = 'FORNECEDOR';
  }
}

      // --------------------------------------------------------
      // 4. Gerar protocolo
      // --------------------------------------------------------

      const protocolo =
        'MK' +
        Date.now().toString() +
        Math.floor(Math.random() * 1000)
          .toString()
          .padStart(3, '0');

      // --------------------------------------------------------
      // 5. Criar pedido
      // --------------------------------------------------------

      const [resultado] = await connection.query(
        `INSERT INTO pedidos_senha
        (
          protocolo,
          cliente_id,
          servico_id,
          placa,
          chassi,
          marca,
          modelo,
          ano,
          status,
          valor_venda,
          custo,
          fornecedor_id,
          origem_id,
          atendente_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          protocolo,
          cliente_id,
          servico_id,
          placa || null,
          chassi
            ? String(chassi).trim().toUpperCase()
            : null,
          marca || servico.marca || null,
          modelo || null,
          ano || null,
          'ABERTO',
          Number(servico.preco_base || 0),
          custo,
          fornecedorId,
          origemId,
          req.usuario.id
        ]
      );
    // --------------------------------------------------------
    // 6. Registrar resultado automático da BASE PRÓPRIA
    // --------------------------------------------------------

    
      // --------------------------------------------------------
      // Vincular pedido do cliente pos-pago a fatura semanal
      // --------------------------------------------------------

      const [fatura] = await connection.query(
        `INSERT INTO faturas_clientes (
           cliente_id,
           periodo_inicio,
           periodo_fim,
           vencimento,
           moeda,
           valor_total,
           status
         )
         VALUES (
           ?,
           DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY),
           DATE_ADD(
             DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY),
             INTERVAL 6 DAY
           ),
           DATE_ADD(
             DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY),
             INTERVAL (6 + ?) DAY
           ),
           ?,
           ?,
           'ABERTA'
         )
         ON DUPLICATE KEY UPDATE
           id = LAST_INSERT_ID(id),
           valor_total = valor_total + VALUES(valor_total),
           atualizado_em = NOW()`,
        [
          cliente.id,
          Number(cliente.prazo_pagamento_dias || 3),
          servico.moeda || 'BRL',
          Number(servico.preco_base || 0)
        ]
      );

      await connection.query(
        `INSERT INTO fatura_itens (
           fatura_id,
           pedido_senha_id,
           valor
         )
         VALUES (?, ?, ?)`,
        [
          fatura.insertId,
          resultado.insertId,
          Number(servico.preco_base || 0)
        ]
      );

      await connection.query(
        `INSERT INTO pedido_historico (
           pedido_id,
           usuario_id,
           tipo,
           descricao,
           dados
         )
         VALUES (?, ?, 'FATURAMENTO_SEMANAL', ?, ?)`,
        [
          resultado.insertId,
          req.usuario.id,
          'Pedido adicionado ao faturamento semanal',
          JSON.stringify({
            fatura_id: fatura.insertId,
            periodo: 'SEGUNDA_A_DOMINGO',
            prazo_pagamento_dias:
              Number(cliente.prazo_pagamento_dias || 3),
            valor: Number(servico.preco_base || 0),
            moeda: servico.moeda || 'BRL'
          })
        ]
      );

if (bancoProprio.length) {
      const senhaEncontrada = bancoProprio[0];
      await connection.query(
        `UPDATE banco_senhas
         SET quantidade_usos = quantidade_usos + 1
         WHERE id = ?`,
        [senhaEncontrada.id]
      );
      await connection.query(
        `UPDATE pedidos_senha
         SET status = 'CONCLUIDO',
             concluido_em = NOW()
         WHERE id = ?`,
        [resultado.insertId]
      );

      await connection.query(
        `INSERT INTO pedido_resultados (
          pedido_id,
          banco_senha_id,
          origem_id,
          fornecedor_id,
          codigo_mecanico,
          codigo_imobilizador,
          codigo_radio,
          pin,
          resultado,
          custo,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          resultado.insertId,
          senhaEncontrada.id,
          senhaEncontrada.origem_id,
          null,
          senhaEncontrada.codigo_mecanico,
          senhaEncontrada.codigo_imobilizador,
          senhaEncontrada.codigo_radio,
          senhaEncontrada.pin,
          JSON.stringify({
            origem: 'BASE_PROPRIA',
            confiabilidade: senhaEncontrada.confiabilidade
          }),
          0,
          'ENCONTRADO'
        ]
      );
    }
      await connection.commit();

      return res.status(201).json({
        ok: true,
        message: 'Pedido criado com sucesso',
        pedido: {
          id: resultado.insertId,
          protocolo,
          servico: servico.nome,
          fornecedor_id: fornecedorId,
          fornecedor: fornecedorNome,
          custo,
          valor_venda: Number(servico.preco_base || 0),
          status: bancoProprio.length ? 'CONCLUIDO' : 'ABERTO',
            resultado_automatico: bancoProprio.length
              ? {
                  encontrado: true,
                  origem: origemNome,
                  banco_senha_id: bancoSenhaId,
                  codigo_mecanico: bancoProprio[0].codigo_mecanico,
                  codigo_imobilizador: bancoProprio[0].codigo_imobilizador,
                  codigo_radio: bancoProprio[0].codigo_radio,
                  pin: bancoProprio[0].pin,
                  confiabilidade: bancoProprio[0].confiabilidade
                }
              : {
                  encontrado: false,
                  origem: origemNome,
                  aguardando_fornecedor: Boolean(fornecedorId)
                }
        }
      });

    } catch (error) {

      await connection.rollback();

      console.error('Erro ao criar pedido:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao criar pedido'
      });

    } finally {

      connection.release();

    }

  });

  // ============================================================
  // REGISTRAR RESULTADO RECEBIDO DO FORNECEDOR
  // ============================================================

  app.post('/api/pedidos/:id/resultado', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'editar'), async (req, res) => {
    const pedidoId = Number(req.params.id);

    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'ID do pedido inválido'
      });
    }

    const {
      codigo_mecanico,
      codigo_imobilizador,
      codigo_radio,
      pin,
      resultado,
      usuario_id
    } = req.body;

    if (
      !codigo_mecanico &&
      !codigo_imobilizador &&
      !codigo_radio &&
      !pin &&
      resultado == null
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Informe pelo menos um resultado técnico'
      });
    }

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [pedidos] = await connection.query(
        `SELECT
           id,
           protocolo,
           status,
           origem_id,
           fornecedor_id,
           custo
         FROM pedidos_senha
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [pedidoId]
      );

      if (!pedidos.length) {
        await connection.rollback();

        return res.status(404).json({
          ok: false,
          error: 'Pedido não encontrado'
        });
      }

      const pedido = pedidos[0];

      if (pedido.status === 'CONCLUIDO') {
        await connection.rollback();

        return res.status(409).json({
          ok: false,
          error: 'Este pedido já está concluído'
        });
      }

      if (pedido.status === 'CANCELADO') {
        await connection.rollback();

        return res.status(409).json({
          ok: false,
          error: 'Não é possível lançar resultado em pedido cancelado'
        });
      }

      const [registro] = await connection.query(
        `INSERT INTO pedido_resultados (
          pedido_id,
          banco_senha_id,
          origem_id,
          fornecedor_id,
          codigo_mecanico,
          codigo_imobilizador,
          codigo_radio,
          pin,
          resultado,
          custo,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pedido.id,
          null,
          pedido.origem_id || 2,
          pedido.fornecedor_id,
          codigo_mecanico || null,
          codigo_imobilizador || null,
          codigo_radio || null,
          pin || null,
          JSON.stringify(resultado ?? {}),
          Number(pedido.custo || 0),
          'ENCONTRADO'
        ]
      );

      await connection.query(
        `UPDATE pedidos_senha
         SET status = 'CONCLUIDO',
             concluido_em = NOW()
         WHERE id = ?`,
        [pedido.id]
      );

      await connection.query(
        `INSERT INTO pedido_historico (
          pedido_id,
          usuario_id,
          tipo,
          descricao,
          dados
        )
        VALUES (?, ?, ?, ?, ?)`,
        [
          pedido.id,
          usuario_id || null,
          'RESULTADO_RECEBIDO',
          'Resultado do fornecedor registrado e pedido concluído',
          JSON.stringify({
            resultado_id: registro.insertId,
            fornecedor_id: pedido.fornecedor_id,
            status_anterior: pedido.status,
            status_novo: 'CONCLUIDO'
          })
        ]
      );

      await connection.commit();

      return res.status(201).json({
        ok: true,
        message: 'Resultado registrado e pedido concluído',
        pedido: {
          id: pedido.id,
          protocolo: pedido.protocolo,
          status: 'CONCLUIDO',
          fornecedor_id: pedido.fornecedor_id,
          custo: Number(pedido.custo || 0)
        },
        resultado: {
          id: registro.insertId,
          codigo_mecanico: codigo_mecanico || null,
          codigo_imobilizador: codigo_imobilizador || null,
          codigo_radio: codigo_radio || null,
          pin: pin || null
        }
      });

    } catch (error) {
      await connection.rollback();

      console.error('Erro ao registrar resultado do pedido:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao registrar resultado do pedido'
      });

    } finally {
      connection.release();
    }
  });

  // ============================================================
  // CONFIRMAR RESULTADO E ADICIONAR À BASE PRÓPRIA
  // ============================================================

  app.post('/api/pedidos/:id/resultado/confirmar', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'editar'), async (req, res) => {
    const pedidoId = Number(req.params.id);
    const usuarioId = req.body.usuario_id || null;

    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'ID do pedido inválido'
      });
    }

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [pedidos] = await connection.query(
        `SELECT
           p.id,
           p.protocolo,
           p.placa,
           p.chassi,
           p.marca,
           p.modelo,
           p.ano,
           p.fornecedor_id,
           s.codigo AS tipo
         FROM pedidos_senha p
         INNER JOIN servicos s
           ON s.id = p.servico_id
         WHERE p.id = ?
         LIMIT 1
         FOR UPDATE`,
        [pedidoId]
      );

      if (!pedidos.length) {
        await connection.rollback();

        return res.status(404).json({
          ok: false,
          error: 'Pedido não encontrado'
        });
      }

      const pedido = pedidos[0];

      const [resultados] = await connection.query(
        `SELECT *
         FROM pedido_resultados
         WHERE pedido_id = ?
           AND status = 'ENCONTRADO'
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        [pedido.id]
      );

      if (!resultados.length) {
        await connection.rollback();

        return res.status(409).json({
          ok: false,
          error: 'Não existe resultado pendente de confirmação'
        });
      }

      const resultadoEncontrado = resultados[0];

      await connection.query(
        `UPDATE pedido_resultados
         SET status = 'CONFIRMADO'
         WHERE id = ?`,
        [resultadoEncontrado.id]
      );

      let bancoSenhaId = null;
      let acaoBase = 'NAO_ADICIONADO_SEM_CHASSI';

      if (pedido.chassi) {
        const chassiNormalizado = String(pedido.chassi)
          .trim()
          .toUpperCase();

        const [existentes] = await connection.query(
          `SELECT bs.id
           FROM banco_senhas bs
           INNER JOIN origens_senha os
             ON os.id = bs.origem_id
           WHERE UPPER(bs.chassi) = ?
             AND bs.ativo = 1
             AND os.codigo = 'BASE_PROPRIA'
           ORDER BY bs.id DESC
           LIMIT 1
           FOR UPDATE`,
          [chassiNormalizado]
        );

        if (existentes.length) {
          bancoSenhaId = existentes[0].id;
          acaoBase = 'ATUALIZADO';

          await connection.query(
            `UPDATE banco_senhas
             SET tipo = ?,
                 marca = COALESCE(?, marca),
                 modelo = COALESCE(?, modelo),
                 ano_inicio = COALESCE(?, ano_inicio),
                 ano_fim = COALESCE(?, ano_fim),
                 placa = COALESCE(?, placa),
                 codigo_mecanico = COALESCE(?, codigo_mecanico),
                 codigo_imobilizador = COALESCE(?, codigo_imobilizador),
                 codigo_radio = COALESCE(?, codigo_radio),
                 pin = COALESCE(?, pin),
                 fornecedor_id = COALESCE(?, fornecedor_id),
                 confiabilidade = 'CONFIRMADA',
                 quantidade_sucessos = quantidade_sucessos + 1,
                 ativo = 1
             WHERE id = ?`,
            [
              pedido.tipo,
              pedido.marca,
              pedido.modelo,
              pedido.ano,
              pedido.ano,
              pedido.placa,
              resultadoEncontrado.codigo_mecanico,
              resultadoEncontrado.codigo_imobilizador,
              resultadoEncontrado.codigo_radio,
              resultadoEncontrado.pin,
              pedido.fornecedor_id,
              bancoSenhaId
            ]
          );

        } else {
          acaoBase = 'CRIADO';

          const [novoBanco] = await connection.query(
            `INSERT INTO banco_senhas (
              tipo,
              marca,
              modelo,
              ano_inicio,
              ano_fim,
              placa,
              chassi,
              codigo_mecanico,
              codigo_imobilizador,
              codigo_radio,
              pin,
              dados_extras,
              origem_id,
              fornecedor_id,
              confiabilidade,
              quantidade_sucessos,
              ativo
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              pedido.tipo,
              pedido.marca || null,
              pedido.modelo || null,
              pedido.ano || null,
              pedido.ano || null,
              pedido.placa || null,
              chassiNormalizado,
              resultadoEncontrado.codigo_mecanico,
              resultadoEncontrado.codigo_imobilizador,
              resultadoEncontrado.codigo_radio,
              resultadoEncontrado.pin,
              JSON.stringify({
                pedido_id: pedido.id,
                resultado_id: resultadoEncontrado.id,
                origem_original: 'FORNECEDOR'
              }),
              1,
              pedido.fornecedor_id,
              'CONFIRMADA',
              1,
              1
            ]
          );

          bancoSenhaId = novoBanco.insertId;
        }
      }

      await connection.query(
        `INSERT INTO pedido_historico (
          pedido_id,
          usuario_id,
          tipo,
          descricao,
          dados
        )
        VALUES (?, ?, ?, ?, ?)`,
        [
          pedido.id,
          usuarioId,
          'RESULTADO_CONFIRMADO',
          'Resultado confirmado e processado para a base própria',
          JSON.stringify({
            resultado_id: resultadoEncontrado.id,
            banco_senha_id: bancoSenhaId,
            acao_base: acaoBase
          })
        ]
      );

      await connection.commit();

      return res.json({
        ok: true,
        message: 'Resultado confirmado com sucesso',
        pedido_id: pedido.id,
        resultado_id: resultadoEncontrado.id,
        banco_senha_id: bancoSenhaId,
        acao_base: acaoBase
      });

    } catch (error) {
      await connection.rollback();

      console.error('Erro ao confirmar resultado:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao confirmar resultado'
      });

    } finally {
      connection.release();
    }
  });
  // ============================================================
  // MARCAR RESULTADO COMO INCORRETO E BLOQUEAR A BASE
  // ============================================================

  app.post('/api/pedidos/:id/resultado/incorreto', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'editar'), async (req, res) => {
    const pedidoId = Number(req.params.id);
    const usuarioId = req.body.usuario_id || null;
    const motivo = req.body.motivo || 'Resultado informado como incorreto';

    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'ID do pedido inválido'
      });
    }

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [pedidos] = await connection.query(
        `SELECT
           p.id,
           p.protocolo,
           p.status,
           p.servico_id,
           s.codigo AS codigo_servico
         FROM pedidos_senha p
         INNER JOIN servicos s
           ON s.id = p.servico_id
         WHERE p.id = ?
         LIMIT 1
         FOR UPDATE`,
        [pedidoId]
      );

      if (!pedidos.length) {
        await connection.rollback();

        return res.status(404).json({
          ok: false,
          error: 'Pedido não encontrado'
        });
      }

      const pedido = pedidos[0];

      const [resultados] = await connection.query(
        `SELECT
           id,
           banco_senha_id,
           status
         FROM pedido_resultados
         WHERE pedido_id = ?
           AND status IN ('ENCONTRADO', 'CONFIRMADO')
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        [pedido.id]
      );

      if (!resultados.length) {
        await connection.rollback();

        return res.status(409).json({
          ok: false,
          error: 'Não existe resultado para marcar como incorreto'
        });
      }

      const resultadoIncorreto = resultados[0];

      await connection.query(
        `UPDATE pedido_resultados
         SET status = 'INCORRETO'
         WHERE id = ?`,
        [resultadoIncorreto.id]
      );

      let bancoBloqueado = false;

      if (resultadoIncorreto.banco_senha_id) {
        await connection.query(
          `UPDATE banco_senhas
           SET quantidade_erros = quantidade_erros + 1,
               confiabilidade = 'BAIXA',
               ativo = 0
           WHERE id = ?`,
          [resultadoIncorreto.banco_senha_id]
        );

        bancoBloqueado = true;
      }

      const [fornecedores] = await connection.query(
        `SELECT
           fs.fornecedor_id,
           fs.custo,
           f.nome AS fornecedor
         FROM fornecedor_servicos fs
         INNER JOIN fornecedores f
           ON f.id = fs.fornecedor_id
         WHERE fs.codigo_servico = ?
           AND fs.ativo = 1
           AND f.ativo = 1
           AND (
             f.horario_inicio IS NULL
             OR f.horario_fim IS NULL
             OR CURTIME() BETWEEN f.horario_inicio AND f.horario_fim
           )
         ORDER BY fs.custo ASC
         LIMIT 1`,
        [pedido.codigo_servico]
      );

      const fornecedor = fornecedores.length
        ? fornecedores[0]
        : null;

      const statusNovo = fornecedor
        ? 'EM_CONSULTA'
        : 'ERRO';

      await connection.query(
        `UPDATE pedidos_senha
         SET status = ?,
             fornecedor_id = ?,
             origem_id = ?,
             custo = ?,
             concluido_em = NULL
         WHERE id = ?`,
        [
          statusNovo,
          fornecedor ? fornecedor.fornecedor_id : null,
          fornecedor ? 2 : null,
          fornecedor ? Number(fornecedor.custo) : 0,
          pedido.id
        ]
      );

      await connection.query(
        `INSERT INTO pedido_historico (
          pedido_id,
          usuario_id,
          tipo,
          descricao,
          dados
        )
        VALUES (?, ?, ?, ?, ?)`,
        [
          pedido.id,
          usuarioId,
          'RESULTADO_INCORRETO',
          motivo,
          JSON.stringify({
            resultado_id: resultadoIncorreto.id,
            banco_senha_id: resultadoIncorreto.banco_senha_id,
            banco_bloqueado: bancoBloqueado,
            status_anterior: pedido.status,
            status_novo: statusNovo,
            fornecedor_id: fornecedor
              ? fornecedor.fornecedor_id
              : null
          })
        ]
      );

      await connection.commit();

      return res.json({
        ok: true,
        message: bancoBloqueado
          ? 'Resultado marcado como incorreto e senha bloqueada'
          : 'Resultado marcado como incorreto',
        pedido: {
          id: pedido.id,
          protocolo: pedido.protocolo,
          status: statusNovo
        },
        base: {
          banco_senha_id: resultadoIncorreto.banco_senha_id,
          bloqueada: bancoBloqueado
        },
        fornecedor: fornecedor
          ? {
              id: fornecedor.fornecedor_id,
              nome: fornecedor.fornecedor,
              custo: Number(fornecedor.custo)
            }
          : null
      });

    } catch (error) {
      await connection.rollback();

      console.error('Erro ao marcar resultado incorreto:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao marcar resultado incorreto'
      });

    } finally {
      connection.release();
    }
  });

  // ============================================================
  // DETALHAR PEDIDO
  // ============================================================

  app.get('/api/pedidos/:id', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'visualizar'), async (req, res) => {
    const pedidoId = Number(req.params.id);

    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'ID do pedido inválido'
      });
    }

    try {
      const [pedidos] = await pool.query(
        `SELECT
           p.id,
           p.protocolo,
           p.status,
           p.placa,
           p.chassi,
           p.marca,
           p.modelo,
           p.ano,
           p.valor_venda,
           p.custo,
           p.moeda,
           p.cliente_id,
           c.nome AS cliente,
           p.servico_id,
           s.codigo AS codigo_servico,
           s.nome AS servico,
           p.origem_id,
           os.codigo AS origem_codigo,
           os.nome AS origem,
           p.fornecedor_id,
           f.nome AS fornecedor,
           p.atendente_id,
           u.nome AS atendente,
           p.criado_em,
           p.atualizado_em,
           p.concluido_em
         FROM pedidos_senha p
         INNER JOIN clientes c
           ON c.id = p.cliente_id
         INNER JOIN servicos s
           ON s.id = p.servico_id
         LEFT JOIN origens_senha os
           ON os.id = p.origem_id
         LEFT JOIN fornecedores f
           ON f.id = p.fornecedor_id
         LEFT JOIN usuarios u
           ON u.id = p.atendente_id
         WHERE p.id = ?
         LIMIT 1`,
        [pedidoId]
      );

      if (!pedidos.length) {
        return res.status(404).json({
          ok: false,
          error: 'Pedido não encontrado'
        });
      }

      const [resultados] = await pool.query(
        `SELECT
           pr.id,
           pr.banco_senha_id,
           pr.origem_id,
           os.codigo AS origem_codigo,
           os.nome AS origem,
           pr.fornecedor_id,
           f.nome AS fornecedor,
           pr.codigo_mecanico,
           pr.codigo_imobilizador,
           pr.codigo_radio,
           pr.pin,
           pr.resultado,
           pr.custo,
           pr.status,
           pr.criado_em
         FROM pedido_resultados pr
         LEFT JOIN origens_senha os
           ON os.id = pr.origem_id
         LEFT JOIN fornecedores f
           ON f.id = pr.fornecedor_id
         WHERE pr.pedido_id = ?
         ORDER BY pr.id DESC`,
        [pedidoId]
      );

      const [historico] = await pool.query(
        `SELECT
           ph.id,
           ph.usuario_id,
           u.nome AS usuario,
           ph.tipo,
           ph.descricao,
           ph.dados,
           ph.criado_em
         FROM pedido_historico ph
         LEFT JOIN usuarios u
           ON u.id = ph.usuario_id
         WHERE ph.pedido_id = ?
         ORDER BY ph.id DESC`,
        [pedidoId]
      );

      return res.json({
        ok: true,
        pedido: pedidos[0],
        resultados,
        historico
      });

    } catch (error) {
      console.error('Erro ao detalhar pedido:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao detalhar pedido'
      });
    }
  });

  // ============================================================
  // RESUMO OPERACIONAL DO PAINEL
  // ============================================================

  app.get('/api/fila-pedidos/resumo', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'visualizar'), async (req, res) => {
    try {
      const [indicadores] = await pool.query(
        `SELECT
           DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS data_referencia,
           COUNT(*) AS total_hoje,
           SUM(p.status = 'ABERTO') AS abertos,
           SUM(p.status = 'AGUARDANDO_DADOS') AS aguardando_dados,
           SUM(p.status = 'EM_CONSULTA') AS em_consulta,
           SUM(p.status = 'AGUARDANDO_PAGAMENTO') AS aguardando_pagamento,
           SUM(p.status = 'PAGO') AS pagos,
           SUM(p.status = 'CONCLUIDO') AS concluidos,
           SUM(p.status = 'CANCELADO') AS cancelados,
           SUM(p.status = 'ERRO') AS com_erro,
           SUM(p.origem_id = 1) AS atendidos_base_propria,
           SUM(p.origem_id = 2) AS enviados_fornecedor
         FROM pedidos_senha p
         WHERE p.criado_em >= CURDATE()
           AND p.criado_em < CURDATE() + INTERVAL 1 DAY`
      );

      const [financeiro] = await pool.query(
        `SELECT
           p.moeda,
           COUNT(*) AS quantidade,
           COALESCE(SUM(p.valor_venda), 0) AS valor_vendas,
           COALESCE(SUM(p.custo), 0) AS valor_custos,
           COALESCE(
             SUM(p.valor_venda) - SUM(p.custo),
             0
           ) AS margem_bruta
         FROM pedidos_senha p
         WHERE p.criado_em >= CURDATE()
           AND p.criado_em < CURDATE() + INTERVAL 1 DAY
         GROUP BY p.moeda
         ORDER BY p.moeda`
      );

      const resumo = indicadores[0];

      return res.json({
        ok: true,
        periodo: 'HOJE',
        data_referencia: resumo.data_referencia,
        indicadores: {
          total: Number(resumo.total_hoje || 0),
          abertos: Number(resumo.abertos || 0),
          aguardando_dados: Number(resumo.aguardando_dados || 0),
          em_consulta: Number(resumo.em_consulta || 0),
          aguardando_pagamento: Number(
            resumo.aguardando_pagamento || 0
          ),
          pagos: Number(resumo.pagos || 0),
          concluidos: Number(resumo.concluidos || 0),
          cancelados: Number(resumo.cancelados || 0),
          com_erro: Number(resumo.com_erro || 0),
          atendidos_base_propria: Number(
            resumo.atendidos_base_propria || 0
          ),
          enviados_fornecedor: Number(
            resumo.enviados_fornecedor || 0
          )
        },
        financeiro: financeiro.map((item) => ({
          moeda: item.moeda,
          quantidade: Number(item.quantidade || 0),
          valor_vendas: Number(item.valor_vendas || 0),
          valor_custos: Number(item.valor_custos || 0),
          margem_bruta: Number(item.margem_bruta || 0)
        }))
      });

    } catch (error) {
      console.error('Erro ao gerar resumo da fila:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao gerar resumo da fila'
      });
    }
  });

  // ============================================================
  // FILA OPERACIONAL DE PEDIDOS
  // ============================================================

  app.get('/api/fila-pedidos', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'visualizar'), async (req, res) => {
    try {
      const status = req.query.status
        ? String(req.query.status).trim().toUpperCase()
        : null;

      const fornecedorId = Number(req.query.fornecedor_id) || null;
      const clienteId = Number(req.query.cliente_id) || null;
      const busca = req.query.busca
        ? String(req.query.busca).trim()
        : null;

      const pagina = Math.max(
        1,
        Number.parseInt(req.query.pagina, 10) || 1
      );

      const limite = Math.min(
        100,
        Math.max(1, Number.parseInt(req.query.limite, 10) || 50)
      );

      const offset = (pagina - 1) * limite;

      const statusPermitidos = [
        'ABERTO',
        'AGUARDANDO_DADOS',
        'EM_CONSULTA',
        'AGUARDANDO_PAGAMENTO',
        'PAGO',
        'CONCLUIDO',
        'CANCELADO',
        'ERRO'
      ];

      if (status && !statusPermitidos.includes(status)) {
        return res.status(400).json({
          ok: false,
          error: 'Status inválido'
        });
      }

      const filtros = [];
      const parametros = [];

      if (status) {
        filtros.push('p.status = ?');
        parametros.push(status);
      }

      if (fornecedorId) {
        filtros.push('p.fornecedor_id = ?');
        parametros.push(fornecedorId);
      }

      if (clienteId) {
        filtros.push('p.cliente_id = ?');
        parametros.push(clienteId);
      }

      if (busca) {
        filtros.push(`(
          p.protocolo LIKE ?
          OR p.placa LIKE ?
          OR p.chassi LIKE ?
          OR c.nome LIKE ?
          OR s.nome LIKE ?
        )`);

        const termo = `%${busca}%`;

        parametros.push(
          termo,
          termo,
          termo,
          termo,
          termo
        );
      }

      const where = filtros.length
        ? `WHERE ${filtros.join(' AND ')}`
        : '';

      const [contagem] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM pedidos_senha p
         INNER JOIN clientes c
           ON c.id = p.cliente_id
         INNER JOIN servicos s
           ON s.id = p.servico_id
         ${where}`,
        parametros
      );

      const [dados] = await pool.query(
        `SELECT
           p.id,
           p.protocolo,
           p.status,
           p.placa,
           p.chassi,
           p.marca,
           p.modelo,
           p.ano,
           p.valor_venda,
           p.custo,
           p.moeda,
           p.cliente_id,
           c.nome AS cliente,
           p.servico_id,
           s.codigo AS codigo_servico,
           s.nome AS servico,
           p.origem_id,
           os.codigo AS origem_codigo,
           os.nome AS origem,
           p.fornecedor_id,
           f.nome AS fornecedor,
           p.atendente_id,
           u.nome AS atendente,
           pr.id AS resultado_id,
           pr.status AS resultado_status,
           p.criado_em,
           p.atualizado_em,
           p.concluido_em
         FROM pedidos_senha p
         INNER JOIN clientes c
           ON c.id = p.cliente_id
         INNER JOIN servicos s
           ON s.id = p.servico_id
         LEFT JOIN origens_senha os
           ON os.id = p.origem_id
         LEFT JOIN fornecedores f
           ON f.id = p.fornecedor_id
         LEFT JOIN usuarios u
           ON u.id = p.atendente_id
         LEFT JOIN pedido_resultados pr
           ON pr.id = (
             SELECT MAX(pr2.id)
             FROM pedido_resultados pr2
             WHERE pr2.pedido_id = p.id
           )
         ${where}
         ORDER BY p.id DESC
         LIMIT ${limite}
         OFFSET ${offset}`,
        parametros
      );

      const total = Number(contagem[0].total || 0);

      return res.json({
        ok: true,
        total,
        pagina,
        limite,
        total_paginas: Math.ceil(total / limite),
        filtros: {
          status,
          fornecedor_id: fornecedorId,
          cliente_id: clienteId,
          busca
        },
        dados
      });

    } catch (error) {
      console.error('Erro ao listar fila de pedidos:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao listar fila de pedidos'
      });
    }
  });

  // ============================================================
  // LISTAR PEDIDOS
  // ============================================================

  app.get('/api/pedidos', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'visualizar'), async (req, res) => {

    try {

      const [dados] = await pool.query(
        `SELECT
            p.id,
            p.protocolo,
            p.status,
            p.placa,
            p.chassi,
            p.marca,
            p.modelo,
            p.ano,
            p.valor_venda,
            p.custo,
            p.moeda,
            p.cliente_id,
            c.nome AS cliente,
            p.servico_id,
            s.codigo AS codigo_servico,
            s.nome AS servico,
            p.fornecedor_id,
            f.nome AS fornecedor,
            p.criado_em,
            p.concluido_em
         FROM pedidos_senha p
         INNER JOIN clientes c
           ON c.id = p.cliente_id
         INNER JOIN servicos s
           ON s.id = p.servico_id
         LEFT JOIN fornecedores f
           ON f.id = p.fornecedor_id
         ORDER BY p.id DESC
         LIMIT 100`
      );

      return res.json({
        ok: true,
        total: dados.length,
        dados
      });

    } catch (error) {

      console.error('Erro ao listar pedidos:', error);

      return res.status(500).json({
        ok: false,
        error: 'Erro ao listar pedidos'
      });

    }

  });

};
