'use strict';

const { encaminharHumanoConnection } = require('./automacao-gm-whatsapp');

const NOME_BLOQUEIO = 'central_mykey_mensagens_atendimento';

async function processarMensagemAtendimento(connection, mensagemId, enviar) {
  const [[mensagem]] = await connection.query(
    `SELECT m.id, m.atendimento_id, m.texto, a.telefone_normalizado
       FROM atendimento_mensagens m
       JOIN atendimentos a ON a.id=m.atendimento_id
      WHERE m.id=? AND m.direcao='SAIDA' AND m.autor_tipo='IA'
        AND m.status_entrega='PENDENTE' AND a.modo='ELETRONICO'
      LIMIT 1`, [mensagemId]
  );
  if (!mensagem) return { processada: false, motivo: 'NAO_PENDENTE' };
  try {
    if (typeof enviar !== 'function') {
      const erro = new Error('Transporte WhatsApp indisponível');
      erro.codigo = 'WHATSAPP_NAO_CONFIGURADO';
      throw erro;
    }
    const envio = await enviar({
      telefone: mensagem.telefone_normalizado,
      texto: mensagem.texto
    });
    await connection.query(
      `UPDATE atendimento_mensagens SET mensagem_externa_id=?,
        status_entrega='ENVIADA', status_atualizado_em=NOW(),
        erro_codigo=NULL, erro_detalhe=NULL
       WHERE id=? AND status_entrega='PENDENTE'`,
      [envio.mensagem_externa_id, mensagem.id]
    );
    return { processada: true, enviada: true,
      mensagem_externa_id: envio.mensagem_externa_id };
  } catch (erro) {
    const codigo = String(erro.codigo || erro.name || 'ERRO_ENVIO').slice(0, 64);
    await connection.query(
      `UPDATE atendimento_mensagens SET status_entrega='FALHOU',
        status_atualizado_em=NOW(), erro_codigo=?, erro_detalhe=? WHERE id=?`,
      [codigo, String(erro.message || 'Falha no envio').slice(0, 500), mensagem.id]
    );
    await encaminharHumanoConnection(connection, mensagem.atendimento_id,
      codigo, 'Não foi possível enviar a resposta automática ao cliente');
    return { processada: true, enviada: false, erro_codigo: codigo };
  }
}

async function processarMensagensAtendimento(pool, enviar, opcoes = {}) {
  if (!opcoes.habilitado) return { executado: false, motivo: 'DESABILITADO' };
  const limite = Math.min(Math.max(Number(opcoes.limite) || 10, 1), 100);
  const connection = await pool.getConnection();
  let bloqueio = false;
  try {
    const [[trava]] = await connection.query('SELECT GET_LOCK(?, 0) AS adquirido',
      [NOME_BLOQUEIO]);
    bloqueio = Number(trava.adquirido) === 1;
    if (!bloqueio) return { executado: false, motivo: 'EM_EXECUCAO' };
    const [mensagens] = await connection.query(
      `SELECT m.id FROM atendimento_mensagens m
        JOIN atendimentos a ON a.id=m.atendimento_id
       WHERE m.direcao='SAIDA' AND m.autor_tipo='IA'
         AND m.status_entrega='PENDENTE' AND a.modo='ELETRONICO'
       ORDER BY m.id LIMIT ?`, [limite]
    );
    const resultados = [];
    for (const item of mensagens) {
      resultados.push(await processarMensagemAtendimento(connection, item.id, enviar));
    }
    return { executado: true, encontrados: mensagens.length,
      enviados: resultados.filter(item => item.enviada).length,
      falhas: resultados.filter(item => item.processada && !item.enviada).length };
  } finally {
    if (bloqueio) await connection.query('SELECT RELEASE_LOCK(?)', [NOME_BLOQUEIO]);
    connection.release();
  }
}

module.exports = { processarMensagemAtendimento, processarMensagensAtendimento };
