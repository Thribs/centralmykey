'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

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

async function iniciarApi(connection) {
  const app = express();
  app.locals.autenticarToken = (req, res, next) => next();
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-relatorios')(app, {
    query: (...args) => connection.query(...args)
  });
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function requisitar(url) {
  const resposta = await fetch(url);
  return { resposta, corpo: await resposta.json() };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const sufixo = `${process.pid}${String(Date.now()).slice(-7)}`;
  const prefixo = `TR${String(process.pid).slice(-4)}${String(Date.now()).slice(-5)}`;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    const [[servico]] = await connection.query(
      'SELECT id FROM servicos WHERE ativo=1 ORDER BY id LIMIT 1'
    );
    const [[origemApi]] = await connection.query(
      "SELECT id, nome FROM origens_senha WHERE codigo='API' LIMIT 1"
    );
    const [[origemFornecedor]] = await connection.query(
      "SELECT id, nome FROM origens_senha WHERE codigo='FORNECEDOR' LIMIT 1"
    );
    assert.ok(servico && origemApi && origemFornecedor, 'Catálogos ativos são necessários');

    const telefone1 = `5591${sufixo}`;
    const telefone2 = `5592${sufixo}`;
    const [cliente1] = await connection.query(`
      INSERT INTO clientes
        (nome, telefone, telefone_normalizado, cadastro_status, ativo)
      VALUES (?, ?, ?, 'COMPLETO', 1)
    `, [`CLIENTE RELATÓRIO A ${sufixo}`, telefone1, telefone1]);
    const [cliente2] = await connection.query(`
      INSERT INTO clientes
        (nome, telefone, telefone_normalizado, cadastro_status, ativo)
      VALUES (?, ?, ?, 'COMPLETO', 1)
    `, [`CLIENTE RELATÓRIO B ${sufixo}`, telefone2, telefone2]);
    const [fornecedor] = await connection.query(`
      INSERT INTO fornecedores (nome, tipo, ativo)
      VALUES (?, 'PESSOA', 1)
    `, [`FORNECEDOR RELATÓRIO ${sufixo}`]);

    const pedidos = [
      ['A', cliente1.insertId, 'CONCLUIDO', 50, 0, 'BRL', null, origemApi.id, '2099-09-10 09:00:00'],
      ['B', cliente2.insertId, 'CONCLUIDO', 70, 22, 'BRL', fornecedor.insertId, origemFornecedor.id, '2099-09-10 10:00:00'],
      ['C', cliente1.insertId, 'CANCELADO', 30, 0, 'BRL', null, null, '2099-09-11 09:00:00'],
      ['D', cliente2.insertId, 'ERRO', 40, 5, 'BRL', fornecedor.insertId, origemFornecedor.id, '2099-09-11 10:00:00'],
      ['E', cliente1.insertId, 'EM_CONSULTA', 60, 25, 'BRL', fornecedor.insertId, origemFornecedor.id, '2099-09-11 11:00:00'],
      ['U', cliente1.insertId, 'CONCLUIDO', 999, 500, 'USD', null, origemApi.id, '2099-09-10 12:00:00'],
      ['X', cliente1.insertId, 'CONCLUIDO', 1000, 0, 'BRL', null, origemApi.id, '2099-08-01 12:00:00']
    ];
    for (const pedido of pedidos) {
      await connection.query(`
        INSERT INTO pedidos_senha
          (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
           status, valor_venda, custo, moeda, fornecedor_id, origem_id, criado_em)
        VALUES (?, ?, ?, ?, 'TESTE', 'RELATÓRIO', 2026, ?, ?, ?, ?, ?, ?, ?)
      `, [`${prefixo}-${pedido[0]}`, pedido[1], servico.id,
        `CHASSI${prefixo}${pedido[0]}`, ...pedido.slice(2)]);
    }

    const api = await iniciarApi(connection);
    servidor = api.servidor;
    const base = `${api.url}/api/relatorios/operacional`;

    const invalida = await requisitar(`${base}?inicio=2099-02-30&fim=2099-09-11`);
    assert.strictEqual(invalida.resposta.status, 400);
    const invertida = await requisitar(`${base}?inicio=2099-09-12&fim=2099-09-10`);
    assert.strictEqual(invertida.resposta.status, 400);
    const moedaInvalida = await requisitar(`${base}?moeda=EUR`);
    assert.strictEqual(moedaInvalida.resposta.status, 400);

    const brl = await requisitar(
      `${base}?inicio=2099-09-10&fim=2099-09-11&moeda=BRL`
    );
    assert.strictEqual(brl.resposta.status, 200);
    assert.strictEqual(brl.corpo.periodo.moeda, 'BRL');
    const resumo = brl.corpo.resumo;
    assert.deepStrictEqual(
      [Number(resumo.total_pedidos), Number(resumo.concluidos),
        Number(resumo.cancelados), Number(resumo.erros),
        Number(resumo.em_andamento), Number(resumo.valor_vendas),
        Number(resumo.custo_total), Number(resumo.resultado_bruto),
        Number(resumo.clientes_atendidos)],
      [5, 2, 1, 1, 1, 250, 52, 198, 2]
    );
    const concluido = brl.corpo.por_status.find(item => item.status === 'CONCLUIDO');
    assert.deepStrictEqual(
      [Number(concluido.quantidade), Number(concluido.valor_vendas), Number(concluido.custo)],
      [2, 120, 22]
    );
    const porFornecedor = brl.corpo.por_fornecedor.find(
      item => item.fornecedor === `FORNECEDOR RELATÓRIO ${sufixo}`
    );
    assert.deepStrictEqual(
      [Number(porFornecedor.quantidade), Number(porFornecedor.valor_vendas), Number(porFornecedor.custo)],
      [3, 170, 52]
    );
    const origem = brl.corpo.por_origem.find(item => item.origem === origemFornecedor.nome);
    assert.strictEqual(Number(origem.quantidade), 3);
    assert.deepStrictEqual(
      brl.corpo.por_dia.map(item => [item.data, Number(item.quantidade)]),
      [['2099-09-10', 2], ['2099-09-11', 3]]
    );

    const usd = await requisitar(
      `${base}?inicio=2099-09-10&fim=2099-09-11&moeda=USD`
    );
    assert.strictEqual(usd.resposta.status, 200);
    assert.deepStrictEqual(
      [Number(usd.corpo.resumo.total_pedidos), Number(usd.corpo.resumo.valor_vendas),
        Number(usd.corpo.resumo.custo_total)],
      [1, 999, 500]
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(`
        SELECT
          (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo LIKE ?) AS pedidos,
          (SELECT COUNT(*) FROM clientes WHERE nome LIKE ?) AS clientes,
          (SELECT COUNT(*) FROM fornecedores WHERE nome LIKE ?) AS fornecedores
      `, [`${prefixo}-%`, `CLIENTE RELATÓRIO %${sufixo}`, `FORNECEDOR RELATÓRIO ${sufixo}`]);
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0, 0]);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: relatório separa período, moeda e totais (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: relatório operacional: ${erro.message}`);
  process.exitCode = 1;
});
