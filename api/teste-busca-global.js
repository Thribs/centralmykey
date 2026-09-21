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

async function iniciarApi(connection, usuarioId) {
  const app = express();
  app.locals.autenticarToken = (req, res, next) => {
    if (req.headers['x-sem-auth']) {
      return res.status(401).json({ ok: false, error: 'Não autenticado' });
    }
    req.usuario = { id: usuarioId };
    return next();
  };
  require('./rotas-busca-global')(app, {
    query: (...args) => connection.query(...args)
  });
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

async function requisitar(url, headers = {}) {
  const resposta = await fetch(url, { headers });
  return { resposta, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const sufixo = `${process.pid}${String(Date.now()).slice(-7)}`;
  const marcador = `GLOB${sufixo}`;
  const usuarioId = 900000000 + Number(String(Date.now()).slice(-7));
  let clienteId;
  let fornecedorId;
  let pedidoId;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    await connection.query(`
      CREATE TEMPORARY TABLE modulos (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        codigo VARCHAR(80) NOT NULL UNIQUE,
        nome VARCHAR(120) NOT NULL,
        ativo TINYINT(1) NOT NULL DEFAULT 1
      ) ENGINE=InnoDB
    `);
    await connection.query(`
      CREATE TEMPORARY TABLE usuario_permissoes (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        usuario_id BIGINT NOT NULL,
        modulo_id BIGINT NOT NULL,
        visualizar TINYINT(1) NOT NULL DEFAULT 0,
        UNIQUE KEY uk_usuario_modulo (usuario_id, modulo_id)
      ) ENGINE=InnoDB
    `);
    await connection.query(`
      INSERT INTO modulos (codigo, nome, ativo) VALUES
        ('PEDIDOS_SENHAS', 'Pedidos', 1),
        ('CLIENTES', 'Clientes', 1),
        ('FORNECEDORES', 'Fornecedores', 1)
    `);
    const [modulos] = await connection.query(`
      SELECT id, codigo FROM modulos
       WHERE codigo IN ('PEDIDOS_SENHAS', 'CLIENTES', 'FORNECEDORES')
    `);
    const idsModulo = Object.fromEntries(
      modulos.map(modulo => [modulo.codigo, Number(modulo.id)])
    );
    await connection.query(`
      INSERT INTO usuario_permissoes (usuario_id, modulo_id, visualizar)
      VALUES (?, ?, 1), (?, ?, 1)
    `, [usuarioId, idsModulo.PEDIDOS_SENHAS, usuarioId, idsModulo.CLIENTES]);

    const [[servico]] = await connection.query(
      'SELECT id FROM servicos WHERE ativo=1 ORDER BY id LIMIT 1'
    );
    assert.ok(servico, 'Serviço ativo é necessário para o teste');
    const telefone = `5588${sufixo}`.slice(0, 20);
    const [cliente] = await connection.query(`
      INSERT INTO clientes
        (nome, telefone, telefone_normalizado, cadastro_status, ativo)
      VALUES (?, ?, ?, 'COMPLETO', 1)
    `, [`CLIENTE ${marcador}`, telefone, telefone]);
    clienteId = cliente.insertId;
    const [fornecedor] = await connection.query(`
      INSERT INTO fornecedores
        (nome, contato, telefone, whatsapp, tipo, ativo)
      VALUES (?, 'CONTATO TESTE', ?, ?, 'PESSOA', 1)
    `, [`FORNECEDOR ${marcador}`, telefone, telefone]);
    fornecedorId = fornecedor.insertId;
    const [pedido] = await connection.query(`
      INSERT INTO pedidos_senha
        (protocolo, cliente_id, servico_id, chassi, marca, status,
         valor_venda, custo, moeda)
      VALUES (?, ?, ?, ?, 'GM', 'ABERTO', 50, 0, 'BRL')
    `, [`${marcador}-PEDIDO`, clienteId, servico.id, `${marcador}CHASSI`]);
    pedidoId = pedido.insertId;

    const api = await iniciarApi(connection, usuarioId);
    servidor = api.servidor;
    const endpoint = `${api.url}/api/busca-global?termo=${encodeURIComponent(marcador)}`;

    const semAuth = await requisitar(endpoint, { 'x-sem-auth': '1' });
    assert.strictEqual(semAuth.resposta.status, 401);
    const curto = await requisitar(`${api.url}/api/busca-global?termo=A`);
    assert.strictEqual(curto.resposta.status, 400);

    const restrita = await requisitar(endpoint);
    assert.strictEqual(restrita.resposta.status, 200);
    assert.deepStrictEqual(
      new Set(restrita.corpo.dados.map(item => item.tipo)),
      new Set(['PEDIDO', 'CLIENTE'])
    );
    assert.ok(!restrita.corpo.dados.some(item =>
      item.tipo === 'FORNECEDOR' && item.id === fornecedorId
    ));
    assert.ok(restrita.corpo.dados.some(item =>
      item.tipo === 'PEDIDO' && item.id === pedidoId &&
      item.modulo === 'PEDIDOS_SENHAS' && item.busca === `${marcador}-PEDIDO`
    ));

    await connection.query(`
      INSERT INTO usuario_permissoes (usuario_id, modulo_id, visualizar)
      VALUES (?, ?, 1)
    `, [usuarioId, idsModulo.FORNECEDORES]);
    const completa = await requisitar(endpoint);
    assert.strictEqual(completa.resposta.status, 200);
    assert.deepStrictEqual(
      new Set(completa.corpo.dados.map(item => item.tipo)),
      new Set(['PEDIDO', 'CLIENTE', 'FORNECEDOR'])
    );
    assert.ok(completa.corpo.dados.every(item =>
      item.titulo && item.modulo && item.busca && Number.isInteger(item.id)
    ));
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(`
        SELECT
          (SELECT COUNT(*) FROM pedidos_senha WHERE id=?) AS pedidos,
          (SELECT COUNT(*) FROM clientes WHERE id=?) AS clientes,
          (SELECT COUNT(*) FROM fornecedores WHERE id=?) AS fornecedores
      `, [pedidoId || 0, clienteId || 0, fornecedorId || 0]);
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0, 0]);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: busca global respeita permissões e rollback');
}

executar().catch(erro => {
  console.error(`FALHA: busca global: ${erro.message}`);
  process.exitCode = 1;
});
