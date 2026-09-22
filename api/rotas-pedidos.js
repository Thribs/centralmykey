const {
  buscarSenhaNoBanco,
  normalizarChassi
} = require('./consulta-banco-senhas');
const {
  buscarSenhaFonteVerdade
} = require('./consulta-api-joelpires');
const processarPedidoPago = require('./processar-pedido-pago');
const {
  agendarConsultaFornecedor,
  reagendarConsultaFornecedor
} = require('./agendar-consulta-fornecedor');
const {
  agendarEntregaCliente,
  reagendarEntregaCliente
} = require('./agendar-entrega-cliente');
const { cancelarPedido } = require('./cancelar-pedido');
const {
  registrarResultadoFornecedor
} = require('./resultado-fornecedor');
const {
  prepararPartes,
  registrarPartesPedido,
  listarPartesPedido
} = require('./identidades-pedido');
const {
  calcularPeriodoFaturamentoSemanal
} = require('./periodo-faturamento-semanal');
const { servicoImplementado } = require('./servicos-implementados');

module.exports = function (app, pool) {
  const autenticarToken = app.locals.autenticarToken;
  const exigirPermissao = app.locals.exigirPermissao;

  function objetoResultado(valor) {
    if (valor && typeof valor === 'object') return valor;
    if (typeof valor !== 'string' || !valor.trim()) return {};
    try {
      const convertido = JSON.parse(valor);
      return convertido && typeof convertido === 'object' ? convertido : {};
    } catch {
      return {};
    }
  }

  async function auditarOperacaoPedido(connection, {
    usuarioId,
    acao,
    entidade = 'pedidos_senha',
    entidadeId,
    descricao,
    antes = null,
    depois = null,
    ip = null
  }) {
    await connection.query(
      `INSERT INTO auditoria
         (usuario_id, modulo, acao, entidade, entidade_id,
          descricao, dados_antes, dados_depois, ip)
       VALUES (?, 'PEDIDOS_SENHAS', ?, ?, ?, ?, ?, ?, ?)`,
      [
        usuarioId,
        acao,
        entidade,
        String(entidadeId),
        descricao,
        antes === null ? null : JSON.stringify(antes),
        depois === null ? null : JSON.stringify(depois),
        ip
      ]
    );
  }

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
        atendente_id,
        comprador,
        pagador
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

      if (!servicoImplementado(servico.codigo)) {
        await connection.rollback();
        return res.status(409).json({
          ok: false,
          codigo: 'SERVICO_NAO_SUPORTADO',
          error: 'Este serviço ainda não possui fluxo operacional implementado'
        });
      }

      // --------------------------------------------------------
      // 2. Validar dados exigidos pelo serviço
      // --------------------------------------------------------

      const placaInformada = String(placa || '').trim().toUpperCase();
      let chassiNormalizado = null;
      try {
        chassiNormalizado = normalizarChassi(chassi);
      } catch (erro) {
        await connection.rollback();
        return res.status(400).json({ ok: false, error: erro.message });
      }

      if (servico.exige_placa && !placaInformada) {
        await connection.rollback();

        return res.status(400).json({
          ok: false,
          error: 'Placa obrigatoria para consultar este servico'
        });
      }

      if (servico.exige_chassi && !chassiNormalizado) {
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
      credito_status,
      telefone,
      telefone_normalizado,
      cpf,
      cnpj,
      email,
      (SELECT ct.telefone_normalizado
         FROM cliente_telefones ct
        WHERE ct.cliente_id = clientes.id
        ORDER BY ct.id LIMIT 1) AS telefone_alternativo
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
let partesPedido;
try {
  partesPedido = prepararPartes(cliente, comprador, pagador);
} catch (erro) {
  await connection.rollback();
  return res.status(400).json({
    ok: false,
    codigo: erro.codigo,
    error: erro.message
  });
}

const parteComprador = partesPedido.find(parte => parte.papel === 'COMPRADOR');
if (servico.exige_documento && !parteComprador?.documento) {
  await connection.rollback();
  return res.status(400).json({
    ok: false,
    codigo: 'DOCUMENTO_OBRIGATORIO',
    error: 'Documento do comprador obrigatório para este serviço'
  });
}

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
      null,
      chassiNormalizado,
      marca || servico.marca || null,
      modelo || null,
      ano || null,
      Number(servico.preco_base || 0),
      req.usuario.id
    ]
  );

  await registrarPartesPedido(
    connection,
    pedidoAguardando.insertId,
    partesPedido
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

  await auditarOperacaoPedido(connection, {
    usuarioId: req.usuario.id,
    acao: 'CRIAR',
    entidadeId: pedidoAguardando.insertId,
    descricao: `Pedido ${protocoloPagamento} criado`,
    depois: {
      status: 'AGUARDANDO_PAGAMENTO',
      servico_id: Number(servico_id),
      tipo_cobranca: cliente.tipo_cobranca,
      valor: Number(servico.preco_base || 0),
      moeda: servico.moeda || 'BRL'
    },
    ip: req.ip || null
  });

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
let fornecedorSelecionado = null;
let custo = 0;
let origemId = null;
let bancoSenhaId = null;
let origemNome = null;

// --------------------------------------------------------
// 3.1 Consultar cache/API Joel Pires (fonte de verdade)
// --------------------------------------------------------

const consultaBanco = await buscarSenhaFonteVerdade(connection, {
  chassi: chassiNormalizado,
  codigoServico: servico.codigo,
  marca: marca || servico.marca,
  modelo,
  ano
});
const bancoProprio = consultaBanco.status === 'ENCONTRADO'
  ? [consultaBanco.senha]
  : [];
const conflitoBanco = consultaBanco.status === 'CONFLITO';
const apiIndisponivel = consultaBanco.status === 'INDISPONIVEL';
const dadosInvalidos = consultaBanco.status === 'DADOS_INVALIDOS';
const montadoraNaoConfigurada =
  consultaBanco.status === 'MONTADORA_NAO_CONFIGURADA';
const statusPedidoCriado = bancoProprio.length
  ? 'CONCLUIDO'
  : conflitoBanco || dadosInvalidos
    ? 'AGUARDANDO_DADOS'
    : apiIndisponivel || montadoraNaoConfigurada
      ? 'ABERTO'
      : null;

// --------------------------------------------------------
// 3.2 Se encontrou no banco próprio, custo é zero
// --------------------------------------------------------

if (bancoProprio.length) {

  bancoSenhaId = bancoProprio[0].id;
  const [origensBanco] = await connection.query(
    `SELECT id FROM origens_senha
     WHERE codigo = 'API' AND ativo = 1 LIMIT 1`
  );
  if (!origensBanco.length) {
    throw new Error('Origem API nao configurada');
  }
  origemId = origensBanco[0].id;
  origemNome = consultaBanco.origem;
  custo = 0;

} else if (consultaBanco.status === 'NAO_ENCONTRADO') {

  // ------------------------------------------------------
  // 3.3 Não encontrou na base própria:
  // buscar fornecedor ativo, disponível e de menor custo
  // ------------------------------------------------------

  const [fornecedores] = await connection.query(
    `SELECT
        fs.fornecedor_id,
        fs.custo,
        f.nome AS fornecedor,
        f.whatsapp,
        f.telefone,
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
    fornecedorSelecionado = fornecedores[0];
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
          null,
          chassiNormalizado,
          marca || servico.marca || null,
          modelo || null,
          ano || null,
          statusPedidoCriado || (fornecedorId ? 'EM_CONSULTA' : 'ABERTO'),
          Number(servico.preco_base || 0),
          custo,
          fornecedorId,
          origemId,
          req.usuario.id
        ]
      );

      await registrarPartesPedido(
        connection,
        resultado.insertId,
        partesPedido
      );
    // --------------------------------------------------------
    // 6. Registrar resultado automático da BASE PRÓPRIA
    // --------------------------------------------------------

    
      // --------------------------------------------------------
      // Vincular pedido do cliente pos-pago a fatura semanal
      // --------------------------------------------------------

      const [[relogioBanco]] = await connection.query(
        "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoje"
      );
      const periodoFatura = calcularPeriodoFaturamentoSemanal(
        relogioBanco.hoje,
        cliente.dia_fechamento ?? 0,
        cliente.prazo_pagamento_dias ?? 3
      );

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
           ?,
           ?,
           ?,
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
          periodoFatura.inicio,
          periodoFatura.fim,
          periodoFatura.vencimento,
          servico.moeda || 'BRL',
          Number(servico.preco_base || 0)
        ]
      );

      const [[faturaAtual]] = await connection.query(
        `SELECT status
           FROM faturas_clientes
          WHERE id = ?
          LIMIT 1
          FOR UPDATE`,
        [fatura.insertId]
      );
      if (!faturaAtual || faturaAtual.status !== 'ABERTA') {
        await connection.rollback();
        return res.status(409).json({
          ok: false,
          codigo: 'FATURA_PERIODO_FECHADO',
          error: 'A fatura deste período já foi fechada'
        });
      }

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
            periodo_inicio: periodoFatura.inicio,
            periodo_fim: periodoFatura.fim,
            dia_fechamento: periodoFatura.diaFechamento,
            prazo_pagamento_dias:
              periodoFatura.prazoPagamentoDias,
            valor: Number(servico.preco_base || 0),
            moeda: servico.moeda || 'BRL'
          })
        ]
      );

      const envioFornecedor = fornecedorSelecionado
        ? await agendarConsultaFornecedor(connection, {
            pedido: {
              id: resultado.insertId,
              protocolo,
              chassi: chassiNormalizado,
              marca: marca || servico.marca || null,
              modelo: modelo || null,
              ano: ano || null
            },
            fornecedor: fornecedorSelecionado,
            usuarioId: req.usuario.id
          })
        : null;
      let entregaCliente = null;

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

      const [registroResultado] = await connection.query(
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
          origemId,
          null,
          senhaEncontrada.codigo_mecanico,
          senhaEncontrada.codigo_imobilizador,
          senhaEncontrada.codigo_radio,
          senhaEncontrada.pin,
          JSON.stringify({
            origem_atendimento: consultaBanco.origem,
            origem_historica_id: senhaEncontrada.origem_id,
            fornecedor_historico_id: senhaEncontrada.fornecedor_id,
            codigo_alarme: senhaEncontrada.codigo_alarme,
            confiabilidade: senhaEncontrada.confiabilidade
          }),
          0,
          'CONFIRMADO'
        ]
      );
      entregaCliente = await agendarEntregaCliente(connection, {
        pedido: { id: resultado.insertId, protocolo },
        cliente: {
          telefone_normalizado:
            cliente.telefone_normalizado || cliente.telefone_alternativo,
          telefone: cliente.telefone
        },
        resultado: {
          id: registroResultado.insertId,
          codigo_mecanico: senhaEncontrada.codigo_mecanico,
          codigo_imobilizador: senhaEncontrada.codigo_imobilizador,
          codigo_radio: senhaEncontrada.codigo_radio,
          pin: senhaEncontrada.pin,
          resultado: { codigo_alarme: senhaEncontrada.codigo_alarme }
        },
        usuarioId: req.usuario.id
      });
    }
    if (conflitoBanco) {
      await connection.query(
        `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
         VALUES (?, ?, 'CONFLITO_BASE_DADOS', ?, ?)`,
        [resultado.insertId, req.usuario.id,
          'Senhas divergentes para o mesmo produto e final de chassi',
          JSON.stringify(consultaBanco)]
      );
    }
    if (dadosInvalidos) {
      await connection.query(
        `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
         VALUES (?, ?, 'DADOS_INVALIDOS_API_JOELPIRES', ?, ?)`,
        [resultado.insertId, req.usuario.id,
          'Dados rejeitados pela API Joel Pires; fornecedor externo nao acionado',
          JSON.stringify(consultaBanco)]
      );
    }
    if (apiIndisponivel) {
      await connection.query(
        `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
         VALUES (?, ?, 'API_JOELPIRES_INDISPONIVEL', ?, ?)`,
        [resultado.insertId, req.usuario.id,
          'API Joel Pires indisponivel; fornecedor externo nao acionado',
          JSON.stringify(consultaBanco)]
      );
    }
    if (montadoraNaoConfigurada) {
      await connection.query(
        `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
         VALUES (?, ?, 'MONTADORA_API_NAO_CONFIGURADA', ?, ?)`,
        [resultado.insertId, req.usuario.id,
          'Montadora sem correspondencia configurada na API Joel Pires',
          JSON.stringify({ marca: marca || servico.marca || null })]
      );
    }
      const statusFinalPedido = statusPedidoCriado ||
        (fornecedorId ? 'EM_CONSULTA' : 'ABERTO');
      await auditarOperacaoPedido(connection, {
        usuarioId: req.usuario.id,
        acao: 'CRIAR',
        entidadeId: resultado.insertId,
        descricao: `Pedido ${protocolo} criado`,
        depois: {
          status: statusFinalPedido,
          servico_id: Number(servico_id),
          tipo_cobranca: cliente.tipo_cobranca,
          valor: Number(servico.preco_base || 0),
          moeda: servico.moeda || 'BRL',
          fornecedor_atribuido: Boolean(fornecedorId),
          resultado_automatico: Boolean(bancoProprio.length)
        },
        ip: req.ip || null
      });
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
          envio_fornecedor: envioFornecedor,
          entrega_cliente: entregaCliente,
          valor_venda: Number(servico.preco_base || 0),
          status: statusFinalPedido,
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
  // CORRIGIR DADOS REJEITADOS E REPROCESSAR PEDIDO GM
  // ============================================================

  app.post(
    '/api/pedidos/:id/corrigir-dados',
    autenticarToken,
    exigirPermissao('PEDIDOS_SENHAS', 'editar'),
    async (req, res) => {
      const pedidoId = Number(req.params.id);
      if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
        return res.status(400).json({ ok: false, error: 'ID do pedido inválido' });
      }
      let chassi;
      try {
        chassi = normalizarChassi(req.body?.chassi);
      } catch (error) {
        return res.status(400).json({ ok: false, error: error.message });
      }
      const marca = String(req.body?.marca || '').trim().toUpperCase();
      const modelo = String(req.body?.modelo || '').trim().toUpperCase();
      const ano = Number(req.body?.ano);
      const anoMaximo = new Date().getFullYear() + 2;
      if (!chassi || !marca || !modelo || !Number.isInteger(ano) ||
          ano < 1900 || ano > anoMaximo) {
        return res.status(400).json({
          ok: false,
          error: `Informe chassi, marca, modelo e ano entre 1900 e ${anoMaximo}`
        });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[pedido]] = await connection.query(
          `SELECT p.id, p.protocolo, p.status, p.chassi, p.marca, p.modelo,
                  p.ano, s.codigo AS codigo_servico
             FROM pedidos_senha p
             INNER JOIN servicos s ON s.id = p.servico_id
            WHERE p.id = ?
            LIMIT 1
            FOR UPDATE`,
          [pedidoId]
        );
        if (!pedido) {
          await connection.rollback();
          return res.status(404).json({ ok: false, error: 'Pedido não encontrado' });
        }
        if (pedido.codigo_servico !== 'GM_SENHA') {
          await connection.rollback();
          return res.status(409).json({
            ok: false,
            codigo: 'SERVICO_NAO_SUPORTADO',
            error: 'A correção automática está disponível somente para senha GM'
          });
        }
        if (pedido.status !== 'AGUARDANDO_DADOS') {
          await connection.rollback();
          return res.status(409).json({
            ok: false,
            codigo: 'PEDIDO_NAO_AGUARDA_DADOS',
            error: `Pedido no status ${pedido.status} não aceita correção de dados`
          });
        }
        const antes = {
          chassi: pedido.chassi,
          marca: pedido.marca,
          modelo: pedido.modelo,
          ano: pedido.ano
        };
        const depois = { chassi, marca, modelo, ano };
        await connection.query(
          `UPDATE pedidos_senha
              SET chassi = ?, marca = ?, modelo = ?, ano = ?,
                  fornecedor_id = NULL, origem_id = NULL, custo = 0
            WHERE id = ?`,
          [chassi, marca, modelo, ano, pedido.id]
        );
        await connection.query(
          `INSERT INTO pedido_historico
             (pedido_id, usuario_id, tipo, descricao, dados)
           VALUES (?, ?, 'DADOS_PEDIDO_CORRIGIDOS', ?, ?)`,
          [
            pedido.id,
            req.usuario.id,
            'Dados do veículo corrigidos para nova consulta',
            JSON.stringify({ antes, depois })
          ]
        );
        await connection.query(
          `INSERT INTO auditoria
             (usuario_id, modulo, acao, entidade, entidade_id,
              descricao, dados_antes, dados_depois, ip)
           VALUES (?, 'PEDIDOS_SENHAS', 'CORRIGIR_DADOS',
                   'pedidos_senha', ?, ?, ?, ?, ?)`,
          [
            req.usuario.id,
            String(pedido.id),
            `Dados do pedido ${pedido.protocolo} corrigidos`,
            JSON.stringify(antes),
            JSON.stringify(depois),
            req.ip || null
          ]
        );
        const processamento = await processarPedidoPago(
          connection,
          pedido.id,
          req.usuario.id
        );
        await connection.commit();
        return res.json({
          ok: true,
          mensagem: 'Dados corrigidos e pedido reprocessado',
          pedido_id: pedido.id,
          dados: depois,
          processamento
        });
      } catch (error) {
        await connection.rollback();
        console.error('Erro ao corrigir dados do pedido GM:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao corrigir e reprocessar o pedido GM'
        });
      } finally {
        connection.release();
      }
    }
  );

  app.post('/api/pedidos/:id/reprocessar', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'editar'), async (req, res) => {
    const pedidoId = Number(req.params.id);

    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({ ok: false, error: 'ID do pedido inválido' });
    }

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [pedidos] = await connection.query(
        `SELECT p.id, p.protocolo, p.status, s.codigo AS codigo_servico
           FROM pedidos_senha p
           INNER JOIN servicos s ON s.id = p.servico_id
          WHERE p.id = ? LIMIT 1 FOR UPDATE`,
        [pedidoId]
      );

      if (!pedidos.length) {
        await connection.rollback();
        return res.status(404).json({ ok: false, error: 'Pedido não encontrado' });
      }

      const pedido = pedidos[0];
      if (pedido.codigo_servico !== 'GM_SENHA') {
        await connection.rollback();
        return res.status(409).json({
          ok: false,
          error: 'O reprocessamento automático está liberado somente para senha GM'
        });
      }

      if (!['ABERTO', 'ERRO', 'AGUARDANDO_DADOS'].includes(pedido.status)) {
        await connection.rollback();
        return res.status(409).json({
          ok: false,
          error: `Pedido no status ${pedido.status} não pode ser reprocessado`
        });
      }

      const processamento = await processarPedidoPago(
        connection,
        pedidoId,
        req.usuario.id
      );

      await connection.query(
        `INSERT INTO auditoria
           (usuario_id, modulo, acao, entidade, entidade_id,
            descricao, dados_antes, dados_depois, ip)
         VALUES (?, 'PEDIDOS_SENHAS', 'REPROCESSAR', 'pedidos_senha',
                 ?, ?, ?, ?, ?)`,
        [
          req.usuario.id,
          String(pedido.id),
          `Pedido ${pedido.protocolo} reprocessado manualmente`,
          JSON.stringify({ status: pedido.status }),
          JSON.stringify({
            status: processamento.status || null,
            origem: processamento.origem || null
          }),
          req.ip || null
        ]
      );

      await connection.commit();
      return res.json({
        ok: true,
        message: 'Pedido GM reprocessado',
        processamento
      });
    } catch (error) {
      await connection.rollback();
      console.error('Erro ao reprocessar pedido GM:', error);
      return res.status(500).json({
        ok: false,
        error: 'Erro ao reprocessar pedido GM'
      });
    } finally {
      connection.release();
    }
  });

  app.post(
    '/api/pedidos/:id/comunicacoes/:comunicacaoId/reprocessar',
    autenticarToken,
    exigirPermissao('PEDIDOS_SENHAS', 'editar'),
    async (req, res) => {
      const pedidoId = Number(req.params.id);
      const comunicacaoId = Number(req.params.comunicacaoId);

      if (
        !Number.isInteger(pedidoId) || pedidoId <= 0 ||
        !Number.isInteger(comunicacaoId) || comunicacaoId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Pedido ou comunicação inválida'
        });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[registroComunicacao]] = await connection.query(
          `SELECT co.finalidade, co.status, p.protocolo
             FROM comunicacoes_outbox co
             INNER JOIN pedidos_senha p ON p.id = co.pedido_id
            WHERE co.id = ? AND co.pedido_id = ?
            LIMIT 1`,
          [comunicacaoId, pedidoId]
        );
        if (!registroComunicacao) {
          const erro = new Error('Comunicação não encontrada');
          erro.codigo = 'COMUNICACAO_NAO_ENCONTRADA';
          throw erro;
        }
        const reagendar = registroComunicacao.finalidade === 'ENTREGA_CLIENTE'
          ? reagendarEntregaCliente
          : reagendarConsultaFornecedor;
        const comunicacao = await reagendar(connection, {
          pedidoId,
          comunicacaoId,
          usuarioId: req.usuario.id,
          confirmarIncerto: req.body?.confirmar_nao_enviado === true
        });
        await connection.query(
          `INSERT INTO auditoria
             (usuario_id, modulo, acao, entidade, entidade_id,
              descricao, dados_antes, dados_depois, ip)
           VALUES (?, 'PEDIDOS_SENHAS', 'REAGENDAR_COMUNICACAO',
                   'comunicacoes_outbox', ?, ?, ?, ?, ?)`,
          [
            req.usuario.id,
            String(comunicacaoId),
            `Comunicação do pedido ${registroComunicacao.protocolo} reagendada`,
            JSON.stringify({
              pedido_id: pedidoId,
              finalidade: registroComunicacao.finalidade,
              status: registroComunicacao.status
            }),
            JSON.stringify({
              pedido_id: pedidoId,
              finalidade: registroComunicacao.finalidade,
              status: comunicacao.status
            }),
            req.ip || null
          ]
        );
        await connection.commit();
        return res.json({
          ok: true,
          mensagem: 'Comunicação reagendada',
          comunicacao
        });
      } catch (error) {
        await connection.rollback();

        if (error.codigo === 'COMUNICACAO_NAO_ENCONTRADA') {
          return res.status(404).json({ ok: false, error: error.message });
        }

        if (
          error.codigo === 'ENVIO_INCERTO_EXIGE_CONFIRMACAO' ||
          error.codigo === 'COMUNICACAO_NAO_REPROCESSAVEL' ||
          error.codigo === 'FORNECEDOR_SEM_WHATSAPP' ||
          error.codigo === 'CLIENTE_SEM_WHATSAPP'
        ) {
          return res.status(409).json({
            ok: false,
            codigo: error.codigo,
            error: error.message
          });
        }

        console.error('Erro ao reagendar envio ao fornecedor:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao reagendar envio ao fornecedor'
        });
      } finally {
        connection.release();
      }
    }
  );

  app.post(
    '/api/pedidos/:id/cancelar',
    autenticarToken,
    exigirPermissao('PEDIDOS_SENHAS', 'editar'),
    async (req, res) => {
      const pedidoId = Number(req.params.id);
      if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
        return res.status(400).json({ ok: false, error: 'Pedido inválido' });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const cancelamento = await cancelarPedido(connection, {
          pedidoId,
          usuarioId: req.usuario.id,
          motivo: req.body?.motivo,
          ip: req.ip || null
        });
        await connection.commit();
        return res.json({
          ok: true,
          mensagem: cancelamento.idempotente
            ? 'Pedido já estava cancelado'
            : 'Pedido cancelado',
          cancelamento
        });
      } catch (error) {
        await connection.rollback();
        if (error.codigo === 'PEDIDO_NAO_ENCONTRADO') {
          return res.status(404).json({
            ok: false,
            codigo: error.codigo,
            error: error.message
          });
        }
        const conflitos = new Set([
          'PEDIDO_JA_CONCLUIDO',
          'ESTORNO_FINANCEIRO_NECESSARIO',
          'CUSTO_FORNECEDOR_REQUER_DECISAO',
          'FATURA_REQUER_AJUSTE'
        ]);
        if (error.codigo === 'MOTIVO_CANCELAMENTO_INVALIDO') {
          return res.status(400).json({
            ok: false,
            codigo: error.codigo,
            error: error.message
          });
        }
        if (conflitos.has(error.codigo)) {
          return res.status(409).json({
            ok: false,
            codigo: error.codigo,
            error: error.message
          });
        }
        console.error('Erro ao cancelar pedido:', error);
        return res.status(500).json({
          ok: false,
          error: 'Erro ao cancelar pedido'
        });
      } finally {
        connection.release();
      }
    }
  );

  app.post('/api/pedidos/:id/resultado', autenticarToken, exigirPermissao('PEDIDOS_SENHAS', 'editar'), async (req, res) => {
    const pedidoId = Number(req.params.id);

    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'ID do pedido inválido'
      });
    }

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();
      const registrado = await registrarResultadoFornecedor(connection, {
        pedidoId,
        dados: req.body || {},
        usuarioId: req.usuario.id
      });

      if (!registrado.idempotente) {
        await auditarOperacaoPedido(connection, {
          usuarioId: req.usuario.id,
          acao: 'REGISTRAR_RESULTADO',
          entidadeId: registrado.pedido.id,
          descricao:
            `Resultado do pedido ${registrado.pedido.protocolo} registrado`,
          antes: { status: 'EM_CONSULTA' },
          depois: {
            status: registrado.pedido.status,
            resultado_id: registrado.resultado.id,
            fornecedor_id: registrado.pedido.fornecedor_id
          },
          ip: req.ip || null
        });
      }

      await connection.commit();

      return res.status(registrado.idempotente ? 200 : 201).json({
        ok: true,
        idempotente: registrado.idempotente,
        message: registrado.idempotente
          ? 'Este resultado já havia sido registrado'
          : 'Resultado registrado e pedido concluído',
        pedido: registrado.pedido,
        resultado: registrado.resultado
      });

    } catch (error) {
      await connection.rollback();

      if (error.statusHttp) {
        return res.status(error.statusHttp).json({
          ok: false,
          codigo: error.codigo,
          error: error.message
        });
      }

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
    const usuarioId = req.usuario.id;

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
           p.chassi,
           p.marca,
           p.modelo,
           p.ano,
           p.fornecedor_id,
           c.telefone,
           c.telefone_normalizado,
           (SELECT ct.telefone_normalizado
              FROM cliente_telefones ct
             WHERE ct.cliente_id = c.id
             ORDER BY ct.id LIMIT 1) AS telefone_alternativo,
           s.codigo AS tipo
         FROM pedidos_senha p
         INNER JOIN servicos s
           ON s.id = p.servico_id
         INNER JOIN clientes c
           ON c.id = p.cliente_id
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
      const dadosResultado = objetoResultado(resultadoEncontrado.resultado);

      await connection.query(
        `UPDATE pedido_resultados
         SET status = 'CONFIRMADO'
         WHERE id = ?`,
        [resultadoEncontrado.id]
      );

      let bancoSenhaId = null;
      let acaoBase = 'NAO_ADICIONADO_SEM_CHASSI';

      if (pedido.chassi) {
        const chassiNormalizado = normalizarChassi(pedido.chassi);
        const consultaExistente = await buscarSenhaNoBanco(connection, {
          chassi: chassiNormalizado,
          codigoServico: pedido.tipo
        });

        if (consultaExistente.status === 'CONFLITO') {
          await connection.rollback();
          return res.status(409).json({
            ok: false,
            error: 'Existem senhas divergentes para este produto e chassi',
            conflito: consultaExistente
          });
        }

        const existentes = consultaExistente.status === 'ENCONTRADO'
          ? [consultaExistente.senha]
          : [];

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
                 codigo_mecanico = COALESCE(?, codigo_mecanico),
                 codigo_imobilizador = COALESCE(?, codigo_imobilizador),
                 codigo_radio = COALESCE(?, codigo_radio),
                 codigo_alarme = COALESCE(?, codigo_alarme),
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
              resultadoEncontrado.codigo_mecanico,
              resultadoEncontrado.codigo_imobilizador,
              resultadoEncontrado.codigo_radio,
              dadosResultado.codigo_alarme || null,
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
              chassi,
              codigo_mecanico,
              codigo_imobilizador,
              codigo_radio,
              codigo_alarme,
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
              chassiNormalizado,
              resultadoEncontrado.codigo_mecanico,
              resultadoEncontrado.codigo_imobilizador,
              resultadoEncontrado.codigo_radio,
              dadosResultado.codigo_alarme || null,
              resultadoEncontrado.pin,
              JSON.stringify({
                pedido_id: pedido.id,
                resultado_id: resultadoEncontrado.id,
                origem_original: 'FORNECEDOR'
              }),
              resultadoEncontrado.origem_id || 2,
              pedido.fornecedor_id,
              'CONFIRMADA',
              1,
              1
            ]
          );

          bancoSenhaId = novoBanco.insertId;
        }
      }

      const entrega = await agendarEntregaCliente(connection, {
        pedido,
        cliente: {
          telefone_normalizado:
            pedido.telefone_normalizado || pedido.telefone_alternativo,
          telefone: pedido.telefone
        },
        resultado: {
          id: resultadoEncontrado.id,
          codigo_mecanico: resultadoEncontrado.codigo_mecanico,
          codigo_imobilizador: resultadoEncontrado.codigo_imobilizador,
          codigo_radio: resultadoEncontrado.codigo_radio,
          pin: resultadoEncontrado.pin,
          resultado: dadosResultado
        },
        usuarioId
      });

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
            acao_base: acaoBase,
            entrega_id: entrega.id,
            entrega_status: entrega.status
          })
        ]
      );

      await auditarOperacaoPedido(connection, {
        usuarioId,
        acao: 'CONFIRMAR_RESULTADO',
        entidadeId: pedido.id,
        descricao: `Resultado do pedido ${pedido.protocolo} confirmado`,
        antes: {
          resultado_id: resultadoEncontrado.id,
          status_resultado: 'ENCONTRADO'
        },
        depois: {
          resultado_id: resultadoEncontrado.id,
          status_resultado: 'CONFIRMADO',
          acao_base: acaoBase,
          entrega_status: entrega.status
        },
        ip: req.ip || null
      });

      await connection.commit();

      return res.json({
        ok: true,
        message: 'Resultado confirmado com sucesso',
        pedido_id: pedido.id,
        resultado_id: resultadoEncontrado.id,
        banco_senha_id: bancoSenhaId,
        acao_base: acaoBase,
        entrega
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
    const usuarioId = req.usuario.id;
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
           p.chassi,
           p.marca,
           p.modelo,
           p.ano,
           p.fornecedor_id,
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
           f.nome AS fornecedor,
           f.whatsapp,
           f.telefone
         FROM fornecedor_servicos fs
         INNER JOIN fornecedores f
           ON f.id = fs.fornecedor_id
         WHERE fs.codigo_servico = ?
           AND fs.ativo = 1
           AND f.ativo = 1
           AND (? IS NULL OR fs.fornecedor_id <> ?)
           AND (
             f.horario_inicio IS NULL
             OR f.horario_fim IS NULL
             OR CURTIME() BETWEEN f.horario_inicio AND f.horario_fim
           )
         ORDER BY fs.custo ASC
         LIMIT 1`,
        [pedido.codigo_servico, pedido.fornecedor_id, pedido.fornecedor_id]
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

      const comunicacao = fornecedor
        ? await agendarConsultaFornecedor(connection, {
            pedido,
            fornecedor,
            usuarioId
          })
        : null;

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
              : null,
            comunicacao_id: comunicacao?.id || null,
            envio_status: comunicacao?.status || null
          })
        ]
      );

      await auditarOperacaoPedido(connection, {
        usuarioId,
        acao: 'REJEITAR_RESULTADO',
        entidadeId: pedido.id,
        descricao: `Resultado do pedido ${pedido.protocolo} rejeitado`,
        antes: {
          status: pedido.status,
          resultado_id: resultadoIncorreto.id
        },
        depois: {
          status: statusNovo,
          resultado_id: resultadoIncorreto.id,
          banco_bloqueado: bancoBloqueado,
          fornecedor_id: fornecedor?.fornecedor_id || null,
          comunicacao_status: comunicacao?.status || null
        },
        ip: req.ip || null
      });

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
              custo: Number(fornecedor.custo),
              envio: comunicacao
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

      const [comunicacoes] = await pool.query(
        `SELECT
           id,
           canal,
           finalidade,
           resultado_id,
           fornecedor_id,
           status,
           tentativas,
           mensagem_externa_id,
           erro_codigo,
           erro_detalhe,
           enviado_em,
           entregue_em,
           lida_em,
           criado_em,
           atualizado_em
         FROM comunicacoes_outbox
         WHERE pedido_id = ?
         ORDER BY id DESC`,
        [pedidoId]
      );

      const partes = await listarPartesPedido(
        pool,
        pedidoId,
        {
          cliente_id: pedidos[0].cliente_id,
          nome: pedidos[0].cliente
        }
      );

      return res.json({
        ok: true,
        pedido: pedidos[0],
        resultados,
        historico,
        comunicacoes,
        partes
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
           SUM(
             p.status = 'ABERTO'
             AND p.fornecedor_id IS NULL
             AND p.origem_id IS NULL
             AND s.codigo = 'GM_SENHA'
             AND (
               SELECT h.tipo
                 FROM pedido_historico h
                WHERE h.pedido_id = p.id
                ORDER BY h.id DESC
                LIMIT 1
             ) IN ('API_JOELPIRES_INDISPONIVEL',
                   'FORNECEDOR_GM_INDISPONIVEL')
           ) AS aguardando_reprocessamento_gm,
           SUM(p.origem_id = 1) AS atendidos_base_propria,
           SUM(p.origem_id = 2) AS atribuidos_fornecedor,
           SUM(COALESCE(com.enviada_fornecedor, 0)) AS enviados_fornecedor,
           SUM(COALESCE(com.pendente_fornecedor, 0)) AS aguardando_envio_fornecedor,
           SUM(COALESCE(com.falha_fornecedor, 0)) AS falhas_envio_fornecedor,
           SUM(COALESCE(com.pendente_cliente, 0)) AS aguardando_entrega_cliente,
           SUM(COALESCE(com.falha_cliente, 0)) AS falhas_entrega_cliente
         FROM pedidos_senha p
         INNER JOIN servicos s ON s.id = p.servico_id
         LEFT JOIN (
           SELECT
             pedido_id,
             MAX(finalidade = 'CONSULTA_FORNECEDOR' AND status = 'ENVIADA')
               AS enviada_fornecedor,
             MAX(finalidade = 'CONSULTA_FORNECEDOR' AND status = 'PENDENTE')
               AS pendente_fornecedor,
             MAX(finalidade = 'CONSULTA_FORNECEDOR'
                 AND status IN ('FALHOU', 'INCERTA')) AS falha_fornecedor,
             MAX(finalidade = 'ENTREGA_CLIENTE' AND status = 'PENDENTE')
               AS pendente_cliente,
             MAX(finalidade = 'ENTREGA_CLIENTE'
                 AND status IN ('FALHOU', 'INCERTA')) AS falha_cliente
           FROM comunicacoes_outbox
           GROUP BY pedido_id
         ) com ON com.pedido_id = p.id
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
          aguardando_reprocessamento_gm: Number(
            resumo.aguardando_reprocessamento_gm || 0
          ),
          atendidos_base_propria: Number(
            resumo.atendidos_base_propria || 0
          ),
          atribuidos_fornecedor: Number(
            resumo.atribuidos_fornecedor || 0
          ),
          enviados_fornecedor: Number(
            resumo.enviados_fornecedor || 0
          ),
          aguardando_envio_fornecedor: Number(
            resumo.aguardando_envio_fornecedor || 0
          ),
          falhas_envio_fornecedor: Number(
            resumo.falhas_envio_fornecedor || 0
          ),
          aguardando_entrega_cliente: Number(
            resumo.aguardando_entrega_cliente || 0
          ),
          falhas_entrega_cliente: Number(
            resumo.falhas_entrega_cliente || 0
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
        'ERRO',
        'AGUARDANDO_REPROCESSAMENTO'
      ];

      if (status && !statusPermitidos.includes(status)) {
        return res.status(400).json({
          ok: false,
          error: 'Status inválido'
        });
      }

      const filtros = [];
      const parametros = [];

      if (status === 'AGUARDANDO_REPROCESSAMENTO') {
        filtros.push(`(
          p.status = 'ABERTO'
          AND p.fornecedor_id IS NULL
          AND p.origem_id IS NULL
          AND s.codigo = 'GM_SENHA'
          AND (
            SELECT h.tipo
              FROM pedido_historico h
             WHERE h.pedido_id = p.id
             ORDER BY h.id DESC
             LIMIT 1
          ) IN ('API_JOELPIRES_INDISPONIVEL',
                'FORNECEDOR_GM_INDISPONIVEL')
        )`);
      } else if (status) {
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
           com.comunicacao_fornecedor_status,
           com.comunicacao_fornecedor_erro,
           com.entrega_cliente_status,
           com.entrega_cliente_erro,
           CASE WHEN
             p.status = 'ABERTO'
             AND p.fornecedor_id IS NULL
             AND p.origem_id IS NULL
             AND s.codigo = 'GM_SENHA'
             AND (
               SELECT h.tipo
                 FROM pedido_historico h
                WHERE h.pedido_id = p.id
                ORDER BY h.id DESC
                LIMIT 1
             ) IN ('API_JOELPIRES_INDISPONIVEL',
                   'FORNECEDOR_GM_INDISPONIVEL')
           THEN 1 ELSE 0 END AS aguardando_reprocessamento_gm,
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
         LEFT JOIN (
           SELECT
             pedido_id,
             MAX(CASE WHEN finalidade = 'CONSULTA_FORNECEDOR'
               THEN status END) AS comunicacao_fornecedor_status,
             MAX(CASE WHEN finalidade = 'CONSULTA_FORNECEDOR'
               THEN erro_codigo END) AS comunicacao_fornecedor_erro,
             MAX(CASE WHEN finalidade = 'ENTREGA_CLIENTE'
               THEN status END) AS entrega_cliente_status,
             MAX(CASE WHEN finalidade = 'ENTREGA_CLIENTE'
               THEN erro_codigo END) AS entrega_cliente_erro
           FROM (
             SELECT
               pedido_id,
               finalidade,
               status,
               erro_codigo,
               ROW_NUMBER() OVER (
                 PARTITION BY pedido_id, finalidade ORDER BY id DESC
               ) AS ordem
             FROM comunicacoes_outbox
             WHERE finalidade IN ('CONSULTA_FORNECEDOR', 'ENTREGA_CLIENTE')
           ) comunicacoes_ordenadas
           WHERE ordem = 1
           GROUP BY pedido_id
         ) com ON com.pedido_id = p.id
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
