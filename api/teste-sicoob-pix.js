'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const express = require('express');
const { interpretarWebhook } = require('./sicoob-pix');
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
    moeda CHAR(3) NOT NULL DEFAULT 'BRL', expiracao_segundos INT UNSIGNED,
    solicitacao_pagador VARCHAR(140),
    status ENUM('PREPARADA','REGISTRADA','PAGA','CANCELADA','EXPIRADA','FALHOU') DEFAULT 'PREPARADA',
    identificador_pagamento VARCHAR(160), location VARCHAR(500), pix_copia_cola TEXT,
    erro_codigo VARCHAR(80), erro_detalhe VARCHAR(500),
    criada_em DATETIME DEFAULT CURRENT_TIMESTAMP, registrada_em DATETIME, paga_em DATETIME,
    atualizada_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ref (provedor, referencia_provedor)) ENGINE=InnoDB`);
  await criarTabelaOutboxTemporaria(connection);
}

async function iniciarApi(connection, opcoes = {}) {
  const app = express();
  app.use(express.json({
    verify: (req, res, buffer) => { req.rawBody = buffer; }
  }));
  app.locals.autenticarToken = (req, res, next) => next();
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-integracoes')(app, poolTransacional(connection), opcoes);
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
  let txid;
  let txidRenovado;
  const txidDesconhecido = `UNK${sufixo}QRSTUVWXYZABCDE`.slice(0, 26);
  const e2e = `E${sufixo}ABCDEFGHIJKLMNOPQRSTUV`.slice(0, 32);
  let pedidoId;
  let servidor;
  let api;
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
    const chamadasSicoob = [];
    api = await iniciarApi(connection, {
      configuracaoSicoob: {
        habilitado: true, webhookHabilitado: true,
        clientId: 'cliente-teste', clientSecret: 'segredo-teste',
        certPath: '/certificado/ficticio', keyPath: '/chave/ficticia', chavePix: 'pix@teste.invalid',
        tokenUrl: 'https://api-homol.sicoob.com.br/cooperado/pix/token',
        apiUrl: 'https://api-homol.sicoob.com.br/cooperado/pix/api/v2', scope: 'cob.write'
      },
      transporteSicoob: async requisicao => {
        chamadasSicoob.push(requisicao);
        if (requisicao.url.endsWith('/token')) {
          return { status: 200, body: JSON.stringify({ access_token: 'token-ficticio' }) };
        }
        const txidRemoto = requisicao.url.split('/').pop();
        if (!txid) txid = txidRemoto;
        else if (txidRemoto !== txid && !txidRenovado) txidRenovado = txidRemoto;
        assert.ok([txid, txidRenovado].includes(txidRemoto));
        return { status: 201, body: JSON.stringify({ txid: txidRemoto,
          location: `pix.sicoob.test/${txidRemoto}`,
          pixCopiaECola: `PIX-FICTICIO-${txidRemoto}` }) };
      }
    });
    servidor = api.servidor;
    const respostaStatus = await fetch(`${api.url}/api/pagamentos/sicoob/status`);
    const statusSicoob = await respostaStatus.json();
    assert.strictEqual(respostaStatus.status, 200);
    assert.deepStrictEqual(statusSicoob,
      { ok: true, disponivel: true, codigo: 'PRONTO' });
    assert.ok(!JSON.stringify(statusSicoob).includes('segredo-teste'));
    const respostaCobranca = await fetch(`${api.url}/api/pedidos/${pedidoId}/pagamentos/sicoob`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expiracao_segundos: 1800 })
    });
    const cobranca = await respostaCobranca.json();
    assert.strictEqual(respostaCobranca.status, 201);
    assert.strictEqual(cobranca.status, 'REGISTRADA');
    assert.strictEqual(cobranca.txid, txid);
    assert.strictEqual(chamadasSicoob.length, 2);
    assert.ok(chamadasSicoob[0].body.includes('grant_type=client_credentials'));
    assert.strictEqual(JSON.parse(chamadasSicoob[1].body).valor.original, valor.toFixed(2));
    const respostaCobrancaRepetida = await fetch(
      `${api.url}/api/pedidos/${pedidoId}/pagamentos/sicoob`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      }
    );
    const cobrancaRepetida = await respostaCobrancaRepetida.json();
    assert.strictEqual(respostaCobrancaRepetida.status, 201);
    assert.strictEqual(cobrancaRepetida.idempotente, true);
    assert.strictEqual(cobrancaRepetida.registrada_agora, false);
    assert.strictEqual(chamadasSicoob.length, 4);
    assert.strictEqual(JSON.parse(chamadasSicoob[3].body).calendario.expiracao, 1800);

    await connection.query(
      `UPDATE integracao_referencias_pagamento
          SET criada_em=DATE_SUB(NOW(), INTERVAL 1801 SECOND)
        WHERE provedor='SICOOB' AND referencia_provedor=?`,
      [txid]
    );
    const respostaRenovada = await fetch(
      `${api.url}/api/pedidos/${pedidoId}/pagamentos/sicoob`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expiracao_segundos: 1800 })
      }
    );
    const renovada = await respostaRenovada.json();
    assert.strictEqual(respostaRenovada.status, 201);
    assert.strictEqual(renovada.idempotente, false);
    assert.strictEqual(renovada.txid, txidRenovado);
    assert.notStrictEqual(txidRenovado, txid);
    assert.strictEqual(chamadasSicoob.length, 6);
    const [[referenciasAntesPagamento]] = await connection.query(
      `SELECT
         SUM(status='EXPIRADA') AS expiradas,
         SUM(status='REGISTRADA') AS registradas,
         COUNT(*) AS total
       FROM integracao_referencias_pagamento
       WHERE provedor='SICOOB' AND entidade_id=?`,
      [pedidoId]
    );
    assert.deepStrictEqual(
      Object.values(referenciasAntesPagamento).map(Number),
      [1, 1, 2]
    );
    txid = txidRenovado;

    const desconhecido = JSON.stringify({ pix: [{ txid: txidDesconhecido,
      endToEndId: `U${e2e.slice(1)}`, valor: valor.toFixed(2),
      horario: '2026-09-21T12:00:00Z' }] });
    const semCertificado = await fetch(`${api.url}/webhooks/sicoob`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: desconhecido
    });
    assert.strictEqual(semCertificado.status, 401);
    assert.strictEqual((await semCertificado.json()).codigo, 'CERTIFICADO_CLIENTE_INVALIDO');
    const comCertificado = await fetch(`${api.url}/webhooks/sicoob`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-client-cert-verify': 'SUCCESS' }, body: desconhecido
    });
    const resultadoDesconhecido = await comCertificado.json();
    assert.strictEqual(comCertificado.status, 200);
    assert.strictEqual(resultadoDesconhecido.resultados[0].codigo, 'TXID_NAO_VINCULADO');

    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{
      id: 980000000 + (process.pid % 100000), id_montadora: 1, chassis: chassi,
      cod_mecanico: 'MEC-SICOOB', cod_immo: 'IMMO-SICOOB'
    }]) });
    const corpo = JSON.stringify({ pix: [{ txid, endToEndId: e2e,
      valor: valor.toFixed(2), horario: '2026-09-21T12:01:00Z', infoPagador: 'Pedido' }] });
    const respostaWebhook = await fetchOriginal(`${api.url}/webhooks/sicoob`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-client-cert-verify': 'SUCCESS' }, body: corpo
    });
    const recebido = await respostaWebhook.json();
    assert.strictEqual(respostaWebhook.status, 200);
    assert.strictEqual(recebido.ok, true);
    assert.strictEqual(recebido.resultados[0].processamento.status, 'CONCLUIDO');
    const respostaRepetida = await fetchOriginal(`${api.url}/webhooks/sicoob/pix`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-client-cert-verify': 'SUCCESS' }, body: corpo
    });
    const repetido = await respostaRepetida.json();
    assert.strictEqual(repetido.resultados[0].idempotente, true);

    const [[estado]] = await connection.query(
      `SELECT p.status AS pedido_status, r.status AS referencia_status,
              r.identificador_pagamento,
              (SELECT COUNT(*) FROM pagamentos pg JOIN lancamentos_financeiros lf
                ON lf.id=pg.lancamento_id WHERE lf.pedido_senha_id=p.id) AS pagamentos,
              (SELECT COUNT(*) FROM integracao_eventos
                WHERE erro_codigo='TXID_NAO_VINCULADO') AS desconhecidos,
              (SELECT COUNT(*) FROM pedido_historico
                WHERE pedido_id=p.id AND tipo='COBRANCA_SICOOB_REGISTRADA') AS historicos_cobranca,
              (SELECT COUNT(*) FROM pedido_historico
                WHERE pedido_id=p.id AND tipo='COBRANCA_SICOOB_EXPIRADA') AS historicos_expiracao,
              (SELECT COUNT(*) FROM auditoria
                WHERE entidade='pedidos_senha' AND entidade_id=CAST(p.id AS CHAR)
                  AND acao='EXPIRAR_COBRANCA_SICOOB') AS auditorias_expiracao
         FROM pedidos_senha p JOIN integracao_referencias_pagamento r
           ON r.entidade_id=p.id AND r.referencia_provedor=? WHERE p.id=?`,
      [txid, pedidoId]
    );
    assert.deepStrictEqual(
      [estado.pedido_status, estado.referencia_status, estado.identificador_pagamento,
        Number(estado.pagamentos), Number(estado.desconhecidos),
        Number(estado.historicos_cobranca), Number(estado.historicos_expiracao),
        Number(estado.auditorias_expiracao)],
      ['CONCLUIDO', 'PAGA', e2e, 1, 1, 2, 1, 1]
    );
    global.fetch = fetchOriginal;
    const resposta = await fetch(`${api.url}/api/integracoes/referencias-pagamento?provedor=SICOOB`);
    const listagem = await resposta.json();
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(listagem.total, 2);
    assert.deepStrictEqual(listagem.dados.map(item => item.status).sort(),
      ['EXPIRADA', 'PAGA']);
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
