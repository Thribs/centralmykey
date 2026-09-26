'use strict';

const {
  registrarNotificacao,
  resolverNotificacao
} = require('./notificacoes-internas');
const {
  buscarAtendimentoAutomaticoDoPedido,
  encaminharHumanoConnection,
  registrarEstado
} = require('./automacao-gm-whatsapp');

const NOME_BLOQUEIO = 'central_mykey_comunicacoes_outbox';

function numeroInteiro(valor, padrao, minimo, maximo) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= minimo && numero <= maximo
    ? numero
    : padrao;
}

function configuracao(opcoes = {}) {
  return {
    habilitado: opcoes.habilitado ??
      String(process.env.COMUNICACOES_OUTBOX_HABILITADO || '')
        .trim().toLowerCase() === 'true',
    limite: numeroInteiro(
      opcoes.limite ?? process.env.COMUNICACOES_OUTBOX_LOTE,
      10,
      1,
      100
    ),
    nomeModeloFornecedor: String(
      opcoes.nomeModeloFornecedor || opcoes.nomeModelo ||
      process.env.WHATSAPP_MODELO_CONSULTA_FORNECEDOR || ''
    ).trim(),
    nomeModeloEntrega: String(
      opcoes.nomeModeloEntrega ||
      process.env.WHATSAPP_MODELO_ENTREGA_RESULTADO || ''
    ).trim(),
    idiomaModeloFornecedor: String(
      opcoes.idiomaModeloFornecedor || opcoes.idiomaModelo ||
      process.env.WHATSAPP_MODELO_CONSULTA_FORNECEDOR_IDIOMA ||
      'pt_BR'
    ).trim(),
    idiomaModeloEntrega: String(
      opcoes.idiomaModeloEntrega || opcoes.idiomaModelo ||
      process.env.WHATSAPP_MODELO_ENTREGA_RESULTADO_IDIOMA ||
      'pt_BR'
    ).trim(),
    automacaoGmHabilitada: opcoes.automacaoGmHabilitada ?? true
  };
}

function objetoJson(valor) {
  if (valor && typeof valor === 'object') return valor;
  try {
    return JSON.parse(String(valor || '{}'));
  } catch {
    return {};
  }
}

function falhaIncerta(erro) {
  return erro?.name === 'AbortError' ||
    erro instanceof TypeError ||
    Number(erro?.statusMeta || 0) >= 500;
}

async function registrarFalha(connection, item, erro) {
  const status = falhaIncerta(erro) ? 'INCERTA' : 'FALHOU';
  const entregaCliente = item.finalidade === 'ENTREGA_CLIENTE';
  const codigo = String(
    erro?.codigo || erro?.name || 'ERRO_ENVIO'
  ).slice(0, 80);
  const detalhe = String(erro?.message || 'Falha no envio').slice(0, 500);

  await connection.query(
    `UPDATE comunicacoes_outbox
        SET status = ?, erro_codigo = ?, erro_detalhe = ?
      WHERE id = ? AND status = 'PROCESSANDO'`,
    [status, codigo, detalhe, item.id]
  );

  await connection.query(
    `INSERT INTO pedido_historico
       (pedido_id, usuario_id, tipo, descricao, dados)
     VALUES (?, NULL, ?, ?, ?)`,
    [
      item.pedido_id,
      entregaCliente
        ? 'ENTREGA_CLIENTE_ENVIO_FALHOU'
        : 'CONSULTA_FORNECEDOR_ENVIO_FALHOU',
      status === 'INCERTA'
        ? `${entregaCliente ? 'Entrega ao cliente' : 'Envio ao fornecedor'} com resultado incerto; repetição automática bloqueada`
        : entregaCliente
          ? 'Não foi possível enviar o resultado ao cliente'
          : 'Não foi possível enviar a consulta ao fornecedor',
      JSON.stringify({
        comunicacao_id: item.id,
        fornecedor_id: item.fornecedor_id,
        resultado_id: item.resultado_id,
        status,
        erro_codigo: codigo
      })
    ]
  );

  await registrarNotificacao(connection, {
    chave: `COMUNICACAO_OUTBOX:${item.id}`,
    tipo: entregaCliente
      ? 'FALHA_ENTREGA_CLIENTE'
      : 'FALHA_CONSULTA_FORNECEDOR',
    nivel: status === 'INCERTA' ? 'CRITICA' : 'ATENCAO',
    modulo: 'PEDIDOS_SENHAS',
    titulo: status === 'INCERTA'
      ? 'Envio com resultado incerto'
      : 'Falha de comunicação',
    mensagem: entregaCliente
      ? `A entrega ao cliente do pedido #${item.pedido_id} exige atenção.`
      : `A consulta ao fornecedor do pedido #${item.pedido_id} exige atenção.`,
    entidade: 'comunicacoes_outbox',
    entidadeId: item.id,
    dados: {
      pedido_id: item.pedido_id,
      comunicacao_id: item.id,
      finalidade: item.finalidade,
      status,
      erro_codigo: codigo
    }
  }).catch(error => {
    console.error('Falha ao criar notificação de comunicação:', error.message);
  });

  const atendimentoId = await buscarAtendimentoAutomaticoDoPedido(
    connection, item.pedido_id
  );
  if (atendimentoId) {
    await encaminharHumanoConnection(connection, atendimentoId, codigo,
      entregaCliente
        ? 'Falha ao entregar a senha GM ao cliente'
        : 'Falha ao enviar a consulta GM ao fornecedor');
  }

  return { processada: true, enviada: false, status, erro_codigo: codigo };
}

