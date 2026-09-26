'use strict';

const { buscarSenhaFonteVerdade } = require('./consulta-api-joelpires');
const { salvarSenhaApiJoelPires } = require('./salvar-senha-api-joelpires');
const { agendarEntregaCliente } = require('./agendar-entrega-cliente');
const {
  carregarConfiguracoesIntegracoes,
  verdadeiro
} = require('./configuracoes-integracoes');
const {
  buscarAtendimentoAutomaticoDoPedido,
  encaminharHumano,
  registrarEstado
} = require('./automacao-gm-whatsapp');

function objetoJson(valor) {
  if (valor && typeof valor === 'object') return valor;
  try { return JSON.parse(String(valor || '{}')); } catch { return {}; }
}

function mesmoCodigo(esperado, recebido) {
  if (!esperado) return true;
  return String(esperado).trim().toUpperCase() ===
    String(recebido || '').trim().toUpperCase();
}

async function finalizarResultadoGmAutomatico(pool, pedidoId, opcoes = {}) {
  const [[origem]] = await pool.query(
    `SELECT p.id, p.protocolo, p.chassi, p.marca, p.modelo, p.ano,
            s.codigo AS codigo_servico,
            c.telefone, c.telefone_normalizado,
            (SELECT ct.telefone_normalizado FROM cliente_telefones ct
              WHERE ct.cliente_id=c.id ORDER BY ct.id LIMIT 1) AS telefone_alternativo,
            pr.id AS resultado_id, pr.status AS resultado_status,
            pr.codigo_mecanico, pr.codigo_imobilizador, pr.codigo_radio,
            pr.pin, pr.resultado
       FROM pedidos_senha p
       JOIN servicos s ON s.id=p.servico_id
       JOIN clientes c ON c.id=p.cliente_id
       JOIN pedido_resultados pr ON pr.pedido_id=p.id
      WHERE p.id=? AND pr.status IN ('ENCONTRADO','CONFIRMADO')
      ORDER BY pr.id DESC LIMIT 1`, [pedidoId]
  );
  if (!origem) return { processado: false, motivo: 'RESULTADO_NAO_ENCONTRADO' };
  const atendimentoId = await buscarAtendimentoAutomaticoDoPedido(pool, pedidoId);
  if (!atendimentoId) return { processado: false, motivo: 'PEDIDO_NAO_AUTOMATICO' };
  if (origem.resultado_status === 'CONFIRMADO') {
    return { processado: true, idempotente: true, pedido_id: Number(pedidoId) };
  }
  const extras = objetoJson(origem.resultado);
  const dados = {
    marca: origem.marca || 'GM', chassi: origem.chassi,
    codigo_mecanico: origem.codigo_mecanico,
    codigo_imobilizador: origem.codigo_imobilizador,
    codigo_radio: origem.codigo_radio,
    codigo_alarme: extras.codigo_alarme || null,
    pin: origem.pin
  };
  try {
    let gravacaoHomologada = opcoes.gravacaoJoelPiresHomologada;
    if (gravacaoHomologada === undefined) {
      const configuracoes = await carregarConfiguracoesIntegracoes(pool);
      gravacaoHomologada = verdadeiro(configuracoes.joelPiresGravacaoHomologada);
    }
    if (!gravacaoHomologada) {
      const erro = new Error(
        'A gravação na API Joel Pires ainda não foi homologada'
      );
      erro.codigo = 'GRAVACAO_JOELPIRES_NAO_HOMOLOGADA';
      throw erro;
    }
    await salvarSenhaApiJoelPires(dados, { fetchImpl: opcoes.fetchImpl });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const consulta = await buscarSenhaFonteVerdade(connection, {
        chassi: origem.chassi,
        codigoServico: origem.codigo_servico,
        marca: origem.marca || 'GM', modelo: origem.modelo, ano: origem.ano
      }, { ignorarCache: true, fetchImpl: opcoes.fetchImpl });
      if (consulta.status !== 'ENCONTRADO') {
        const erro = new Error('A API Joel Pires não confirmou a senha gravada');
        erro.codigo = 'GRAVACAO_JOELPIRES_NAO_CONFIRMADA';
        throw erro;
      }
      const senha = consulta.senha;
      if (!mesmoCodigo(dados.codigo_mecanico, senha.codigo_mecanico) ||
          !mesmoCodigo(dados.codigo_imobilizador, senha.codigo_imobilizador) ||
          !mesmoCodigo(dados.codigo_radio, senha.codigo_radio) ||
          !mesmoCodigo(dados.codigo_alarme, senha.codigo_alarme) ||
          !mesmoCodigo(dados.pin, senha.pin)) {
        const erro = new Error('A releitura da API Joel Pires diverge do fornecedor');
        erro.codigo = 'RESULTADO_JOELPIRES_DIVERGENTE';
        throw erro;
      }
      const [[resultado]] = await connection.query(
        `SELECT id, status FROM pedido_resultados
          WHERE id=? AND pedido_id=? LIMIT 1 FOR UPDATE`,
        [origem.resultado_id, pedidoId]
      );
      if (!resultado) throw new Error('Resultado do pedido não encontrado');
      if (resultado.status !== 'CONFIRMADO') {
        await connection.query(
          `UPDATE pedido_resultados SET status='CONFIRMADO', banco_senha_id=?
            WHERE id=?`, [senha.id, resultado.id]
        );
      }
      const entrega = await agendarEntregaCliente(connection, {
        pedido: { id: origem.id, protocolo: origem.protocolo },
        cliente: { telefone_normalizado:
          origem.telefone_normalizado || origem.telefone_alternativo,
        telefone: origem.telefone },
        resultado: { id: resultado.id,
          codigo_mecanico: senha.codigo_mecanico,
          codigo_imobilizador: senha.codigo_imobilizador,
          codigo_radio: senha.codigo_radio, pin: senha.pin,
          resultado: { codigo_alarme: senha.codigo_alarme } }
      });
      await connection.query(
        `INSERT INTO pedido_historico
           (pedido_id, usuario_id, tipo, descricao, dados)
         VALUES (?, NULL, 'RESULTADO_PUBLICADO_API_JOELPIRES', ?, ?)`,
        [pedidoId, 'Resultado salvo e relido na API Joel Pires antes da entrega',
          JSON.stringify({ resultado_id: resultado.id, banco_senha_id: senha.id,
            entrega_id: entrega.id, entrega_status: entrega.status })]
      );
      await connection.query(
        `UPDATE atendimentos SET status='PRONTO_ENVIO',
          assunto='Senha GM · entrega preparada' WHERE id=?`, [atendimentoId]
      );
      await registrarEstado(connection, atendimentoId,
        { etapa: 'AGUARDANDO_ENTREGA', pedido_id: Number(pedidoId) });
      await connection.commit();
      return { processado: true, idempotente: false,
        pedido_id: Number(pedidoId), entrega };
    } catch (erro) {
      await connection.rollback();
      throw erro;
    } finally { connection.release(); }
  } catch (erro) {
    await encaminharHumano(pool, atendimentoId,
      erro.codigo || 'FALHA_PUBLICACAO_JOELPIRES', erro.message);
    return { processado: false, humano: true,
      erro_codigo: erro.codigo || 'FALHA_PUBLICACAO_JOELPIRES' };
  }
}

module.exports = { finalizarResultadoGmAutomatico };
