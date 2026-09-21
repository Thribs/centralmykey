'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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
  const pool = poolTransacional(connection);
  require('./rotas-auth')(app, pool);
  require('./rotas-administracao')(app, pool);

  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function requisitar(url, token, { metodo = 'GET', corpo } = {}) {
  const resposta = await fetch(url, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(corpo ? { 'Content-Type': 'application/json' } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  return { resposta, corpo: await resposta.json() };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

async function executar() {
  assert.ok(process.env.JWT_SECRET, 'JWT_SECRET é necessário para o teste HTTP');
  const connection = await mysql.createConnection(configBanco);
  const sufixo = `${process.pid}${String(Date.now()).slice(-8)}`;
  const loginOperador = `op-${sufixo}`;
  const loginUsuario = `usr-${sufixo}`;
  let servidor;
  let operadorId;
  let usuarioId;
  let erro;

  try {
    await connection.beginTransaction();
    const [[perfil]] = await connection.query(
      'SELECT id FROM perfis WHERE ativo=1 ORDER BY id LIMIT 1'
    );
    const [modulos] = await connection.query(
      'SELECT id, codigo FROM modulos WHERE ativo=1 ORDER BY id'
    );
    const moduloUsuarios = modulos.find(item => item.codigo === 'USUARIOS');
    assert.ok(perfil, 'Perfil ativo é necessário para o teste');
    assert.ok(moduloUsuarios, 'Módulo USUARIOS ativo é necessário para o teste');
    assert.ok(modulos.length >= 2, 'Dois módulos ativos são necessários para testar a matriz');

    const [operador] = await connection.query(`
      INSERT INTO usuarios
        (nome, login, senha_hash, senha_provisoria, perfil_id, status)
      VALUES (?, ?, ?, 0, ?, 'ATIVO')
    `, [`OPERADOR TESTE ${sufixo}`, loginOperador,
      bcrypt.hashSync(`Operador-${sufixo}`, 4), perfil.id]);
    operadorId = operador.insertId;
    await connection.query(`
      INSERT INTO usuario_permissoes
        (usuario_id, modulo_id, visualizar, criar, editar, excluir, aprovar)
      VALUES (?, ?, 1, 1, 1, 1, 1)
    `, [operadorId, moduloUsuarios.id]);

    const api = await iniciarApi(connection);
    servidor = api.servidor;
    const token = jwt.sign(
      { id: operadorId, login: loginOperador },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );

    const senhaProvisoria = `Senha-${sufixo}`;
    const criado = await requisitar(`${api.url}/api/usuarios`, token, {
      metodo: 'POST',
      corpo: {
        nome: `USUÁRIO TESTE ${sufixo}`,
        login: loginUsuario,
        senha: senhaProvisoria,
        email: `${loginUsuario}@teste.invalid`,
        telefone: '5500000000000',
        perfil_id: perfil.id
      }
    });
    assert.strictEqual(criado.resposta.status, 201);
    usuarioId = criado.corpo.usuario.id;
    assert.strictEqual(criado.corpo.usuario.login, loginUsuario);
    assert.ok(!JSON.stringify(criado.corpo).includes(senhaProvisoria));

    const duplicado = await requisitar(`${api.url}/api/usuarios`, token, {
      metodo: 'POST',
      corpo: {
        nome: 'Duplicado',
        login: loginUsuario,
        senha: 'Senha-duplicada',
        perfil_id: perfil.id
      }
    });
    assert.strictEqual(duplicado.resposta.status, 409);

    const lista = await requisitar(`${api.url}/api/usuarios`, token);
    assert.strictEqual(lista.resposta.status, 200);
    const listado = lista.corpo.dados.find(item => item.id === usuarioId);
    assert.ok(listado);
    assert.strictEqual(Object.hasOwn(listado, 'senha_hash'), false);

    const atualizado = await requisitar(`${api.url}/api/usuarios/${usuarioId}`, token, {
      metodo: 'PUT',
      corpo: {
        nome: `USUÁRIO EDITADO ${sufixo}`,
        login: `${loginUsuario}-editado`,
        email: `editado-${loginUsuario}@teste.invalid`,
        telefone: '5511111111111',
        perfil_id: perfil.id
      }
    });
    assert.strictEqual(atualizado.resposta.status, 200);

    const bloqueado = await requisitar(
      `${api.url}/api/usuarios/${usuarioId}/status`,
      token,
      { metodo: 'PATCH', corpo: { status: 'BLOQUEADO' } }
    );
    assert.strictEqual(bloqueado.resposta.status, 200);

    const autoBloqueio = await requisitar(
      `${api.url}/api/usuarios/${operadorId}/status`,
      token,
      { metodo: 'PATCH', corpo: { status: 'BLOQUEADO' } }
    );
    assert.strictEqual(autoBloqueio.resposta.status, 409);

    const matriz = [moduloUsuarios, modulos.find(item => item.id !== moduloUsuarios.id)]
      .map((item, indice) => ({
        modulo_id: item.id,
        visualizar: 1,
        criar: indice === 0 ? 1 : 0,
        editar: indice === 0 ? 1 : 0,
        excluir: 0,
        aprovar: 0
      }));
    const permissoesSalvas = await requisitar(
      `${api.url}/api/usuarios/${usuarioId}/permissoes`,
      token,
      { metodo: 'PUT', corpo: { permissoes: matriz } }
    );
    assert.strictEqual(permissoesSalvas.resposta.status, 200);

    const matrizDuplicada = await requisitar(
      `${api.url}/api/usuarios/${usuarioId}/permissoes`,
      token,
      { metodo: 'PUT', corpo: { permissoes: [matriz[0], matriz[0]] } }
    );
    assert.strictEqual(matrizDuplicada.resposta.status, 400);

    const permissoes = await requisitar(
      `${api.url}/api/usuarios/${usuarioId}/permissoes`,
      token
    );
    assert.strictEqual(permissoes.resposta.status, 200);
    const porModulo = new Map(
      permissoes.corpo.permissoes.map(item => [item.modulo_id, item])
    );
    assert.strictEqual(Number(porModulo.get(matriz[0].modulo_id).editar), 1);
    assert.strictEqual(Number(porModulo.get(matriz[1].modulo_id).visualizar), 1);

    const [[persistido]] = await connection.query(`
      SELECT u.nome, u.login, u.status, u.senha_provisoria,
             (SELECT COUNT(*) FROM usuario_permissoes up
               WHERE up.usuario_id=u.id) AS permissoes,
             (SELECT COUNT(*) FROM auditoria a
               WHERE a.entidade='usuarios'
                 AND a.entidade_id=CAST(u.id AS CHAR)) AS auditorias
        FROM usuarios u WHERE u.id=?
    `, [usuarioId]);
    assert.deepStrictEqual(
      [persistido.nome, persistido.login, persistido.status,
        Number(persistido.senha_provisoria), Number(persistido.permissoes),
        Number(persistido.auditorias)],
      [`USUÁRIO EDITADO ${sufixo}`, `${loginUsuario}-editado`, 'BLOQUEADO', 1, 2, 4]
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(`
        SELECT
          (SELECT COUNT(*) FROM usuarios WHERE login IN (?, ?)) AS usuarios,
          (SELECT COUNT(*) FROM usuario_permissoes WHERE usuario_id IN (?, ?)) AS permissoes,
          (SELECT COUNT(*) FROM auditoria
            WHERE entidade='usuarios' AND entidade_id IN (?, ?)) AS auditorias
      `, [loginOperador, `${loginUsuario}-editado`, operadorId || 0, usuarioId || 0,
        String(operadorId || 0), String(usuarioId || 0)]);
      assert.deepStrictEqual(
        Object.values(residuos).map(Number),
        [0, 0, 0],
        'Rollback deve remover usuários, permissões e auditorias do teste'
      );
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: administração de usuários e permissões funciona (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: administração de usuários: ${erro.message}`);
  process.exitCode = 1;
});
