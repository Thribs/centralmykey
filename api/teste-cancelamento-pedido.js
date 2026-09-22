'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  criarTabelaOutboxTemporaria
} = require('./teste-suporte-outbox');
const {
  criarTabelaEstornosTemporaria
} = require('./teste-suporte-estornos');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

function poolTransacional(connection) {
  return {
    getConnection: async () => ({
      query: (...args) => connection.query(...args),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {}
    }),
    query: (...args) => connection.query(...args)
  };
}

async function iniciarApi(connection, usuario) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = usuario;
    next();
  };
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-pedidos')(app, poolTransacional(connection));
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return {
    servidor,
    url: `http://127.0.0.1:${servidor.address().port}`
  };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

async function cancelar(url, pedidoId, motivo = 'Cancelamento de teste') {
  const resposta = await fetch(`${url}/api/pedidos/${pedidoId}/cancelar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ motivo })
  });
  return { resposta, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const marcador = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const prefixo = `TC${process.pid}${String(Date.now()).slice(-5)}`;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);
    await criarTabelaEstornosTemporaria(connection);
    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[usuario]] = await connection.query(
      "SELECT id, nome FROM usuarios WHERE status='ATIVO' ORDER BY id LIMIT 1"
    );
    assert.ok(servico && usuario, 'Serviço e usuário ativos são obrigatórios');

    const telefone = `5595${String(Date.now()).slice(-8)}`;
    const [cliente] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, credito_status)
       VALUES (?, ?, ?, 'COMPLETO', 1, 'ANTECIPADO', 'LIBERADO')`,
      [`CLIENTE CANCELAMENTO ${marcador}`, telefone, telefone]
    );
    const [fornecedor] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, '5511444444444', 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [`FORNECEDOR CANCELAMENTO ${marcador}`]
    );

    async function criarPedido(sufixo, status, fornecedorId = null, custo = 0) {
      const [registro] = await connection.query(
        `INSERT INTO pedidos_senha
           (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
            status, valor_venda, custo, moeda, fornecedor_id, origem_id)
         VALUES (?, ?, ?, ?, 'GM', 'TESTE CANCELAMENTO', 2026,
                 ?, 50, ?, 'BRL', ?, ?)`,
        [
          `${prefixo}-${sufixo}`,
          cliente.insertId,
          servico.id,
          `9BGCA${sufixo.padEnd(3, '0')}0${String(Date.now()).slice(-8)}`,
          status,
          custo,
          fornecedorId,
          fornecedorId ? 2 : null
        ]
      );
      return registro.insertId;
    }

    const pedidoAberto = await criarPedido('A', 'AGUARDANDO_PAGAMENTO');
    const pedidoFaturado = await criarPedido(
      'F',
      'EM_CONSULTA',
      fornecedor.insertId,
      22
    );
    const pedidoFaturaRestante = await criarPedido('R', 'ABERTO');
    const pedidoEnviado = await criarPedido(
      'E',
      'EM_CONSULTA',
      fornecedor.insertId,
      22
    );
    const pedidoPago = await criarPedido('P', 'ABERTO');

    const [fatura] = await connection.query(
      `INSERT INTO faturas_clientes
         (cliente_id, periodo_inicio, periodo_fim, vencimento,
          moeda, valor_total, status)
       VALUES (?, CURDATE(), CURDATE(), CURDATE(), 'BRL', 999, 'ABERTA')`,
      [cliente.insertId]
    );
    await connection.query(
      `INSERT INTO fatura_itens (fatura_id, pedido_senha_id, valor)
       VALUES (?, ?, 50), (?, ?, 30)`,
      [
        fatura.insertId,
        pedidoFaturado,
        fatura.insertId,
        pedidoFaturaRestante
      ]
    );

    for (const [pedidoId, status] of [
      [pedidoFaturado, 'PENDENTE'],
      [pedidoEnviado, 'ENVIADA']
    ]) {
      await connection.query(
        `INSERT INTO comunicacoes_outbox
           (chave_idempotencia, canal, finalidade, pedido_id,
            fornecedor_id, destinatario, payload, status,
            mensagem_externa_id, enviado_em)
         VALUES (?, 'WHATSAPP', 'CONSULTA_FORNECEDOR', ?, ?,
                 '5511444444444', JSON_OBJECT(), ?, ?, ?)`,
        [
          `CONSULTA_FORNECEDOR:${pedidoId}:${fornecedor.insertId}`,
          pedidoId,
          fornecedor.insertId,
          status,
          status === 'ENVIADA' ? `wamid.cancel.${marcador}` : null,
          status === 'ENVIADA' ? new Date() : null
        ]
      );
    }

    const [lancamento] = await connection.query(
      `INSERT INTO lancamentos_financeiros
         (tipo, cliente_id, pedido_senha_id, descricao, valor, moeda,
          data_competencia, status, origem, criado_por)
       VALUES ('RECEITA', ?, ?, 'PAGAMENTO TESTE', 50, 'BRL',
               CURDATE(), 'RECEBIDO', 'CONFIRMACAO_MANUAL', ?)`,
      [cliente.insertId, pedidoPago, usuario.id]
    );
    await connection.query(
      `INSERT INTO pagamentos
         (lancamento_id, valor, moeda, data_pagamento, meio_pagamento,
          referencia_externa, observacao, registrado_por)
       VALUES (?, 50, 'BRL', NOW(), 'PIX', ?, 'TESTE', ?)`,
      [lancamento.insertId, `REF-CANCEL-${marcador}`, usuario.id]
    );

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;

    const aberto = await cancelar(api.url, pedidoAberto);
    assert.strictEqual(aberto.resposta.status, 200);
    assert.strictEqual(aberto.corpo.cancelamento.status, 'CANCELADO');
    assert.strictEqual(aberto.corpo.cancelamento.idempotente, false);
    const repetido = await cancelar(api.url, pedidoAberto);
    assert.strictEqual(repetido.resposta.status, 200);
    assert.strictEqual(repetido.corpo.cancelamento.idempotente, true);

    const faturado = await cancelar(api.url, pedidoFaturado);
    assert.strictEqual(faturado.resposta.status, 200);
    assert.deepStrictEqual(
      faturado.corpo.cancelamento.faturas_ajustadas,
      [fatura.insertId]
    );
    const [[faturaDepoisPrimeiroCancelamento]] = await connection.query(
      `SELECT status, valor_total,
              (SELECT COUNT(*) FROM fatura_itens WHERE fatura_id = ?) AS itens
         FROM faturas_clientes
        WHERE id = ?`,
      [fatura.insertId, fatura.insertId]
    );
    assert.strictEqual(faturaDepoisPrimeiroCancelamento.status, 'ABERTA');
    assert.strictEqual(Number(faturaDepoisPrimeiroCancelamento.valor_total), 30);
    assert.strictEqual(Number(faturaDepoisPrimeiroCancelamento.itens), 1);

    const restante = await cancelar(api.url, pedidoFaturaRestante);
    assert.strictEqual(restante.resposta.status, 200);
    assert.deepStrictEqual(
      restante.corpo.cancelamento.faturas_ajustadas,
      [fatura.insertId]
    );

    const enviado = await cancelar(api.url, pedidoEnviado);
    assert.strictEqual(enviado.resposta.status, 409);
    assert.strictEqual(
      enviado.corpo.codigo,
      'CUSTO_FORNECEDOR_REQUER_DECISAO'
    );
    const pago = await cancelar(api.url, pedidoPago);
    assert.strictEqual(pago.resposta.status, 409);
    assert.strictEqual(pago.corpo.codigo, 'ESTORNO_FINANCEIRO_NECESSARIO');

    const [[estado]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM pedidos_senha
           WHERE id IN (?, ?, ?) AND status = 'CANCELADO') AS cancelados,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'PEDIDO_CANCELADO') AS historicos,
         (SELECT COUNT(*) FROM auditoria
           WHERE entidade = 'pedidos_senha' AND entidade_id = ?
             AND acao = 'CANCELAR') AS auditorias,
         (SELECT COUNT(*) FROM fatura_itens
           WHERE pedido_senha_id = ?) AS itens_fatura,
         (SELECT COUNT(*) FROM faturas_clientes
           WHERE id = ? AND valor_total = 0 AND status = 'CANCELADA') AS fatura_ajustada,
         (SELECT COUNT(*) FROM comunicacoes_outbox
           WHERE pedido_id = ? AND status = 'CANCELADA') AS comunicacoes_canceladas,
         (SELECT COUNT(*) FROM pedidos_senha
           WHERE id IN (?, ?) AND status <> 'CANCELADO') AS bloqueados_preservados`,
      [
        pedidoAberto,
        pedidoFaturado,
        pedidoFaturaRestante,
        pedidoAberto,
        String(pedidoAberto),
        pedidoFaturado,
        fatura.insertId,
        pedidoFaturado,
        pedidoEnviado,
        pedidoPago
      ]
    );
    assert.deepStrictEqual(
      Object.values(estado).map(Number),
      [3, 1, 1, 0, 1, 1, 2]
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo LIKE ?) AS pedidos,
           (SELECT COUNT(*) FROM clientes WHERE nome = ?) AS clientes,
           (SELECT COUNT(*) FROM fornecedores WHERE nome = ?) AS fornecedores,
           (SELECT COUNT(*) FROM pagamentos WHERE referencia_externa = ?) AS pagamentos`,
        [
          `${prefixo}%`,
          `CLIENTE CANCELAMENTO ${marcador}`,
          `FORNECEDOR CANCELAMENTO ${marcador}`,
          `REF-CANCEL-${marcador}`
        ]
      );
      assert.deepStrictEqual(
        Object.values(residuos).map(Number),
        [0, 0, 0, 0],
        'Rollback deve remover todos os dados fictícios do cancelamento'
      );
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: cancelamento seguro ajusta pendências e bloqueia obrigações externas (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de cancelamento: ${erro.message}`);
  process.exitCode = 1;
});
