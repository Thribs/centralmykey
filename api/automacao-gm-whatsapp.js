'use strict';

const { normalizarChassi } = require('./consulta-banco-senhas');

const ACAO_ESTADO = 'ESTADO_AUTOMACAO_GM';

function normalizarTexto(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function identificaSenhaGm(texto) {
  const valor = normalizarTexto(texto);
  return /(SENHA|CODIGO).*(GM|CHEVROLET)|(GM|CHEVROLET).*(SENHA|CODIGO)/.test(valor);
}

function extrairChassi(texto) {
  const candidatos = normalizarTexto(texto).match(/[A-Z0-9]{8,30}/g) || [];
  for (const candidato of candidatos.sort((a, b) => b.length - a.length)) {
    try {
      const chassi = normalizarChassi(candidato);
      if (chassi) return chassi;
    } catch { /* tenta o próximo token */ }
  }
  return null;
}

function objetoJson(valor) {
  if (valor && typeof valor === 'object') return valor;
  try { return JSON.parse(String(valor || '{}')); } catch { return {}; }
}

async function lerEstado(connection, atendimentoId) {
  const [[linha]] = await connection.query(
    `SELECT dados_depois
       FROM auditoria
      WHERE entidade='atendimentos' AND entidade_id=? AND acao=?
      ORDER BY id DESC LIMIT 1`,
    [String(atendimentoId), ACAO_ESTADO]
  );
  return linha ? objetoJson(linha.dados_depois) : null;
}

async function registrarEstado(connection, atendimentoId, estado) {
  await connection.query(
    `INSERT INTO auditoria
       (usuario_id, modulo, acao, entidade, entidade_id, descricao,
        dados_antes, dados_depois)
     VALUES (NULL, 'ATENDIMENTO', ?, 'atendimentos', ?, ?, NULL, ?)`,
    [ACAO_ESTADO, String(atendimentoId),
      `Automação GM em ${estado.etapa}`, JSON.stringify({
        etapa: estado.etapa,
        pedido_id: estado.pedido_id || null,
        tentativas: Number(estado.tentativas || 0),
        erro_codigo: estado.erro_codigo || null
      })]
  );
}

async function agendarMensagem(connection, atendimentoId, texto) {
  await connection.query(
    `INSERT INTO atendimento_mensagens
       (atendimento_id, direcao, autor_tipo, tipo_conteudo, texto,
        status_entrega)
     VALUES (?, 'SAIDA', 'IA', 'TEXTO', ?, 'PENDENTE')`,
    [atendimentoId, String(texto).slice(0, 5000)]
  );
}

async function encaminharHumanoConnection(connection, atendimentoId, codigo, detalhe) {
  const mensagem = String(detalhe || 'Automação GM requer atendimento humano').slice(0, 500);
  await connection.query(
    `UPDATE atendimentos
        SET modo='HUMANO', status='FILA', prioridade='ALTA', responsavel_id=NULL,
            assunto='Senha GM · revisão humana', ultima_mensagem_em=NOW()
      WHERE id=? AND status NOT IN ('FINALIZADO','CANCELADO')`,
    [atendimentoId]
  );
  await connection.query(
    `INSERT INTO atendimento_mensagens
       (atendimento_id, direcao, autor_tipo, tipo_conteudo, texto)
     VALUES (?, 'INTERNA', 'SISTEMA', 'TEXTO', ?)`,
    [atendimentoId, `Encaminhado para atendimento humano: ${mensagem}`]
  );
  await registrarEstado(connection, atendimentoId, {
    etapa: 'HUMANO', erro_codigo: String(codigo || 'AUTOMACAO_INTERROMPIDA').slice(0, 80)
  });
}

async function encaminharHumano(pool, atendimentoId, codigo, detalhe) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await encaminharHumanoConnection(connection, atendimentoId, codigo, detalhe);
    await connection.commit();
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally { connection.release(); }
}

