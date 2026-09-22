'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  prepararEvento,
  processarEventoPagamentoPedido
} = require('./processar-evento-pagamento');
const { criarTabelaOutboxTemporaria } = require('./teste-suporte-outbox');

dotenv.config({ path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'), quiet: true });
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}
process.env.AMBIENTE_API_JOELPIRES = 'teste';
process.env.URL_API_JOELPIRES_TESTE = 'https://mock.joelpires.invalid';
process.env.CHAVE_API_JOELPIRES = 'credencial-ficticia';
process.env.ID_USUARIO_API_JOELPIRES = '-1';
process.env.APIJOELPIRES_ID_DISPOSITIVO = 'centralmykey';
process.env.APIJOELPIRES_TIMEOUT_MS = '1000';

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

function poolTransacional(connection) {
  return {
    query: (...args) => connection.query(...args),
    getConnection: async () => ({
      query: (...args) => connection.query(...args),
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
      release: () => {}
    })
  };
}

async function criarTabelaEventos(connection) {
  await connection.query(`
    CREATE TEMPORARY TABLE integracao_eventos (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      provedor VARCHAR(40) NOT NULL,
      evento_externo_id VARCHAR(160) NOT NULL,
      tipo VARCHAR(80) NOT NULL,
      referencia_externa VARCHAR(120) NULL,
      entidade VARCHAR(40) NULL,
      entidade_id BIGINT NULL,
      lancamento_id BIGINT NULL,
      pagamento_id BIGINT NULL,
      payload_hash CHAR(64) NOT NULL,
      payload JSON NOT NULL,
      status ENUM('RECEBIDO','PROCESSADO','IGNORADO','FALHOU') NOT NULL DEFAULT 'RECEBIDO',
      tentativas SMALLINT UNSIGNED NOT NULL DEFAULT 1,
      erro_codigo VARCHAR(80) NULL,
      erro_detalhe VARCHAR(500) NULL,
      recebido_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processado_em DATETIME NULL,
      atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_integracao_evento (provedor, evento_externo_id)
    ) ENGINE=InnoDB
  `);
}

async function iniciarApi(connection) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => { req.usuario = { id: null }; next(); };
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-integracoes')(app, poolTransacional(connection));
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function fechar(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => servidor.close(e => e ? reject(e) : resolve()));
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const fetchOriginal = global.fetch;
  const sufixo = String(Date.now()).slice(-8);
  const protocolo = `TEP${process.pid}${sufixo}`.slice(0, 30);
  const protocoloCancelado = `TEC${process.pid}${sufixo}`.slice(0, 30);
  const referencia = `E2E-TESTE-${process.pid}-${sufixo}`;
  const eventoId = `evt-sicoob-${process.pid}-${sufixo}`;
  const chassi = `9BGEV11A0${sufixo}`;
  let pedidoId;
  let pedidoCanceladoId;
  let servidor;
  let erro;
  try {
    const preparado = prepararEvento({
      provedor: 'SICOOB', evento_externo_id: 'evt-integridade',
      tipo: 'PIX_RECEBIDO', referencia_externa: 'e2e-integridade',
      pedido_id: 1, valor: 1, moeda: 'BRL',
      payload: { origem: 'objeto-divergente' },
      payload_bruto: '{"origem":"corpo-assinado"}'
    });
    assert.deepStrictEqual(preparado.payload, { origem: 'corpo-assinado' });
    await connection.beginTransaction();
    await criarTabelaEventos(connection);
    await criarTabelaOutboxTemporaria(connection);
    const [[servico]] = await connection.query(
      "SELECT id, preco_base FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[cliente]] = await connection.query(
      'SELECT id FROM clientes WHERE ativo=1 ORDER BY id LIMIT 1'
    );
    assert.ok(servico && cliente, 'Base ativa é necessária');
    const valor = Number(servico.preco_base || 1);
    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE EVENTO', 2026,
               'AGUARDANDO_PAGAMENTO', ?, 0, 'BRL')`,
      [protocolo, cliente.id, servico.id, chassi, valor]
    );
    pedidoId = pedido.insertId;
    const [pedidoCancelado] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE EVENTO CANCELADO', 2026,
               'CANCELADO', ?, 0, 'BRL')`,
      [protocoloCancelado, cliente.id, servico.id,
        `9BGEV12A0${sufixo}`, valor]
    );
    pedidoCanceladoId = pedidoCancelado.insertId;
    global.fetch = async url => {
      assert.match(String(url), /^https:\/\/mock\.joelpires\.invalid\//);
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify([{
          id: 970000000 + (process.pid % 100000), id_montadora: 1,
          chassis: chassi, cod_mecanico: 'MEC-EVENTO', cod_immo: 'IMMO-EVENTO'
        }])
      };
    };
    const pool = poolTransacional(connection);
    const dados = {
      provedor: 'SICOOB', evento_externo_id: eventoId,
      tipo: 'PIX_RECEBIDO', referencia_externa: referencia,
      pedido_id: pedidoId, valor, moeda: 'BRL',
      payload: { endToEndId: referencia, txid: protocolo, valor: valor.toFixed(2) },
      payload_bruto: JSON.stringify({ endToEndId: referencia, txid: protocolo,
        valor: valor.toFixed(2) })
    };
    const primeira = await processarEventoPagamentoPedido(pool, dados);
    assert.strictEqual(primeira.ok, true);
    assert.strictEqual(primeira.status, 'PROCESSADO');
    assert.strictEqual(primeira.processamento.status, 'CONCLUIDO');
    const [[ultimoHistorico]] = await connection.query(
      `SELECT tipo FROM pedido_historico
        WHERE pedido_id = ? ORDER BY id DESC LIMIT 1`,
      [pedidoId]
    );
    assert.strictEqual(
      ultimoHistorico.tipo,
      'PROCESSADO_APOS_PAGAMENTO',
      'O resultado deve suceder o histórico do pagamento externo'
    );

    const repetida = await processarEventoPagamentoPedido(pool, dados);
    assert.strictEqual(repetida.idempotente, true);
    assert.strictEqual(repetida.pagamento_id, primeira.pagamento_id);

    const eventoRepetido = await processarEventoPagamentoPedido(pool, {
      ...dados, evento_externo_id: `${eventoId}-reentrega`
    });
    assert.strictEqual(eventoRepetido.idempotente, true);
    assert.strictEqual(eventoRepetido.pagamento_id, primeira.pagamento_id);

    await assert.rejects(
      () => processarEventoPagamentoPedido(pool, {
        ...dados,
        payload: { adulterado: true },
        payload_bruto: JSON.stringify({ adulterado: true })
      }),
      e => e.codigo === 'COLISAO_EVENTO_EXTERNO' && e.status === 409
    );

    const divergente = await processarEventoPagamentoPedido(pool, {
      ...dados,
      evento_externo_id: `${eventoId}-valor`,
      referencia_externa: `${referencia}-valor`,
      valor: valor + 1,
      payload: { valor: (valor + 1).toFixed(2) },
      payload_bruto: JSON.stringify({ valor: (valor + 1).toFixed(2) })
    });
    assert.strictEqual(divergente.status, 'FALHOU');
    assert.strictEqual(divergente.codigo, 'VALOR_OU_MOEDA_DIVERGENTE');

    const pagamentoAposCancelamento = await processarEventoPagamentoPedido(pool, {
      ...dados,
      evento_externo_id: `${eventoId}-cancelado`,
      referencia_externa: `${referencia}-cancelado`,
      pedido_id: pedidoCanceladoId,
      payload: { pedido: protocoloCancelado },
      payload_bruto: JSON.stringify({ pedido: protocoloCancelado })
    });
    assert.strictEqual(pagamentoAposCancelamento.status, 'FALHOU');
    assert.strictEqual(
      pagamentoAposCancelamento.codigo,
      'PAGAMENTO_APOS_CANCELAMENTO_REQUER_ESTORNO'
    );
    assert.ok(pagamentoAposCancelamento.pagamento_id);

    const [[financeiro]] = await connection.query(
      `SELECT
        (SELECT COUNT(*) FROM pagamentos pg JOIN lancamentos_financeiros lf
          ON lf.id=pg.lancamento_id WHERE lf.pedido_senha_id=?) AS pagamentos,
        (SELECT COUNT(*) FROM lancamentos_financeiros
          WHERE pedido_senha_id=? AND origem='INTEGRACAO_SICOOB') AS lancamentos,
        (SELECT COUNT(*) FROM pagamentos pg JOIN lancamentos_financeiros lf
          ON lf.id=pg.lancamento_id WHERE lf.pedido_senha_id=?) AS pagamentos_cancelado,
        (SELECT COUNT(*) FROM lancamentos_financeiros
          WHERE pedido_senha_id=? AND origem='INTEGRACAO_SICOOB') AS lancamentos_cancelado,
        (SELECT COUNT(*) FROM pedidos_senha
          WHERE id=? AND status='CANCELADO') AS pedido_permanece_cancelado,
        (SELECT COUNT(*) FROM pedido_historico
          WHERE pedido_id=? AND tipo='PAGAMENTO_APOS_CANCELAMENTO') AS historico_excecao`,
      [pedidoId, pedidoId, pedidoCanceladoId, pedidoCanceladoId,
        pedidoCanceladoId, pedidoCanceladoId]
    );
    const [[eventos]] = await connection.query(
      `SELECT SUM(status='PROCESSADO') AS processados,
              SUM(status='FALHOU') AS falhos
         FROM integracao_eventos`
    );
    assert.deepStrictEqual(
      [...Object.values(financeiro), ...Object.values(eventos)].map(Number),
      [1, 1, 1, 1, 1, 1, 2, 2]
    );

    global.fetch = fetchOriginal;
    const api = await iniciarApi(connection);
    servidor = api.servidor;
    const resposta = await fetch(`${api.url}/api/integracoes/eventos?provedor=SICOOB`);
    const corpo = await resposta.json();
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(corpo.total, 4);
    assert.ok(corpo.dados.every(item => !Object.hasOwn(item, 'payload')),
      'Consulta administrativa não deve expor payload');
    const eventoProcessado = corpo.dados.find(item => item.pagamento_id);
    assert.strictEqual(Number(eventoProcessado.valor_pagamento), valor);
    assert.strictEqual(eventoProcessado.moeda_pagamento, 'BRL');
  } catch (falha) {
    erro = falha;
  } finally {
    global.fetch = fetchOriginal;
    try {
      await fechar(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
          (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo IN (?, ?)) AS pedidos,
          (SELECT COUNT(*) FROM pagamentos WHERE referencia_externa LIKE ?) AS pagamentos,
          (SELECT COUNT(*) FROM lancamentos_financeiros
            WHERE pedido_senha_id=?) AS lancamentos`,
        [protocolo, protocoloCancelado, `${referencia}%`, pedidoId || -1]
      );
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0, 0],
        'Rollback deve remover pedido e efeitos financeiros fictícios');
    } catch (limpeza) {
      erro = erro || limpeza;
    } finally {
      await connection.end();
    }
  }
  if (erro) throw erro;
  console.log('OK: eventos financeiros são idempotentes e transacionais (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: eventos de integração: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