async function processarComunicacao(connection, itemId, enviarModelo, opcoes = {}) {
  const cfg = configuracao(opcoes);

  const [reivindicada] = await connection.query(
    `UPDATE comunicacoes_outbox
        SET status = 'PROCESSANDO', tentativas = tentativas + 1,
            erro_codigo = NULL, erro_detalhe = NULL
      WHERE id = ? AND status = 'PENDENTE' AND processar_apos <= NOW()`,
    [itemId]
  );

  if (reivindicada.affectedRows !== 1) {
    return { processada: false, motivo: 'NAO_PENDENTE' };
  }

  const [[item]] = await connection.query(
    `SELECT id, pedido_id, resultado_id, fornecedor_id,
            finalidade, destinatario, payload
       FROM comunicacoes_outbox WHERE id = ? LIMIT 1`,
    [itemId]
  );

  if (!item) {
    return { processada: false, motivo: 'NAO_ENCONTRADA' };
  }
  const atendimentoAutomaticoId = await buscarAtendimentoAutomaticoDoPedido(
    connection, item.pedido_id
  );
  if (atendimentoAutomaticoId) {
    const [[atendimentoAutomatico]] = await connection.query(
      'SELECT modo FROM atendimentos WHERE id=? LIMIT 1',
      [atendimentoAutomaticoId]
    );
    if (atendimentoAutomatico?.modo === 'HUMANO' ||
        cfg.automacaoGmHabilitada === false) {
      const codigoCancelamento = cfg.automacaoGmHabilitada === false
        ? 'AUTOMACAO_GM_DESABILITADA' : 'AUTOMACAO_ENCAMINHADA_HUMANO';
      if (cfg.automacaoGmHabilitada === false &&
          atendimentoAutomatico?.modo !== 'HUMANO') {
        await encaminharHumanoConnection(connection, atendimentoAutomaticoId,
          'AUTOMACAO_GM_DESABILITADA',
          'Automacao GM desabilitada antes da comunicacao externa');
      }
      await connection.query(
        `UPDATE comunicacoes_outbox
            SET status='CANCELADA', erro_codigo=?,
                erro_detalhe='Atendimento transferido para operação humana'
          WHERE id=? AND status='PROCESSANDO'`, [codigoCancelamento, item.id]
      );
      await connection.query(
        `INSERT INTO pedido_historico
           (pedido_id, usuario_id, tipo, descricao, dados)
         VALUES (?, NULL, 'COMUNICACAO_AUTOMATICA_CANCELADA', ?, ?)`,
        [item.pedido_id,
          'Comunicação automática cancelada após transferência para atendimento humano',
          JSON.stringify({ comunicacao_id: item.id, finalidade: item.finalidade })]
      );
      return { processada: true, enviada: false, status: 'CANCELADA',
        erro_codigo: codigoCancelamento };
    }
  }
  const payload = objetoJson(item.payload);
  const entregaCliente = item.finalidade === 'ENTREGA_CLIENTE';
  const nomeModelo = entregaCliente
    ? cfg.nomeModeloEntrega
    : cfg.nomeModeloFornecedor;
  const idiomaModelo = entregaCliente
    ? cfg.idiomaModeloEntrega
    : cfg.idiomaModeloFornecedor;

  try {
    if (!nomeModelo) {
      const erro = new Error(
        entregaCliente
          ? 'Modelo de entrega ao cliente não configurado'
          : 'Modelo de consulta ao fornecedor não configurado'
      );
      erro.codigo = entregaCliente
        ? 'MODELO_ENTREGA_NAO_CONFIGURADO'
        : 'MODELO_FORNECEDOR_NAO_CONFIGURADO';
      throw erro;
    }

    if (typeof enviarModelo !== 'function') {
      const erro = new Error('Transporte WhatsApp indisponível');
      erro.codigo = 'WHATSAPP_NAO_CONFIGURADO';
      throw erro;
    }

    const envio = await enviarModelo({
      telefone: item.destinatario,
      nome: nomeModelo,
      idioma: idiomaModelo,
      parametros: Array.isArray(payload.parametros)
        ? payload.parametros
        : []
    });

    await connection.query(
      `UPDATE comunicacoes_outbox
          SET status = 'ENVIADA', mensagem_externa_id = ?,
              enviado_em = NOW(), erro_codigo = NULL, erro_detalhe = NULL
        WHERE id = ?`,
      [envio.mensagem_externa_id, item.id]
    );

    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
       VALUES (?, NULL, ?, ?, ?)`,
      [
        item.pedido_id,
        entregaCliente
          ? 'RESULTADO_ENVIADO_CLIENTE'
          : 'CONSULTA_ENVIADA_FORNECEDOR',
        entregaCliente
          ? 'Resultado enviado ao cliente pelo WhatsApp'
          : 'Consulta enviada ao fornecedor pelo WhatsApp',
        JSON.stringify({
          comunicacao_id: item.id,
          fornecedor_id: item.fornecedor_id,
          resultado_id: item.resultado_id,
          mensagem_externa_id: envio.mensagem_externa_id,
          status: 'ENVIADA'
        })
      ]
    );

    await resolverNotificacao(
      connection,
      `COMUNICACAO_OUTBOX:${item.id}`
    ).catch(error => {
      console.error('Falha ao resolver notificação de comunicação:', error.message);
    });

    if (entregaCliente) {
      const atendimentoId = atendimentoAutomaticoId;
      if (atendimentoId) {
        await connection.query(
          `UPDATE atendimentos SET status='FINALIZADO', modo='ELETRONICO',
            assunto='Senha GM · entregue', finalizado_em=NOW()
           WHERE id=? AND status NOT IN ('FINALIZADO','CANCELADO')`,
          [atendimentoId]
        );
        await registrarEstado(connection, atendimentoId, {
          etapa: 'CONCLUIDO', pedido_id: Number(item.pedido_id)
        });
      }
    }

    return {
      processada: true,
      enviada: true,
      status: 'ENVIADA',
      mensagem_externa_id: envio.mensagem_externa_id
    };
  } catch (erro) {
    return registrarFalha(connection, item, erro);
  }
}

async function processarComunicacoesOutbox(pool, enviarModelo, opcoes = {}) {
  const cfg = configuracao(opcoes);
  if (!cfg.habilitado) return { executado: false, motivo: 'DESABILITADO' };

  const connection = await pool.getConnection();
  let bloqueio = false;

  try {
    const [[resultadoBloqueio]] = await connection.query(
      'SELECT GET_LOCK(?, 0) AS adquirido',
      [NOME_BLOQUEIO]
    );
    bloqueio = Number(resultadoBloqueio.adquirido) === 1;
    if (!bloqueio) return { executado: false, motivo: 'EM_EXECUCAO' };

    const [interrompidas] = await connection.query(
      `SELECT id, pedido_id, resultado_id, fornecedor_id, finalidade
         FROM comunicacoes_outbox
        WHERE status = 'PROCESSANDO'
          AND atualizado_em < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
        ORDER BY id LIMIT ?`,
      [cfg.limite]
    );
    for (const item of interrompidas) {
      const erro = new Error('Processamento anterior terminou sem confirmação');
      erro.name = 'AbortError';
      erro.codigo = 'PROCESSAMENTO_INTERROMPIDO';
      await registrarFalha(connection, item, erro);
    }

    const [itens] = await connection.query(
      `SELECT id FROM comunicacoes_outbox
        WHERE status = 'PENDENTE' AND processar_apos <= NOW()
        ORDER BY id LIMIT ?`,
      [cfg.limite]
    );

    const resultados = [];
    for (const item of itens) {
      resultados.push(await processarComunicacao(
        connection,
        item.id,
        enviarModelo,
        cfg
      ));
    }

    return {
      executado: true,
      interrompidos: interrompidas.length,
      encontrados: itens.length,
      enviados: resultados.filter(item => item.enviada).length,
      falhas: resultados.filter(item => item.processada && !item.enviada).length
    };
  } finally {
    if (bloqueio) {
      await connection.query('SELECT RELEASE_LOCK(?)', [NOME_BLOQUEIO]);
    }
    connection.release();
  }
}

module.exports = {
  configuracao,
  falhaIncerta,
  processarComunicacao,
  processarComunicacoesOutbox
};
