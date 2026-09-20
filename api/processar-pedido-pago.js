'use strict';

const { buscarSenhaFonteVerdade } = require('./consulta-api-joelpires');
const {
  agendarConsultaFornecedor
} = require('./agendar-consulta-fornecedor');
const { selecionarFornecedor } = require('./selecionar-fornecedor');
const {
  agendarEntregaCliente
} = require('./agendar-entrega-cliente');

async function registrarHistorico(connection, pedidoId, usuarioId, tipo, descricao, dados) {
  await connection.query(
    `INSERT INTO pedido_historico (pedido_id, usuario_id, tipo, descricao, dados)
     VALUES (?, ?, ?, ?, ?)`,
    [pedidoId, usuarioId, tipo, descricao, JSON.stringify(dados)]
  );
}

module.exports = async function processarPedidoPago(connection, pedidoId, usuarioId) {
  const [pedidos] = await connection.query(
    `SELECT p.id, p.protocolo, p.chassi, p.marca, p.modelo, p.ano, p.status,
            s.codigo AS codigo_servico, s.marca AS marca_servico,
            c.telefone, c.telefone_normalizado,
            (SELECT ct.telefone_normalizado
               FROM cliente_telefones ct
              WHERE ct.cliente_id = c.id
              ORDER BY ct.id LIMIT 1) AS telefone_alternativo
       FROM pedidos_senha p
       INNER JOIN servicos s ON s.id = p.servico_id
       INNER JOIN clientes c ON c.id = p.cliente_id
      WHERE p.id = ? LIMIT 1 FOR UPDATE`, [pedidoId]
  );
  if (!pedidos.length) throw new Error('Pedido pago nao encontrado');
  const pedido = pedidos[0];
  const consulta = await buscarSenhaFonteVerdade(connection, {
    chassi: pedido.chassi,
    codigoServico: pedido.codigo_servico,
    marca: pedido.marca || pedido.marca_servico,
    modelo: pedido.modelo,
    ano: pedido.ano
  });

  if (consulta.status === 'CONFLITO') {
    await connection.query(
      `UPDATE pedidos_senha SET status='AGUARDANDO_DADOS', custo=0,
       fornecedor_id=NULL, origem_id=NULL WHERE id=?`, [pedido.id]
    );
    await registrarHistorico(connection, pedido.id, usuarioId, 'CONFLITO_BASE_DADOS',
      'Senhas divergentes para o mesmo produto e final de chassi', consulta);
    return { status: 'AGUARDANDO_DADOS', origem: consulta.origem, conflito: true };
  }

  if (consulta.status === 'DADOS_INVALIDOS') {
    await connection.query(
      `UPDATE pedidos_senha SET status='AGUARDANDO_DADOS', custo=0,
       fornecedor_id=NULL, origem_id=NULL WHERE id=?`, [pedido.id]
    );
    await registrarHistorico(connection, pedido.id, usuarioId,
      'DADOS_INVALIDOS_API_JOELPIRES',
      'Dados rejeitados pela API Joel Pires; fornecedor externo nao acionado',
      consulta);
    return {
      status: 'AGUARDANDO_DADOS',
      origem: 'API_JOELPIRES',
      dados_invalidos: true,
      mensagem: consulta.mensagem
    };
  }

  if (consulta.status === 'ENCONTRADO') {
    const senha = consulta.senha;
    const [origens] = await connection.query(
      `SELECT id FROM origens_senha WHERE codigo='API' AND ativo=1 LIMIT 1`
    );
    if (!origens.length) throw new Error('Origem API nao configurada');
    const origemAtendimentoId = origens[0].id;
    await connection.query(
      `UPDATE banco_senhas SET quantidade_usos=quantidade_usos+1 WHERE id=?`, [senha.id]
    );
    await connection.query(
      `UPDATE pedidos_senha SET status='CONCLUIDO', custo=0, fornecedor_id=NULL,
       origem_id=?, concluido_em=NOW() WHERE id=?`, [origemAtendimentoId, pedido.id]
    );
    const [registroResultado] = await connection.query(
      `INSERT INTO pedido_resultados
       (pedido_id,banco_senha_id,origem_id,fornecedor_id,codigo_mecanico,
        codigo_imobilizador,codigo_radio,pin,resultado,custo,status)
       VALUES (?,?,?,NULL,?,?,?,?,?,0,'CONFIRMADO')`,
      [pedido.id, senha.id, origemAtendimentoId, senha.codigo_mecanico,
       senha.codigo_imobilizador, senha.codigo_radio, senha.pin,
       JSON.stringify({ origem_atendimento: consulta.origem,
         origem_historica_id: senha.origem_id,
         fornecedor_historico_id: senha.fornecedor_id,
         codigo_alarme: senha.codigo_alarme,
         confiabilidade: senha.confiabilidade, final8: consulta.final8 })]
    );
    const entrega = await agendarEntregaCliente(connection, {
      pedido,
      cliente: {
        telefone_normalizado:
          pedido.telefone_normalizado || pedido.telefone_alternativo,
        telefone: pedido.telefone
      },
      resultado: {
        id: registroResultado.insertId,
        codigo_mecanico: senha.codigo_mecanico,
        codigo_imobilizador: senha.codigo_imobilizador,
        codigo_radio: senha.codigo_radio,
        pin: senha.pin,
        resultado: { codigo_alarme: senha.codigo_alarme }
      },
      usuarioId
    });
    await registrarHistorico(connection, pedido.id, usuarioId, 'PROCESSADO_APOS_PAGAMENTO',
      'Senha localizada pela API Joel Pires apos pagamento',
      { status: 'CONCLUIDO', origem: consulta.origem, banco_senha_id: senha.id,
        contingencia: Boolean(consulta.contingencia),
        entrega_id: entrega.id, entrega_status: entrega.status });
    return { status: 'CONCLUIDO', origem: consulta.origem,
      resultado_automatico: true, contingencia: Boolean(consulta.contingencia),
      entrega };
  }

  if (consulta.status === 'INDISPONIVEL') {
    await connection.query(
      `UPDATE pedidos_senha SET status='ABERTO',custo=0,
       fornecedor_id=NULL,origem_id=NULL WHERE id=?`, [pedido.id]
    );
    await registrarHistorico(connection, pedido.id, usuarioId,
      'API_JOELPIRES_INDISPONIVEL',
      'API Joel Pires indisponivel; fornecedor externo nao acionado', consulta);
    return { status: 'ABERTO', origem: 'API_JOELPIRES',
      api_indisponivel: true, aguardando_reprocessamento: true };
  }

  if (consulta.status === 'MONTADORA_NAO_CONFIGURADA') {
    await connection.query(
      `UPDATE pedidos_senha SET status='ABERTO',custo=0,
       fornecedor_id=NULL,origem_id=NULL WHERE id=?`, [pedido.id]
    );
    await registrarHistorico(connection, pedido.id, usuarioId,
      'MONTADORA_API_NAO_CONFIGURADA',
      'Montadora sem correspondencia configurada na API Joel Pires',
      { marca: pedido.marca || pedido.marca_servico || null });
    return { status: 'ABERTO', origem: 'API_JOELPIRES',
      montadora_nao_configurada: true, aguardando_configuracao: true };
  }

  const fornecedor = await selecionarFornecedor(
    connection,
    pedido.codigo_servico
  );
  if (fornecedor) {
    const [origens] = await connection.query(
      `SELECT id FROM origens_senha WHERE codigo='FORNECEDOR' AND ativo=1 LIMIT 1`
    );
    const origemId = origens.length ? origens[0].id : null;
    await connection.query(
      `UPDATE pedidos_senha SET status='EM_CONSULTA',fornecedor_id=?,origem_id=?,custo=? WHERE id=?`,
      [fornecedor.fornecedor_id, origemId, Number(fornecedor.custo), pedido.id]
    );
    const comunicacao = await agendarConsultaFornecedor(connection, {
      pedido,
      fornecedor,
      usuarioId
    });
    await registrarHistorico(connection, pedido.id, usuarioId, 'PROCESSADO_APOS_PAGAMENTO',
      'Pedido encaminhado ao fornecedor apos busca no banco de dados',
      { status: 'EM_CONSULTA', fornecedor_id: fornecedor.fornecedor_id,
        fornecedor: fornecedor.fornecedor, custo: Number(fornecedor.custo),
        comunicacao_id: comunicacao.id,
        envio_status: comunicacao.status });
    return { status: 'EM_CONSULTA', origem: 'FORNECEDOR',
      fornecedor_id: fornecedor.fornecedor_id, fornecedor: fornecedor.fornecedor,
      custo: Number(fornecedor.custo), comunicacao };
  }
  await connection.query(
    `UPDATE pedidos_senha SET status='ABERTO',custo=0,fornecedor_id=NULL,origem_id=NULL WHERE id=?`,
    [pedido.id]
  );
  await registrarHistorico(connection, pedido.id, usuarioId, 'PROCESSADO_APOS_PAGAMENTO',
    'Pagamento confirmado, mas nenhum fornecedor esta disponivel',
    { status: 'ABERTO', aguardando_fornecedor: true });
  return { status: 'ABERTO', origem: null, aguardando_fornecedor: true };
};
