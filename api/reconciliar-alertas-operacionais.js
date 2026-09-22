'use strict';

const {
  registrarNotificacao,
  resolverNotificacao
} = require('./notificacoes-internas');

const NOME_BLOQUEIO = 'central_mykey_alertas_operacionais';

function inteiro(valor, padrao, minimo = 1, maximo = 10080) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= minimo && numero <= maximo
    ? numero
    : padrao;
}

function objetoJson(valor) {
  if (valor && typeof valor === 'object') return valor;
  try {
    return JSON.parse(String(valor || '{}'));
  } catch {
    return {};
  }
}

async function sincronizar(connection, alerta) {
  const [[existente]] = await connection.query(
    'SELECT id, status, nivel, dados FROM notificacoes WHERE chave = ? LIMIT 1',
    [alerta.chave]
  );
  if (!alerta.ativo) {
    const resolvida = await resolverNotificacao(connection, alerta.chave);
    return { chave: alerta.chave, status: 'RESOLVIDA', alterada: resolvida };
  }

  const dadosExistentes = objetoJson(existente?.dados);
  const mesmosDados = JSON.stringify(dadosExistentes) === JSON.stringify(alerta.dados);
  if (existente?.status === 'ATIVA' && existente.nivel === alerta.nivel && mesmosDados) {
    return { chave: alerta.chave, status: 'ATIVA', alterada: false };
  }

  const registrada = await registrarNotificacao(connection, alerta);
  return { ...registrada, alterada: true };
}

async function reconciliarAlertasOperacionais(pool, opcoes = {}) {
  const limites = {
    pedidoMinutos: inteiro(
      opcoes.pedidoMinutos ?? process.env.MONITORAMENTO_PEDIDO_ATRASO_MINUTOS,
      30
    ),
    outboxMinutos: inteiro(
      opcoes.outboxMinutos ?? process.env.MONITORAMENTO_OUTBOX_ATRASO_MINUTOS,
      10
    ),
    eventoMinutos: inteiro(
      opcoes.eventoMinutos ?? process.env.MONITORAMENTO_EVENTO_ATRASO_MINUTOS,
      10
    )
  };
  const connection = await pool.getConnection();
  let bloqueio = false;
  try {
    const [[resultadoBloqueio]] = await connection.query(
      'SELECT GET_LOCK(?, 0) AS adquirido',
      [NOME_BLOQUEIO]
    );
    bloqueio = Number(resultadoBloqueio?.adquirido) === 1;
    if (!bloqueio) return { executado: false, motivo: 'EM_EXECUCAO' };

    await connection.beginTransaction();
    const [[gm]] = await connection.query(
      `SELECT COUNT(*) AS total
         FROM pedidos_senha p
         INNER JOIN servicos s ON s.id = p.servico_id
         INNER JOIN pedido_historico h ON h.id = (
           SELECT MAX(h2.id) FROM pedido_historico h2 WHERE h2.pedido_id = p.id
         )
        WHERE p.status = 'ABERTO'
          AND p.fornecedor_id IS NULL
          AND p.origem_id IS NULL
          AND s.codigo = 'GM_SENHA'
          AND h.tipo = 'API_JOELPIRES_INDISPONIVEL'
          AND h.criado_em <= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [limites.pedidoMinutos]
    );
    const [[outbox]] = await connection.query(
      `SELECT
         SUM(status = 'PENDENTE'
             AND processar_apos <= DATE_SUB(NOW(), INTERVAL ? MINUTE)) AS pendentes,
         SUM(status = 'PROCESSANDO'
             AND atualizado_em <= DATE_SUB(NOW(), INTERVAL ? MINUTE)) AS processando
       FROM comunicacoes_outbox`,
      [limites.outboxMinutos, limites.outboxMinutos]
    );
    const [[integracoes]] = await connection.query(
      `SELECT
         SUM(status = 'FALHOU') AS falhas,
         SUM(status = 'RECEBIDO'
             AND recebido_em <= DATE_SUB(NOW(), INTERVAL ? MINUTE)) AS atrasados
       FROM integracao_eventos`,
      [limites.eventoMinutos]
    );

    const totais = {
      gm: Number(gm.total || 0),
      outboxPendentes: Number(outbox.pendentes || 0),
      outboxProcessando: Number(outbox.processando || 0),
      integracoesFalhas: Number(integracoes.falhas || 0),
      integracoesAtrasadas: Number(integracoes.atrasados || 0)
    };
    const alertas = [
      {
        chave: 'MONITORAMENTO:GM_REPROCESSAMENTO_ATRASADO',
        ativo: totais.gm > 0,
        tipo: 'GM_REPROCESSAMENTO_ATRASADO',
        nivel: 'CRITICA',
        modulo: 'PEDIDOS_SENHAS',
        titulo: 'Pedidos GM aguardando a API',
        mensagem: `${totais.gm} pedido(s) GM aguardam reprocessamento além do limite.`,
        entidade: 'pedidos_senha',
        dados: { total: totais.gm, limite_minutos: limites.pedidoMinutos }
      },
      {
        chave: 'MONITORAMENTO:OUTBOX_ATRASADA',
        ativo: totais.outboxPendentes + totais.outboxProcessando > 0,
        tipo: 'OUTBOX_ATRASADA',
        nivel: 'ATENCAO',
        modulo: 'PEDIDOS_SENHAS',
        titulo: 'Comunicações aguardando processamento',
        mensagem: `${totais.outboxPendentes + totais.outboxProcessando} comunicação(ões) ultrapassaram o limite.`,
        entidade: 'comunicacoes_outbox',
        dados: {
          pendentes: totais.outboxPendentes,
          processando: totais.outboxProcessando,
          limite_minutos: limites.outboxMinutos
        }
      },
      {
        chave: 'MONITORAMENTO:INTEGRACOES_PENDENTES',
        ativo: totais.integracoesFalhas + totais.integracoesAtrasadas > 0,
        tipo: 'INTEGRACOES_PENDENTES',
        nivel: 'CRITICA',
        modulo: 'INTEGRACOES',
        titulo: 'Eventos de integração exigem atenção',
        mensagem: `${totais.integracoesFalhas + totais.integracoesAtrasadas} evento(s) falharam ou estão atrasados.`,
        entidade: 'integracao_eventos',
        dados: {
          falhas: totais.integracoesFalhas,
          atrasados: totais.integracoesAtrasadas,
          limite_minutos: limites.eventoMinutos
        }
      }
    ];
    const resultados = [];
    for (const alerta of alertas) {
      resultados.push(await sincronizar(connection, alerta));
    }
    await connection.commit();
    return { executado: true, limites, totais, alertas: resultados };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally {
    if (bloqueio) {
      await connection.query('SELECT RELEASE_LOCK(?)', [NOME_BLOQUEIO])
        .catch(() => {});
    }
    connection.release();
  }
}

module.exports = { NOME_BLOQUEIO, reconciliarAlertasOperacionais };
