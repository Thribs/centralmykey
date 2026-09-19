'use strict';

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
    nomeModelo: String(
      opcoes.nomeModelo ||
      process.env.WHATSAPP_MODELO_CONSULTA_FORNECEDOR || ''
    ).trim(),
    idiomaModelo: String(
      opcoes.idiomaModelo ||
      process.env.WHATSAPP_MODELO_CONSULTA_FORNECEDOR_IDIOMA ||
      'pt_BR'
    ).trim()
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
     VALUES (?, NULL, 'CONSULTA_FORNECEDOR_ENVIO_FALHOU', ?, ?)`,
    [
      item.pedido_id,
      status === 'INCERTA'
        ? 'Envio ao fornecedor com resultado incerto; repetição automática bloqueada'
        : 'Não foi possível enviar a consulta ao fornecedor',
      JSON.stringify({
        comunicacao_id: item.id,
        fornecedor_id: item.fornecedor_id,
        status,
        erro_codigo: codigo
      })
    ]
  );

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
    `SELECT id, pedido_id, fornecedor_id, destinatario, payload
       FROM comunicacoes_outbox WHERE id = ? LIMIT 1`,
    [itemId]
  );

  if (!item) {
    return { processada: false, motivo: 'NAO_ENCONTRADA' };
  }
  const payload = objetoJson(item.payload);

  try {
    if (!cfg.nomeModelo) {
      const erro = new Error('Modelo de consulta ao fornecedor não configurado');
      erro.codigo = 'MODELO_FORNECEDOR_NAO_CONFIGURADO';
      throw erro;
    }

    if (typeof enviarModelo !== 'function') {
      const erro = new Error('Transporte WhatsApp indisponível');
      erro.codigo = 'WHATSAPP_NAO_CONFIGURADO';
      throw erro;
    }

    const envio = await enviarModelo({
      telefone: item.destinatario,
      nome: cfg.nomeModelo,
      idioma: cfg.idiomaModelo,
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
       VALUES (?, NULL, 'CONSULTA_ENVIADA_FORNECEDOR', ?, ?)`,
      [
        item.pedido_id,
        'Consulta enviada ao fornecedor pelo WhatsApp',
        JSON.stringify({
          comunicacao_id: item.id,
          fornecedor_id: item.fornecedor_id,
          mensagem_externa_id: envio.mensagem_externa_id,
          status: 'ENVIADA'
        })
      ]
    );

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

    await connection.query(
      `UPDATE comunicacoes_outbox
          SET status = 'INCERTA',
              erro_codigo = 'PROCESSAMENTO_INTERROMPIDO',
              erro_detalhe = 'Processamento anterior terminou sem confirmação'
        WHERE status = 'PROCESSANDO'
          AND atualizado_em < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`
    );

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
