'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-ficticio-do-teste';

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
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {}
    })
  };
}

async function iniciarApi(connection) {
  const app = express();
  app.use(express.json());
  require('./rotas-auth')(app, poolTransacional(connection));
  for (const acao of ['visualizar', 'criar', 'editar', 'excluir', 'aprovar']) {
    app.all(
      `/teste-permissao/${acao}`,
      app.locals.autenticarToken,
      app.locals.exigirPermissao('TESTE_ACESSO', acao),
      (req, res) => res.json({ ok: true, acao })
    );
  }
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function fechar(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) =>
    servidor.close(erro => erro ? reject(erro) : resolve())
  );
}

async function requisitar(url, opcoes = {}, token = null) {
  const resposta = await fetch(url, {
    ...opcoes,
    headers: {
      ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opcoes.headers || {})
    }
  });
  return { resposta, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const marcador = `${process.pid}-${Date.now()}`;
  const login = `teste_permissao_${marcador}`;
  const senha = `Senha${process.pid}Teste9`;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    await connection.query(`
      CREATE TEMPORARY TABLE modulos (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        codigo VARCHAR(80) NOT NULL UNIQUE,
        nome VARCHAR(120) NOT NULL,
        descricao VARCHAR(255) DEFAULT NULL,
        ativo TINYINT(1) NOT NULL DEFAULT 1
      ) ENGINE=InnoDB
    `);
    await connection.query(`
      CREATE TEMPORARY TABLE usuario_permissoes (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        usuario_id BIGINT NOT NULL,
        modulo_id BIGINT NOT NULL,
        visualizar TINYINT(1) NOT NULL DEFAULT 0,
        criar TINYINT(1) NOT NULL DEFAULT 0,
        editar TINYINT(1) NOT NULL DEFAULT 0,
        excluir TINYINT(1) NOT NULL DEFAULT 0,
        aprovar TINYINT(1) NOT NULL DEFAULT 0,
        UNIQUE KEY uk_teste_usuario_modulo (usuario_id, modulo_id)
      ) ENGINE=InnoDB
    `);
    const [modulo] = await connection.query(
      `INSERT INTO modulos (codigo, nome, descricao, ativo)
       VALUES ('TESTE_ACESSO', 'Teste de acesso', 'Somente teste', 1)`
    );
    const [[perfil]] = await connection.query(
      'SELECT id FROM perfis WHERE ativo = 1 ORDER BY id LIMIT 1'
    );
    assert.ok(perfil, 'Perfil ativo é obrigatório');
    const senhaHash = await bcrypt.hash(senha, 4);
    const [usuario] = await connection.query(
      `INSERT INTO usuarios
         (nome, login, senha_hash, senha_provisoria, perfil_id, status)
       VALUES (?, ?, ?, 0, ?, 'ATIVO')`,
      [`USUARIO TESTE ${marcador}`, login, senhaHash, perfil.id]
    );
    await connection.query(
      `INSERT INTO usuario_permissoes
         (usuario_id, modulo_id, visualizar, criar, editar, excluir, aprovar)
       VALUES (?, ?, 1, 0, 1, 0, 1)`,
      [usuario.insertId, modulo.insertId]
    );

    const api = await iniciarApi(connection);
    servidor = api.servidor;

    const senhaErrada = await requisitar(`${api.url}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ login, senha: 'incorreta' })
    });
    assert.strictEqual(senhaErrada.resposta.status, 401);

    const loginOk = await requisitar(`${api.url}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ login: login.toUpperCase(), senha })
    });
    assert.strictEqual(loginOk.resposta.status, 200);
    assert.ok(loginOk.corpo.token);
    const token = loginOk.corpo.token;

    const esperado = {
      visualizar: 200,
      criar: 403,
      editar: 200,
      excluir: 403,
      aprovar: 200
    };
    for (const [acao, status] of Object.entries(esperado)) {
      const retorno = await requisitar(
        `${api.url}/teste-permissao/${acao}`,
        {},
        token
      );
      assert.strictEqual(retorno.resposta.status, status, `Ação ${acao}`);
    }

    const semToken = await requisitar(
      `${api.url}/teste-permissao/visualizar`
    );
    assert.strictEqual(semToken.resposta.status, 401);
    await connection.query(
      'UPDATE modulos SET ativo = 0 WHERE id = ?',
      [modulo.insertId]
    );
    const moduloInativo = await requisitar(
      `${api.url}/teste-permissao/visualizar`,
      {},
      token
    );
    assert.strictEqual(moduloInativo.resposta.status, 403);
    await connection.query(
      'UPDATE modulos SET ativo = 1 WHERE id = ?',
      [modulo.insertId]
    );

    const partesToken = token.split('.');
    partesToken[2] = `${partesToken[2][0] === 'a' ? 'b' : 'a'}${partesToken[2].slice(1)}`;
    const tokenAlterado = partesToken.join('.');
    const invalido = await requisitar(
      `${api.url}/teste-permissao/visualizar`,
      {},
      tokenAlterado
    );
    assert.strictEqual(invalido.resposta.status, 401);

    await connection.query(
      'UPDATE usuarios SET senha_provisoria = 1 WHERE id = ?',
      [usuario.insertId]
    );
    const permitidoTroca = await requisitar(`${api.url}/api/auth/me`, {}, token);
    assert.strictEqual(permitidoTroca.resposta.status, 200);
    const bloqueadoTroca = await requisitar(
      `${api.url}/teste-permissao/visualizar`,
      {},
      token
    );
    assert.strictEqual(bloqueadoTroca.resposta.status, 403);
    assert.strictEqual(bloqueadoTroca.corpo.codigo, 'TROCA_SENHA_OBRIGATORIA');

    await connection.query(
      "UPDATE usuarios SET senha_provisoria = 0, status = 'BLOQUEADO' WHERE id = ?",
      [usuario.insertId]
    );
    const tokenBloqueado = await requisitar(
      `${api.url}/teste-permissao/visualizar`,
      {},
      token
    );
    assert.strictEqual(tokenBloqueado.resposta.status, 401);
    const loginBloqueado = await requisitar(`${api.url}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ login, senha })
    });
    assert.strictEqual(loginBloqueado.resposta.status, 403);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fechar(servidor);
      await connection.rollback();
      const [[residuo]] = await connection.query(
        'SELECT COUNT(*) AS total FROM usuarios WHERE login = ?',
        [login]
      );
      assert.strictEqual(Number(residuo.total), 0);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: autenticação, permissões e bloqueios funcionam (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: teste de autorização: ${erro.message}`);
  process.exitCode = 1;
});
