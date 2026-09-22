'use strict';

const crypto = require('crypto');

function falha(mensagem, codigo, status) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = status;
  return erro;
}

function pedidoIdValido(valor) {
  const id = String(valor ?? '').trim();
  return /^\d{1,18}$/.test(id) && !/^0+$/.test(id) ? id : null;
}

function jsonCanonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  if (valor && typeof valor === 'object') {
    return `{${Object.keys(valor).sort().map(chave =>
      `${JSON.stringify(chave)}:${jsonCanonico(valor[chave])}`).join(',')}}`;
  }
  return JSON.stringify(valor);
}

function texto(valor, limite) {
  const resultado = String(valor ?? '').trim();
  return resultado ? resultado.slice(0, limite) : null;
}

async function analisarPedidoWBuy(connection, pedido) {
  const produtos = Array.isArray(pedido?.produtos) ? pedido.produtos : [];
  const [mapeamentos] = await connection.query(
    `SELECT m.id, m.produto_externo_id, m.sku, m.servico_id,
            s.codigo AS servico_codigo, s.nome AS servico_nome
       FROM integracao_produto_mapeamentos m
       JOIN servicos s ON s.id=m.servico_id
      WHERE m.provedor='WBUY' AND m.ativo=1 AND s.ativo=1`
  );
  const [autoridades] = await connection.query(
    `SELECT dominio, autoridade FROM integracao_autoridades`
  );
  const statusExternoId = texto(pedido?.status?.id, 80);
  const [statusMapeados] = await connection.query(
    `SELECT situacao FROM integracao_status_mapeamentos
      WHERE provedor='WBUY' AND dominio='PAGAMENTO'
        AND status_externo_id=? AND ativo=1 LIMIT 1`,
    [statusExternoId]
  );
  const situacaoPagamento = statusMapeados[0]?.situacao || null;
  const autoridadePorDominio = Object.fromEntries(
    autoridades.map(item => [item.dominio, item.autoridade])
  );
  const itens = produtos.map(produto => {
    const produtoExternoId = texto(produto?.produto_id, 160);
    const sku = texto(produto?.sku ?? produto?.cod, 120)?.toUpperCase() || null;
    const candidatos = mapeamentos.filter(item =>
      (produtoExternoId && String(item.produto_externo_id || '') === produtoExternoId) ||
      (sku && String(item.sku || '').toUpperCase() === sku)
    );
    const servicos = [...new Set(candidatos.map(item => Number(item.servico_id)))];
    let situacao = 'NAO_MAPEADO';
    if (servicos.length === 1) situacao = 'MAPEADO';
    else if (servicos.length > 1) situacao = 'CONFLITO';
    const mapeamento = situacao === 'MAPEADO'
      ? candidatos.find(item => Number(item.servico_id) === servicos[0])
      : null;
    return {
      produto_externo_id: produtoExternoId,
      sku,
      quantidade: texto(produto?.qtd, 30),
      situacao,
      servico_id: mapeamento ? Number(mapeamento.servico_id) : null,
      servico_codigo: mapeamento?.servico_codigo || null,
      servico_nome: mapeamento?.servico_nome || null
    };
  });
  const pendencias = ['MOEDA_NAO_INFORMADA'];
  if (!situacaoPagamento) pendencias.push('STATUS_PAGAMENTO_NAO_MAPEADO');
  else if (situacaoPagamento !== 'CONFIRMADO') {
    pendencias.push('PAGAMENTO_EXTERNO_NAO_CONFIRMADO');
  }
  if (!autoridadePorDominio.PEDIDO) {
    pendencias.push('AUTORIDADE_PEDIDO_NAO_DEFINIDA');
  }
  if (!autoridadePorDominio.PAGAMENTO) {
    pendencias.push('AUTORIDADE_PAGAMENTO_NAO_DEFINIDA');
  }
  if (['CLIENTE', 'COMPRADOR', 'PAGADOR'].some(
    dominio => !autoridadePorDominio[dominio]
  )) {
    pendencias.push('PAPEIS_CLIENTE_COMPRADOR_PAGADOR_NAO_CONFIRMADOS');
  }
  if (itens.some(item => item.situacao === 'NAO_MAPEADO')) {
    pendencias.push('PRODUTO_NAO_MAPEADO');
  }
  if (itens.some(item => item.situacao === 'CONFLITO')) {
    pendencias.push('MAPEAMENTO_CONFLITANTE');
  }
  return {
    pedido_externo_id: texto(pedido?.id, 120),
    identificacao_externa: texto(pedido?.identificacao, 120),
    status_externo: {
      id: texto(pedido?.status?.id, 80),
      nome: texto(pedido?.status?.nome, 160)
    },
    valor_total_externo: texto(pedido?.valor_total?.total, 40),
    produtos_total: itens.length,
    produtos_mapeados: itens.filter(item => item.situacao === 'MAPEADO').length,
    produtos_pendentes: itens.filter(item => item.situacao !== 'MAPEADO').length,
    itens,
    autoridades: {
      completa: ['PEDIDO', 'PAGAMENTO', 'CLIENTE', 'COMPRADOR', 'PAGADOR',
        'FISCAL', 'ESTOQUE'].every(dominio => Boolean(autoridadePorDominio[dominio])),
      dados: autoridadePorDominio
    },
    pagamento: { mapeado: Boolean(situacaoPagamento), situacao: situacaoPagamento },
    pendencias,
    pronto_para_converter: false
  };
}

