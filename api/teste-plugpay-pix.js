'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { criarPix, consultarPix } = require('./cliente-plugpay');
const { criarCobrancaPedidoPlugPay } = require('./plugpay-pix');
const { reconciliarPagamentosPlugPay } = require('./reconciliar-pagamentos-plugpay');

dotenv.config({ path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'), quiet: true });
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

const config = { ambiente: 'sandbox', apiUrl: 'https://apisandbox.plugpayapi.com',
  clientId: 'cliente-ficticio', password: 'senha-ficticia',
  documentMerchant: 'merchant-ficticio', timeoutMs: 1000 };
const resposta = (status, corpo) => ({ ok: status >= 200 && status < 300,
  status, json: async () => corpo });

async function executar() {
  const chamadas = [];
  const transporte = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    if (url.endsWith('/auth/token')) return resposta(200, { token: 'token-ficticio' });
    if (url.includes('/create')) return resposta(200, {
      IdTransacao: 889, referenciaInterna: 'cb1edd809cb411f1948543742',
      qrCodeId: 'Bcb1edd809cb411f1948543742', qrCodeCopiaCola: '000201teste'
    });
    return resposta(200, { status: 1, IdTransacao: 889, valueBRL: 60, currency: 'BRL' });
  };
  const pix = await criarPix(config, { moeda: 'BRL', valor: 60, cpf: '52998224725' }, transporte);
  assert.strictEqual(pix.referencia, 'cb1edd809cb411f1948543742');
  assert.strictEqual(JSON.parse(chamadas[0].opcoes.body).client_id, 'cliente-ficticio');
  assert.strictEqual(JSON.parse(chamadas[1].opcoes.body).originCurrencie, 'BRL');
  assert.strictEqual(chamadas[1].opcoes.headers.Authorization, 'Bearer token-ficticio');
  assert.strictEqual((await consultarPix(config, pix.referencia, transporte)).status, 1);
  assert.match(chamadas[3].url, /transactionPix\/status\/cb1edd/);
  await assert.rejects(() => consultarPix({ ...config, apiUrl: 'https://invalido.test' },
    pix.referencia, transporte), erro => erro.codigo === 'PLUGPAY_AMBIENTE_INVALIDO');

  const conexao = await mysql.createConnection({ host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  try {
    await conexao.beginTransaction();
    await conexao.query(`CREATE TEMPORARY TABLE integracao_referencias_pagamento (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, provedor VARCHAR(40), entidade VARCHAR(40),
      entidade_id BIGINT, referencia_provedor VARCHAR(120), valor DECIMAL(12,2),
      moeda CHAR(3), status VARCHAR(20), identificador_pagamento VARCHAR(160),
      location VARCHAR(500), pix_copia_cola TEXT, erro_codigo VARCHAR(80),
      erro_detalhe VARCHAR(500), criada_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      registrada_em DATETIME, paga_em DATETIME)`);
    const [[servico]] = await conexao.query("SELECT id FROM servicos WHERE codigo='GM_SENHA' LIMIT 1");
    const [[cliente]] = await conexao.query(
      "SELECT id FROM clientes WHERE cpf_normalizado REGEXP '^[0-9]{11}$' AND ativo=1 LIMIT 1");
    assert.ok(servico && cliente, 'Base de teste precisa de serviço GM e cliente com CPF');
    const [pedido] = await conexao.query(`INSERT INTO pedidos_senha
      (protocolo,cliente_id,servico_id,chassi,marca,modelo,ano,status,valor_venda,custo,moeda)
      VALUES (?,?,?,'9BGPLUGPAYTESTE001','GM','TESTE PLUGPAY',2026,
      'AGUARDANDO_PAGAMENTO',60,0,'BRL')`,
    [`PLUG-${Date.now()}`.slice(0, 30), cliente.id, servico.id]);
    const pedidoId = pedido.insertId;
    const pool = { getConnection: async () => ({
      query: (...args) => conexao.query(...args), beginTransaction: async () => {},
      commit: async () => {}, rollback: async () => {}, release: () => {}
    }), query: (...args) => conexao.query(...args) };
    const criada = await criarCobrancaPedidoPlugPay(pool, pedidoId, config, { transporte });
    assert.strictEqual(criada.status, 'REGISTRADA');
    assert.strictEqual((await criarCobrancaPedidoPlugPay(pool, pedidoId, config,
      { transporte })).idempotente, true);
    const eventos = [];
    const reconciliada = await reconciliarPagamentosPlugPay(pool,
      { ...config, consultaHabilitada: true }, {
        consultarPix: async () => ({ status: 1, IdTransacao: 889,
          valueBRL: 60, currency: 'BRL' }),
        processarEvento: async (p, dados) => { eventos.push(dados); return { ok: true }; },
        sincronizarAtendimento: async () => {}
      });
    assert.strictEqual(reconciliada.pagas, 1);
    assert.strictEqual(eventos[0].provedor, 'PLUGPAY');
    const [[ref]] = await conexao.query(
      "SELECT status FROM integracao_referencias_pagamento WHERE entidade_id=?", [pedidoId]);
    assert.strictEqual(ref.status, 'PAGA');
  } finally { await conexao.rollback(); await conexao.end(); }
  console.log('Teste PlugPay Pix aprovado com mocks e transação revertida.');
}

executar().catch(error => { console.error(error); process.exitCode = 1; });
