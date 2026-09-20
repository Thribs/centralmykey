'use strict';

const PAPEIS = ['CLIENTE', 'COMPRADOR', 'PAGADOR'];

function texto(valor, limite) {
  const resultado = String(valor ?? '').trim();
  return resultado ? resultado.slice(0, limite) : null;
}

function normalizarParte(entrada, padrao, papel) {
  const personalizada = entrada && typeof entrada === 'object';
  const origem = personalizada ? entrada : padrao;
  const parte = {
    papel,
    cliente_id: personalizada ? null : (origem.cliente_id || null),
    nome: texto(origem.nome, 180),
    documento: texto(origem.documento, 30),
    telefone: texto(origem.telefone, 25),
    email: texto(origem.email, 180)
  };
  if (!parte.nome) {
    const erro = new Error(`Informe o nome do ${papel.toLowerCase()}`);
    erro.codigo = 'PARTE_PEDIDO_INVALIDA';
    throw erro;
  }
  if (parte.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parte.email)) {
    const erro = new Error(`E-mail do ${papel.toLowerCase()} inválido`);
    erro.codigo = 'PARTE_PEDIDO_INVALIDA';
    throw erro;
  }
  return parte;
}

function prepararPartes(cliente, comprador, pagador) {
  const base = {
    cliente_id: cliente.id,
    nome: cliente.nome,
    documento: cliente.cpf || cliente.cnpj || null,
    telefone: cliente.telefone_normalizado || cliente.telefone || null,
    email: cliente.email || null
  };
  const parteCliente = normalizarParte(base, base, 'CLIENTE');
  const parteComprador = normalizarParte(comprador, base, 'COMPRADOR');
  const partePagador = normalizarParte(pagador, parteComprador, 'PAGADOR');
  return [parteCliente, parteComprador, partePagador];
}

async function registrarPartesPedido(connection, pedidoId, partes) {
  for (const parte of partes) {
    await connection.query(
      `INSERT INTO pedido_partes
         (pedido_id, papel, cliente_id, nome, documento, telefone, email)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        pedidoId,
        parte.papel,
        parte.cliente_id,
        parte.nome,
        parte.documento,
        parte.telefone,
        parte.email
      ]
    );
  }
}

async function listarPartesPedido(connection, pedidoId, clientePadrao) {
  let linhas;
  try {
    [linhas] = await connection.query(
      `SELECT papel, cliente_id, nome, documento, telefone, email
         FROM pedido_partes
        WHERE pedido_id = ?
        ORDER BY FIELD(papel, 'CLIENTE', 'COMPRADOR', 'PAGADOR')`,
      [pedidoId]
    );
  } catch (erro) {
    if (erro.code !== 'ER_NO_SUCH_TABLE') throw erro;
    linhas = [];
  }
  const fallback = normalizarParte(clientePadrao, clientePadrao, 'CLIENTE');
  const porPapel = Object.fromEntries(linhas.map(item => [item.papel, item]));
  return Object.fromEntries(PAPEIS.map(papel => [
    papel.toLowerCase(),
    porPapel[papel] || { ...fallback, papel }
  ]));
}

module.exports = {
  PAPEIS,
  prepararPartes,
  registrarPartesPedido,
  listarPartesPedido
};