async function finalizarCriacao(pool, atendimentoId, resultado) {
  const pedido = resultado?.corpo?.pedido;
  if (!pedido?.id) {
    await encaminharHumano(pool, atendimentoId,
      resultado?.corpo?.codigo || 'PEDIDO_GM_NAO_CRIADO',
      resultado?.corpo?.error || 'Não foi possível criar o pedido GM');
    return { automatizado: false, humano: true };
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, usuario_id, tipo, descricao, dados)
       SELECT ?, NULL, 'ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO', ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM pedido_historico
           WHERE pedido_id=? AND tipo='ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO'
        )`,
      [pedido.id, 'Pedido criado pela automação GM do WhatsApp',
        JSON.stringify({ atendimento_id: atendimentoId }), pedido.id]
    );
    if (pedido.status === 'EM_CONSULTA') {
      await connection.query(
        `UPDATE atendimentos SET status='AGUARDANDO_FORNECEDOR',
          assunto='Senha GM · aguardando fornecedor' WHERE id=?`, [atendimentoId]
      );
      await registrarEstado(connection, atendimentoId,
        { etapa: 'AGUARDANDO_FORNECEDOR', pedido_id: pedido.id });
    } else if (pedido.status === 'CONCLUIDO') {
      await connection.query(
        `UPDATE atendimentos SET status='PRONTO_ENVIO',
          assunto='Senha GM · entrega preparada' WHERE id=?`, [atendimentoId]
      );
      await registrarEstado(connection, atendimentoId,
        { etapa: 'AGUARDANDO_ENTREGA', pedido_id: pedido.id });
    } else {
      await encaminharHumanoConnection(connection, atendimentoId,
        pedido.status === 'AGUARDANDO_PAGAMENTO'
          ? 'PAGAMENTO_REQUER_ATENDIMENTO' : `PEDIDO_${pedido.status}`,
        pedido.status === 'AGUARDANDO_PAGAMENTO'
          ? 'Pedido criado e aguardando confirmação do pagamento'
          : `Pedido criado no estado ${pedido.status}`);
    }
    await connection.commit();
    return { automatizado: pedido.status === 'EM_CONSULTA' || pedido.status === 'CONCLUIDO',
      pedido_id: pedido.id, status: pedido.status };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally { connection.release(); }
}

async function criarPedidoDoAtendimento(pool, app, atendimentoId, clienteId, chassi) {
  if (typeof app.locals.criarPedidoInterno !== 'function') {
    await encaminharHumano(pool, atendimentoId, 'CRIADOR_PEDIDO_INDISPONIVEL',
      'Rotina de criação de pedido indisponível');
    return { automatizado: false, humano: true };
  }
  const [[servico]] = await pool.query(
    "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
  );
  if (!servico) {
    await encaminharHumano(pool, atendimentoId, 'SERVICO_GM_INDISPONIVEL',
      'Serviço GM não está ativo');
    return { automatizado: false, humano: true };
  }
  const resultado = await app.locals.criarPedidoInterno({
    dados: { cliente_id: clienteId, servico_id: servico.id, chassi, marca: 'GM' },
    atendimentoId
  });
  return finalizarCriacao(pool, atendimentoId, resultado);
}

async function processarEntradaClienteWhatsapp(pool, app, entrada) {
  const atendimentoId = Number(entrada.atendimentoId);
  const connection = await pool.getConnection();
  let criarPedido = null;
  try {
    await connection.beginTransaction();
    const [[atendimento]] = await connection.query(
      `SELECT id, cliente_id, modo, status FROM atendimentos
        WHERE id=? LIMIT 1 FOR UPDATE`, [atendimentoId]
    );
    if (!atendimento || atendimento.modo === 'HUMANO' ||
        ['FINALIZADO', 'CANCELADO'].includes(atendimento.status)) {
      await connection.rollback();
      return { automatizado: false, motivo: 'ATENDIMENTO_NAO_ELETRONICO' };
    }
    const estado = await lerEstado(connection, atendimentoId);
    const texto = entrada.tipoConteudo === 'TEXTO' ? String(entrada.texto || '') : '';
    if (!estado) {
      if (!identificaSenhaGm(texto)) {
        await encaminharHumanoConnection(connection, atendimentoId,
          'INTENCAO_NAO_RECONHECIDA', 'Solicitação não reconhecida como senha GM');
        await connection.commit();
        return { automatizado: false, humano: true };
      }
      if (!atendimento.cliente_id) {
        await encaminharHumanoConnection(connection, atendimentoId,
          'CLIENTE_NAO_IDENTIFICADO', 'Telefone não pertence a um cliente ativo');
        await connection.commit();
        return { automatizado: false, humano: true };
      }
      const chassi = extrairChassi(texto);
      if (!chassi) {
        await registrarEstado(connection, atendimentoId,
          { etapa: 'AGUARDANDO_CHASSI', tentativas: 0 });
        await connection.query(
          `UPDATE atendimentos SET status='AGUARDANDO_CLIENTE',
            assunto='Senha GM · aguardando chassi' WHERE id=?`, [atendimentoId]
        );
        await agendarMensagem(connection, atendimentoId,
          'Olá! Para consultar a senha GM, envie o chassi com pelo menos 8 caracteres.');
        await connection.commit();
        return { automatizado: true, etapa: 'AGUARDANDO_CHASSI' };
      }
      await registrarEstado(connection, atendimentoId, { etapa: 'PROCESSANDO' });
      criarPedido = { clienteId: atendimento.cliente_id, chassi };
    } else if (estado.etapa === 'AGUARDANDO_CHASSI') {
      const chassi = extrairChassi(texto);
      if (!chassi) {
        const tentativas = Number(estado.tentativas || 0) + 1;
        if (tentativas >= 2) {
          await encaminharHumanoConnection(connection, atendimentoId,
            'CHASSI_INVALIDO', 'Chassi não reconhecido após duas tentativas');
          await connection.commit();
          return { automatizado: false, humano: true };
        }
        await registrarEstado(connection, atendimentoId,
          { etapa: 'AGUARDANDO_CHASSI', tentativas });
        await agendarMensagem(connection, atendimentoId,
          'Não consegui reconhecer o chassi. Envie somente os caracteres do chassi.');
        await connection.commit();
        return { automatizado: true, etapa: 'AGUARDANDO_CHASSI' };
      }
      await registrarEstado(connection, atendimentoId, { etapa: 'PROCESSANDO' });
      criarPedido = { clienteId: atendimento.cliente_id, chassi };
    }
    await connection.commit();
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally { connection.release(); }

  if (criarPedido) {
    try {
      return await criarPedidoDoAtendimento(pool, app, atendimentoId,
        criarPedido.clienteId, criarPedido.chassi);
    } catch (erro) {
      await encaminharHumano(pool, atendimentoId,
        erro.codigo || 'FALHA_PROCESSAMENTO_GM', erro.message);
      return { automatizado: false, humano: true };
    }
  }
  return { automatizado: false, motivo: 'ETAPA_SEM_ACAO' };
}

async function buscarAtendimentoAutomaticoDoPedido(connection, pedidoId) {
  const [[linha]] = await connection.query(
    `SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(dados, '$.atendimento_id')) AS UNSIGNED)
              AS atendimento_id
       FROM pedido_historico
      WHERE pedido_id=? AND tipo='ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO'
      ORDER BY id DESC LIMIT 1`, [pedidoId]
  );
  return Number(linha?.atendimento_id) || null;
}

module.exports = {
  agendarMensagem,
  buscarAtendimentoAutomaticoDoPedido,
  encaminharHumano,
  encaminharHumanoConnection,
  extrairChassi,
  identificaSenhaGm,
  lerEstado,
  processarEntradaClienteWhatsapp,
  registrarEstado
};