async function consultarPedidoWBuy(config, pedidoExternoId, opcoes = {}) {
  const id = pedidoIdValido(pedidoExternoId);
  if (!id) throw falha('ID do pedido WBuy inválido', 'PEDIDO_WBUY_INVALIDO', 400);
  if (!config?.usuario || !config?.senha) {
    throw falha('Integração WBuy não configurada', 'WBUY_NAO_CONFIGURADO', 503);
  }
  const transporte = opcoes.transporte || global.fetch;
  const controlador = new AbortController();
  const timeoutMs = Number(opcoes.timeoutMs) || 15000;
  const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
  const apiUrl = String(config.apiUrl || '').replace(/\/+$/, '');
  const url = `${apiUrl}/order/${encodeURIComponent(id)}`;
  let resposta;
  try {
    resposta = await transporte(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${Buffer.from(`${config.usuario}:${config.senha}`).toString('base64')}`,
        'User-Agent': 'CentralMyKey/1.0 (suporte@centralmykey.com.br)'
      },
      signal: controlador.signal
    });
  } catch (erro) {
    if (erro?.name === 'AbortError') {
      throw falha('Tempo limite ao consultar WBuy', 'TIMEOUT_WBUY', 504);
    }
    throw falha('WBuy indisponível', 'WBUY_INDISPONIVEL', 503);
  } finally {
    clearTimeout(temporizador);
  }
  if (resposta.status === 404) {
    throw falha('Pedido WBuy não encontrado', 'PEDIDO_WBUY_NAO_ENCONTRADO', 404);
  }
  if (resposta.status === 401 || resposta.status === 403) {
    throw falha('Credenciais WBuy recusadas', 'AUTENTICACAO_WBUY_RECUSADA', 502);
  }
  if (resposta.status === 429 || resposta.status >= 500) {
    throw falha('WBuy indisponível', 'WBUY_INDISPONIVEL', 503);
  }
  if (!resposta.ok) {
    throw falha('Resposta inválida da WBuy', 'RESPOSTA_WBUY_INVALIDA', 502);
  }
  let envelope;
  try {
    envelope = await resposta.json();
  } catch {
    throw falha('Resposta inválida da WBuy', 'RESPOSTA_WBUY_INVALIDA', 502);
  }
  const pedidos = Array.isArray(envelope?.data) ? envelope.data : [];
  const pedido = pedidos.find(item => String(item?.id ?? '') === id) || null;
  if (!pedido) {
    throw falha('Pedido WBuy não encontrado', 'PEDIDO_WBUY_NAO_ENCONTRADO', 404);
  }
  if (!Array.isArray(pedido.produtos) || !pedido.status || !pedido.cliente) {
    throw falha('Pedido WBuy incompleto', 'RESPOSTA_WBUY_INVALIDA', 502);
  }
  return { id, pedido };
}

async function sincronizarPedidoWBuy(pool, config, pedidoExternoId, opcoes = {}) {
  const consulta = await consultarPedidoWBuy(config, pedidoExternoId, opcoes);
  const payloadCanonico = jsonCanonico(consulta.pedido);
  const payloadHash = crypto.createHash('sha256').update(payloadCanonico).digest('hex');
  const eventoExternoId = `ORDER.SNAPSHOT:${consulta.id}:${payloadHash.slice(0, 32)}`;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [gravacao] = await connection.query(
      `INSERT INTO integracao_eventos
         (provedor, evento_externo_id, tipo, referencia_externa, entidade,
          payload_hash, payload, status)
       VALUES ('WBUY', ?, 'ORDER.SNAPSHOT', ?, 'PEDIDO_EXTERNO', ?, ?, 'RECEBIDO')
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),
         tentativas=tentativas+1, atualizado_em=NOW()`,
      [eventoExternoId, consulta.id, payloadHash, JSON.stringify(consulta.pedido)]
    );
    const [[persistido]] = await connection.query(
      `SELECT id, status, tentativas FROM integracao_eventos
        WHERE provedor='WBUY' AND evento_externo_id=? LIMIT 1 FOR UPDATE`,
      [eventoExternoId]
    );
    const idempotente = gravacao.affectedRows !== 1;
    const analise = await analisarPedidoWBuy(connection, consulta.pedido);
    await connection.query(
      `INSERT INTO auditoria
         (usuario_id, modulo, acao, entidade, entidade_id, descricao,
          dados_antes, dados_depois, ip)
       VALUES (?, 'INTEGRACOES', 'SINCRONIZAR_PEDIDO_WBUY',
               'integracao_eventos', ?, 'Snapshot de pedido WBuy recebido',
               NULL, ?, ?)`,
      [opcoes.usuarioId || null, String(persistido.id), JSON.stringify({
        pedido_externo_id: consulta.id,
        evento_id: Number(persistido.id),
        status: persistido.status,
        idempotente,
        produtos: consulta.pedido.produtos.length
      }), opcoes.ip || null]
    );
    await connection.commit();
    return {
      ok: true,
      idempotente,
      evento_id: Number(persistido.id),
      pedido_externo_id: consulta.id,
      status: persistido.status,
      tentativas: Number(persistido.tentativas),
      analise
    };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally {
    connection.release();
  }
}

module.exports = {
  analisarPedidoWBuy,
  consultarPedidoWBuy,
  jsonCanonico,
  pedidoIdValido,
  sincronizarPedidoWBuy
};
