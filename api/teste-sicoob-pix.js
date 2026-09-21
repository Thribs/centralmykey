'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const express = require('express');
const { interpretarWebhook, prepararReferenciaPedido, processarWebhookSicoob } = require('./sicoob-pix');
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

const configBanco = {
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME
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

async function criarTabelasTemporarias(connection) {
  await connection.query(`CREATE TEMPORARY TABLE integracao_eventos (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, provedor VARCHAR(40) NOT NULL,
    evento_externo_id VARCHAR(160) NOT NULL, tipo VARCHAR(80) NOT NULL,
    referencia_externa VARCHAR(120), entidade VARCHAR(40), entidade_id BIGINT,
    lancamento_id BIGINT, pagamento_id BIGINT, payload_hash CHAR(64) NOT NULL,
    payload JSON NOT NULL, status ENUM('RECEBIDO','PROCESSADO','IGNORADO','FALHOU') DEFAULT 'RECEBIDO',
    tentativas SMALLINT UNSIGNED DEFAULT 1, erro_codigo VARCHAR(80), erro_detalhe VARCHAR(500),
    recebido_em DATETIME DEFAULT CURRENT_TIMESTAMP, processado_em DATETIME,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_evento (provedor, evento_externo_id)) ENGINE=InnoDB`);
  await connection.query(`CREATE TEMPORARY TABLE integracao_referencias_pagamento (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, provedor VARCHAR(40) NOT NULL,
    entidade VARCHAR(40) NOT NULL, entidade_id BIGINT NOT NULL,
    referencia_provedor VARCHAR(120) NOT NULL, valor DECIMAL(12,2) NOT NULL,
    moeda CHAR(3) NOT NULL DEFAULT 'BRL',
    status ENUM('PREPARADA','REGISTRADA','PAGA','CANCELADA','EXPIRADA','FALHOU') DEFAULT 'PREPARADA',
    identificador_pagamento VARCHAR(160), erro_codigo VARCHAR(80), erro_detalhe VARCHAR(500),
    criada_em DATETIME DEFAULT CURRENT_TIMESTAMP, registrada_em DATETIME, paga_em DATETIME,
    atualizada_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ref (provedor, referencia_provedor)) ENGINE=InnoDB`);
  await criarTabelaOutboxTemporaria(connection);
}

async function iniciarApi(connection) {
  const app = express();
  app.locals.autenticarToken = (req, res, next) => next();
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-integracoes')(app, poolTransacional(connection));
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const fetchOriginal = global.fetch;
  const sufixo = `${process.pid}${String(Date.now()).slice(-7)}`;
  const protocolo = `SIC${sufixo}`.slice(0, 30);
  const txid = `CMK${sufixo}ABCDEFGHIJKLMNO`.slice(0, 26);
  const txidDesconhecido = `UNK${sufixo}QRSTUVWXYZABCDE`.slice(0, 26);
  const e2e = `E${sufixo}ABCDEFGHIJKLMNOPQRSTUV`.slice(0, 32);
  let pedidoId;
  let servidor;
  let erro;
  try {
    assert.throws(() => interpretarWebhook('{'), e => e.codigo === 'JSON_INVALIDO');
    assert.throws(() => interpretarWebhook('{"pix":[]}'), e => e.codigo === 'PIX_AUSENTE');
    await connection.beginTransaction();
    await criarTabelasTemporarias(connection);
    const [[servico]] = await connection.query(
      "SELECT id, preco_base FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[cliente]] = await connection.query('SELECT id FROM clientes WHERE ativo=1 ORDER BY id LIMIT 1');
    assert.ok(servico && cliente, 'Base ativa é necessária');
    const valor = Number(servico.preco_base || 1);
    const chassi = `9BGSI11A0${String(Date.now()).slice(-8)}`;
    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE SICOOB', 2026,
               'AGUARDANDO_PAGAMENTO', ?, 0, 'BRL')`,
      [protocolo, cliente.id, servico.id, chassi, valor]
    );
    pedidoId = pedido.insertId;
    const referencia = await prepararReferenciaPedido(connection, pedidoId, txid);
    assert.strictEqual(referencia.status, 'PREPARADA');
    const referenciaRepetida = await prepararReferenciaPedido(connection, pedidoId,
      `ALT${sufixo}ABCDEFGHIJKLMNOP`.slice(0, 26));
    assert.strictEqual(referenciaRepetida.idempotente, true);
    assert.strictEqual(referenciaRepetida.txid, txid);

    const pool = poolTransacional(connection);
    const desconhecido = JSON.stringify({ pix: [{ txid: txidDesconhecido,
      endToEndId: `U${e2e.slice(1)}`, valor: valor.toFixed(2),
      horario: '2026-09-21T12:00:00Z' }] });
    const resultadoDesconhecido = await processarWebhookSicoob(pool, desconhecido);
    assert.strictEqual(resultadoDesconhecido.resultados[0].codigo, 'TXID_NAO_VINCULADO');

    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{
      id: 980000000 + (process.pid % 100000), id_montadora: 1, chassis: chassi,
      cod_mecanico: 'MEC-SICOOB', cod_immo: 'IMMO-SICOOB'
    }]) });
    const corpo = JSON.stringify({ pix: [{ txid, endToEndId: e2e,
      valor: valor.toFixed(2), horario: '2026-09-21T12:01:00Z', infoPagador: 'Pedido' }] });
    const recebido = await processarWebhookSicoob(pool, corpo);
    assert.strictEqual(recebido.ok, true);
    assert.strictEqual(recebido.resultados[0].processamento.status, 'CONCLUIDO');
    const repetido = await processarWebhookSicoob(pool, corpo);
    assert.strictEqual(repetido.resultados[0].idempotente, true);

    const [[estado]] = await connection.query(
      `SELECT p.status AS pedido_status, r.status AS referencia_status,
              r.identificador_pagamento,
              (SELECT COUNT(*) FROM pagamentos pg JOIN lancamentos_financeiros lf
                ON lf.id=pg.lancamento_id WHERE lf.pedido_senha_id=p.id) AS pagamentos,
              (SELECT COUNT(*) FROM integracao_eventos
                WHERE erro_codigo='TXID_NAO_VINCULADO') AS desconhecidos
         FROM pedidos_senha p JOIN integracao_referencias_pagamento r
           ON r.entidade_id=p.id WHERE p.id=?`,
      [pedidoId]
    );
    assert.deepStrictEqual(
      [estado.pedido_status, estado.referencia_status, estado.identificador_pagamento,
        Number(estado.pagamentos), Number(estado.desconhecidos)],
      ['CONCLUIDO', 'PAGA', e2e, 1, 1]
    );
    global.fetch = fetchOriginal;
    const api = await iniciarApi(connection);
    servidor = api.servidor;
    const resposta = await fetch(`${api.url}/api/integracoes/referencias-pagamento?provedor=SICOOB`);
    const listagem = await resposta.json();
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(listagem.total, 1);
    assert.strictEqual(listagem.dados[0].status, 'PAGA');
    assert.ok(!Object.hasOwn(listagem.dados[0], 'payload'));
  } catch (falha) {
    erro = falha;
  } finally {
    global.fetch = fetchOriginal;
    try {
      if (servidor) await new Promise((resolve, reject) =>
        servidor.close(e => e ? reject(e) : resolve()));
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo=?) AS pedidos,
                (SELECT COUNT(*) FROM pagamentos WHERE referencia_externa=?) AS pagamentos`,
        [protocolo, e2e]
      );
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0]);
    } catch (limpeza) {
      erro = erro || limpeza;
    } finally {
      await connection.end();
    }
  }
  if (erro) throw erro;
  console.log('OK: Sicoob Pix correlaciona txid, processa idempotente e reverte todos os dados');
}

executar().catch(erro => {
  console.error(`FALHA: integração Sicoob Pix: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
