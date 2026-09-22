'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { criarTabelaOutboxTemporaria } = require('./teste-suporte-outbox');
const {
  criarTabelaEstornosTemporaria
} = require('./teste-suporte-estornos');
const {
  criarTabelaReferenciasPagamentoTemporaria
} = require('./teste-suporte-referencias-pagamento');

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

function poolComSavepoints(connection) {
  let sequencia = 0;
  return {
    getConnection: async () => {
      const nome = `teste_estorno_${++sequencia}`;
      let aberto = false;
      return {
        query: (...args) => connection.query(...args),
        beginTransaction: async () => {
          await connection.query(`SAVEPOINT ${nome}`);
          aberto = true;
        },
        commit: async () => {
          if (aberto) await connection.query(`RELEASE SAVEPOINT ${nome}`);
          aberto = false;
        },
        rollback: async () => {
          if (!aberto) return;
          await connection.query(`ROLLBACK TO SAVEPOINT ${nome}`);
          await connection.query(`RELEASE SAVEPOINT ${nome}`);
          aberto = false;
        },
        release: () => {}
      };
    },
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
  require('./rotas-estornos')(app, poolComSavepoints(connection));
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

async function postar(url, corpo) {
  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo)
  });
  return { resposta, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const marcador = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const prefixo = `TE${process.pid}${String(Date.now()).slice(-5)}`;
  const referenciaOriginal = `REF-ORIG-${marcador}`;
  const referenciaEstorno = `REF-EST-${marcador}`;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);
    await criarTabelaEstornosTemporaria(connection);
    await criarTabelaReferenciasPagamentoTemporaria(connection);
    await connection.query(`CREATE TEMPORARY TABLE integracao_eventos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      provedor VARCHAR(40) NOT NULL,
      evento_externo_id VARCHAR(160) NOT NULL,
      tipo VARCHAR(80) NOT NULL,
      referencia_externa VARCHAR(120),
      entidade VARCHAR(40), entidade_id BIGINT,
      lancamento_id BIGINT, pagamento_id BIGINT,
      payload_hash CHAR(64) NOT NULL, payload JSON NOT NULL,
      status ENUM('RECEBIDO','PROCESSADO','IGNORADO','FALHOU') NOT NULL,
      tentativas SMALLINT UNSIGNED DEFAULT 1,
      erro_codigo VARCHAR(80), erro_detalhe VARCHAR(500),
      recebido_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      processado_em DATETIME, atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_evento (provedor, evento_externo_id)
    ) ENGINE=InnoDB`);
    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[usuario]] = await connection.query(
      "SELECT id, nome FROM usuarios WHERE status='ATIVO' ORDER BY id LIMIT 1"
    );
    assert.ok(servico && usuario, 'Serviço e usuário ativos são obrigatórios');

    const telefone = `5585${String(Date.now()).slice(-8)}`;
    const [cliente] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, credito_status)
       VALUES (?, ?, ?, 'COMPLETO', 1, 'ANTECIPADO', 'LIBERADO')`,
      [`CLIENTE ESTORNO ${marcador}`, telefone, telefone]
    );
    const [fornecedor] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, '5511666666666', 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [`FORNECEDOR ESTORNO ${marcador}`]
    );

    async function criarPedidoPago(
      sufixo,
      comFornecedor = false,
      origem = 'CONFIRMACAO_MANUAL'
    ) {
      const [pedido] = await connection.query(
        `INSERT INTO pedidos_senha
           (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
            status, valor_venda, custo, moeda, fornecedor_id, origem_id)
         VALUES (?, ?, ?, ?, 'GM', 'TESTE ESTORNO', 2026,
                 'ABERTO', 50, ?, 'BRL', ?, ?)`,
        [
          `${prefixo}-${sufixo}`,
          cliente.insertId,
          servico.id,
          `9BGES${sufixo.padEnd(3, '0')}0${String(Date.now()).slice(-8)}`,
          comFornecedor ? 22 : 0,
          comFornecedor ? fornecedor.insertId : null,
          comFornecedor ? 2 : null
        ]
      );
      const [lancamento] = await connection.query(
        `INSERT INTO lancamentos_financeiros
           (tipo, cliente_id, pedido_senha_id, descricao, valor, moeda,
            data_competencia, status, origem, criado_por)
         VALUES ('RECEITA', ?, ?, 'PAGAMENTO TESTE ESTORNO', 50, 'BRL',
                 CURDATE(), 'RECEBIDO', ?, ?)`,
        [cliente.insertId, pedido.insertId, origem, usuario.id]
      );
      const [pagamento] = await connection.query(
        `INSERT INTO pagamentos
           (lancamento_id, valor, moeda, data_pagamento, meio_pagamento,
            referencia_externa, observacao, registrado_por)
         VALUES (?, 50, 'BRL', NOW(), ?, ?, 'TESTE', ?)`,
        [lancamento.insertId,
          origem.startsWith('INTEGRACAO_') ? 'SICOOB' : 'PIX',
          `${referenciaOriginal}-${sufixo}`, usuario.id]
      );
      return { pedidoId: pedido.insertId, pagamentoId: pagamento.insertId };
    }

    const cancelavel = await criarPedidoPago('OK');
    const bloqueado = await criarPedidoPago('BLQ', true);
    const externoCancelado = await criarPedidoPago(
      'EXT',
      false,
      'INTEGRACAO_SICOOB'
    );
    await connection.query(
      "UPDATE pedidos_senha SET status='CANCELADO' WHERE id=?",
      [externoCancelado.pedidoId]
    );
    await connection.query(
      `INSERT INTO integracao_eventos
         (provedor, evento_externo_id, tipo, referencia_externa,
          entidade, entidade_id, lancamento_id, pagamento_id,
          payload_hash, payload, status, erro_codigo, erro_detalhe)
       SELECT 'SICOOB', ?, 'PIX_RECEBIDO', pg.referencia_externa,
              'PEDIDO', ?, pg.lancamento_id, pg.id,
              REPEAT('a', 64), JSON_OBJECT(), 'FALHOU',
              'PAGAMENTO_APOS_CANCELAMENTO_REQUER_ESTORNO',
              'Pagamento recebido após o cancelamento do pedido'
         FROM pagamentos pg WHERE pg.id=?`,
      [`evt-estorno-externo-${marcador}`,
        externoCancelado.pedidoId, externoCancelado.pagamentoId]
    );
    await connection.query(
      `INSERT INTO comunicacoes_outbox
         (chave_idempotencia, canal, finalidade, pedido_id,
          fornecedor_id, destinatario, payload, status,
          mensagem_externa_id, enviado_em)
       VALUES (?, 'WHATSAPP', 'CONSULTA_FORNECEDOR', ?, ?,
               '5511666666666', JSON_OBJECT(), 'ENVIADA', ?, NOW())`,
      [
        `CONSULTA_FORNECEDOR:${bloqueado.pedidoId}:${fornecedor.insertId}`,
        bloqueado.pedidoId,
        fornecedor.insertId,
        `wamid.estorno.${marcador}`
      ]
    );

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;
    const dados = {
      meio_estorno: 'PIX',
      referencia_externa: referenciaEstorno,
      motivo_estorno: 'Devolução integral confirmada ao cliente',
      motivo_cancelamento: 'Pedido cancelado após devolução integral'
    };

    const invalido = await postar(
      `${api.url}/api/pedidos/${cancelavel.pedidoId}/estornar-e-cancelar`,
      { ...dados, referencia_externa: null, comprovante_url: null }
    );
    assert.strictEqual(invalido.resposta.status, 400);
    assert.strictEqual(invalido.corpo.codigo, 'COMPROVANTE_ESTORNO_OBRIGATORIO');

    const concluido = await postar(
      `${api.url}/api/pedidos/${cancelavel.pedidoId}/estornar-e-cancelar`,
      dados
    );
    assert.strictEqual(concluido.resposta.status, 200);
    assert.strictEqual(concluido.corpo.estorno.idempotente, false);
    assert.strictEqual(concluido.corpo.cancelamento.status, 'CANCELADO');

    const repetido = await postar(
      `${api.url}/api/pedidos/${cancelavel.pedidoId}/estornar-e-cancelar`,
      dados
    );
    assert.strictEqual(repetido.resposta.status, 200);
    assert.strictEqual(repetido.corpo.estorno.idempotente, true);
    assert.strictEqual(repetido.corpo.cancelamento.idempotente, true);

    const divergente = await postar(
      `${api.url}/api/pedidos/${cancelavel.pedidoId}/estornar-pagamento`,
      { ...dados, referencia_externa: `${referenciaEstorno}-OUTRA` }
    );
    assert.strictEqual(divergente.resposta.status, 409);
    assert.strictEqual(divergente.corpo.codigo, 'ESTORNO_DIVERGENTE');

    const estornoExterno = await postar(
      `${api.url}/api/pedidos/${externoCancelado.pedidoId}/estornar-pagamento`,
      {
        ...dados,
        referencia_externa: `${referenciaEstorno}-EXT`,
        motivo_estorno: 'Devolução de pagamento recebido após cancelamento'
      }
    );
    assert.strictEqual(estornoExterno.resposta.status, 200);
    assert.strictEqual(estornoExterno.corpo.estorno.idempotente, false);
    assert.strictEqual(estornoExterno.corpo.estorno.status, 'CONFIRMADO');
    assert.strictEqual(estornoExterno.corpo.estorno.eventos_resolvidos, 1);

    const recusado = await postar(
      `${api.url}/api/pedidos/${bloqueado.pedidoId}/estornar-e-cancelar`,
      { ...dados, referencia_externa: `${referenciaEstorno}-BLQ` }
    );
    assert.strictEqual(recusado.resposta.status, 409);
    assert.strictEqual(
      recusado.corpo.codigo,
      'CUSTO_FORNECEDOR_REQUER_DECISAO'
    );

    const [[estado]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM estornos_pagamentos
           WHERE pedido_senha_id IN (?, ?) AND status='CONFIRMADO') AS estornos,
         (SELECT COUNT(*) FROM lancamentos_financeiros
           WHERE pedido_senha_id = ? AND tipo = 'DESPESA'
             AND origem = 'ESTORNO_MANUAL' AND status = 'PAGO') AS despesas,
         (SELECT COUNT(*) FROM pagamentos pg
           INNER JOIN lancamentos_financeiros lf ON lf.id = pg.lancamento_id
          WHERE lf.pedido_senha_id = ?) AS pagamentos,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo IN
             ('PAGAMENTO_ESTORNADO','PEDIDO_CANCELADO')) AS historicos,
         (SELECT COUNT(*) FROM pedidos_senha
           WHERE id = ? AND status = 'CANCELADO') AS cancelado,
         (SELECT COUNT(*) FROM lancamentos_financeiros
           WHERE pedido_senha_id = ? AND origem = 'ESTORNO_MANUAL') AS despesas_bloqueadas,
         (SELECT COUNT(*) FROM pedidos_senha
           WHERE id = ? AND status <> 'CANCELADO') AS bloqueado_preservado,
         (SELECT COUNT(*) FROM pedidos_senha
           WHERE id = ? AND status='CANCELADO') AS externo_permanece_cancelado,
         (SELECT COUNT(*) FROM integracao_eventos
           WHERE pagamento_id=? AND status='IGNORADO'
             AND erro_codigo='PAGAMENTO_ESTORNADO') AS evento_resolvido`,
      [
        cancelavel.pedidoId,
        externoCancelado.pedidoId,
        cancelavel.pedidoId,
        cancelavel.pedidoId,
        cancelavel.pedidoId,
        cancelavel.pedidoId,
        bloqueado.pedidoId,
        bloqueado.pedidoId,
        externoCancelado.pedidoId,
        externoCancelado.pagamentoId
      ]
    );
    assert.deepStrictEqual(
      Object.values(estado).map(Number),
      [2, 1, 2, 2, 1, 0, 1, 1, 1]
    );
    const [[estornoBloqueado]] = await connection.query(
      `SELECT COUNT(*) AS quantidade
         FROM estornos_pagamentos
        WHERE pedido_senha_id = ?`,
      [bloqueado.pedidoId]
    );
    assert.strictEqual(Number(estornoBloqueado.quantidade), 0);
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
           (SELECT COUNT(*) FROM pagamentos
             WHERE referencia_externa LIKE ?) AS pagamentos`,
        [
          `${prefixo}%`,
          `CLIENTE ESTORNO ${marcador}`,
          `FORNECEDOR ESTORNO ${marcador}`,
          `${referenciaEstorno}%`
        ]
      );
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0, 0, 0]);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: estorno manual e cancelamento são atômicos e idempotentes (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de estorno e cancelamento: ${erro.message}`);
  process.exitCode = 1;
});
