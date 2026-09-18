'use strict';

const processarPedidoPago = require('./processar-pedido-pago');

const NOME_BLOQUEIO = 'central_mykey_reprocessamento_gm';

function inteiroConfigurado(valor, padrao, minimo, maximo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
    return padrao;
  }
  return numero;
}

function obterConfiguracao(opcoes = {}) {
  return {
    habilitado: opcoes.habilitado ??
      String(process.env.REPROCESSAMENTO_GM_AUTOMATICO || '')
        .trim().toLowerCase() === 'true',
    limite: inteiroConfigurado(
      opcoes.limite ?? process.env.REPROCESSAMENTO_GM_LOTE,
      10,
      1,
      100
    ),
    esperaSegundos: inteiroConfigurado(
      opcoes.esperaSegundos ??
        process.env.REPROCESSAMENTO_GM_ESPERA_SEGUNDOS,
      300,
      0,
      86400
    )
  };
}

async function listarCandidatos(connection, configuracao) {
  const [pedidos] = await connection.query(
    `SELECT p.id
       FROM pedidos_senha p
       INNER JOIN servicos s ON s.id = p.servico_id
       INNER JOIN pedido_historico h
         ON h.id = (
           SELECT MAX(ultimo.id)
             FROM pedido_historico ultimo
            WHERE ultimo.pedido_id = p.id
         )
      WHERE p.status = 'ABERTO'
        AND p.fornecedor_id IS NULL
        AND p.origem_id IS NULL
        AND s.codigo = 'GM_SENHA'
        AND h.tipo = 'API_JOELPIRES_INDISPONIVEL'
        AND h.criado_em <= DATE_SUB(NOW(), INTERVAL ? SECOND)
      ORDER BY h.criado_em ASC, p.id ASC
      LIMIT ?`,
    [configuracao.esperaSegundos, configuracao.limite]
  );
  return pedidos.map(pedido => Number(pedido.id));
}

async function processarCandidato(
  connection,
  pedidoId,
  processar = processarPedidoPago
) {
  const [pedidos] = await connection.query(
    `SELECT p.id, p.status, p.fornecedor_id, p.origem_id,
            s.codigo AS codigo_servico,
            (
              SELECT h.tipo
                FROM pedido_historico h
               WHERE h.pedido_id = p.id
               ORDER BY h.id DESC
               LIMIT 1
            ) AS ultimo_historico
       FROM pedidos_senha p
       INNER JOIN servicos s ON s.id = p.servico_id
      WHERE p.id = ?
      LIMIT 1
      FOR UPDATE`,
    [pedidoId]
  );

  const pedido = pedidos[0];
  const elegivel = pedido &&
    pedido.status === 'ABERTO' &&
    pedido.codigo_servico === 'GM_SENHA' &&
    pedido.fornecedor_id === null &&
    pedido.origem_id === null &&
    pedido.ultimo_historico === 'API_JOELPIRES_INDISPONIVEL';

  if (!elegivel) {
    return { processado: false, motivo: 'PEDIDO_NAO_ELEGIVEL' };
  }

  await connection.query(
    `INSERT INTO pedido_historico
       (pedido_id, usuario_id, tipo, descricao, dados)
     VALUES (?, NULL, 'REPROCESSAMENTO_AUTOMATICO_GM', ?, ?)`,
    [pedidoId, 'Nova tentativa automática na API Joel Pires',
      JSON.stringify({ origem: 'AGENDADOR' })]
  );

  const resultado = await processar(connection, pedidoId, null);
  return { processado: true, resultado };
}

async function reprocessarPedidosGm(pool, opcoes = {}) {
  const configuracao = obterConfiguracao(opcoes);
  if (!configuracao.habilitado) {
    return { executado: false, motivo: 'DESABILITADO' };
  }

  const coordenacao = await pool.getConnection();
  let bloqueioObtido = false;

  try {
    const [bloqueio] = await coordenacao.query(
      'SELECT GET_LOCK(?, 0) AS obtido',
      [NOME_BLOQUEIO]
    );
    bloqueioObtido = Number(bloqueio[0]?.obtido) === 1;
    if (!bloqueioObtido) {
      return { executado: false, motivo: 'PROCESSAMENTO_EM_ANDAMENTO' };
    }

    const candidatos = await listarCandidatos(coordenacao, configuracao);
    const resumo = {
      executado: true,
      encontrados: candidatos.length,
      processados: 0,
      ignorados: 0,
      falhas: 0,
      destinos: {}
    };

    for (const pedidoId of candidatos) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const tentativa = await processarCandidato(
          connection,
          pedidoId,
          opcoes.processar
        );

        if (!tentativa.processado) {
          resumo.ignorados += 1;
        } else {
          resumo.processados += 1;
          const destino = tentativa.resultado.status || 'DESCONHECIDO';
          resumo.destinos[destino] = (resumo.destinos[destino] || 0) + 1;
        }
        await connection.commit();
      } catch (erro) {
        await connection.rollback();
        resumo.falhas += 1;
        console.error(
          `Falha ao reprocessar automaticamente o pedido GM ${pedidoId}:`,
          erro.message
        );
      } finally {
        connection.release();
      }
    }

    return resumo;
  } finally {
    if (bloqueioObtido) {
      await coordenacao.query('SELECT RELEASE_LOCK(?)', [NOME_BLOQUEIO])
        .catch(() => {});
    }
    coordenacao.release();
  }
}

module.exports = {
  NOME_BLOQUEIO,
  listarCandidatos,
  obterConfiguracao,
  processarCandidato,
  reprocessarPedidosGm
};
