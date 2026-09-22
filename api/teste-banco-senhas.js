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

async function iniciarApi(connection, usuario) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = usuario;
    next();
  };
  app.locals.exigirPermissao = (modulo, acao) => (req, res, next) => {
    if (req.headers['x-negar'] === `${modulo}:${acao}`) {
      return res.status(403).json({ ok: false, error: 'Acesso negado' });
    }
    next();
  };
  require('./rotas-operacionais')(app, poolTransacional(connection));
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function fechar(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) =>
    servidor.close(erro => (erro ? reject(erro) : resolve()))
  );
}

async function requisitar(url, metodo = 'GET', corpo, headers = {}) {
  const resposta = await fetch(url, {
    method: metodo,
    headers: {
      ...(corpo ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  return { status: resposta.status, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const sufixo = `${process.pid}${String(Date.now()).slice(-8)}`;
  const chassi = `9BGBT${sufixo}`.slice(-17).padStart(17, '9');
  const codigoInicial = `MEC-CRIAR-${sufixo}`;
  const codigoAtualizado = `MEC-EDITAR-${sufixo}`;
  let senhaId = null;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    const [[usuario]] = await connection.query(
      `SELECT u.id, u.nome
         FROM usuarios u
         INNER JOIN usuario_permissoes up ON up.usuario_id = u.id
         INNER JOIN modulos m ON m.id = up.modulo_id
        WHERE u.status = 'ATIVO' AND m.codigo = 'BANCO_SENHAS'
          AND m.ativo = 1 AND up.aprovar = 1
        ORDER BY u.id LIMIT 1`
    );
    const [[origem]] = await connection.query(
      'SELECT id FROM origens_senha WHERE ativo = 1 ORDER BY id LIMIT 1'
    );
    assert.ok(usuario && origem, 'Usuário aprovador e origem ativa são obrigatórios');

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;
    const dados = {
      tipo: 'GM_SENHA',
      marca: 'GM',
      modelo: 'TESTE BANCO',
      ano_inicio: 2026,
      chassi,
      codigo_mecanico: codigoInicial,
      origem_id: origem.id,
      confiabilidade: 'ALTA'
    };

    const negada = await requisitar(
      `${api.url}/api/banco-senhas`,
      'POST',
      dados,
      { 'x-negar': 'BANCO_SENHAS:criar' }
    );
    assert.strictEqual(negada.status, 403);

    const criada = await requisitar(`${api.url}/api/banco-senhas`, 'POST', dados);
    assert.strictEqual(criada.status, 201);
    senhaId = Number(criada.corpo.senha_id);
    assert.ok(senhaId > 0);

    const duplicada = await requisitar(`${api.url}/api/banco-senhas`, 'POST', dados);
    assert.strictEqual(duplicada.status, 409);

    const listada = await requisitar(
      `${api.url}/api/banco-senhas?busca=${encodeURIComponent(chassi)}`
    );
    assert.strictEqual(listada.status, 200);
    assert.strictEqual(listada.corpo.total, 1);

    const atualizada = await requisitar(
      `${api.url}/api/banco-senhas/${senhaId}`,
      'PUT',
      { ...dados, codigo_mecanico: codigoAtualizado, confiabilidade: 'CONFIRMADA' }
    );
    assert.strictEqual(atualizada.status, 200);

    const bloqueada = await requisitar(
      `${api.url}/api/banco-senhas/${senhaId}/status`,
      'PATCH',
      { ativo: 0 }
    );
    assert.strictEqual(bloqueada.status, 200);

    const [[estado]] = await connection.query(
      `SELECT bs.codigo_mecanico, bs.confiabilidade, bs.ativo,
              (SELECT COUNT(*) FROM auditoria a
                WHERE a.modulo = 'BANCO_SENHAS'
                  AND a.entidade_id = CAST(bs.id AS CHAR)) AS auditorias,
              (SELECT COUNT(*) FROM auditoria a
                WHERE a.modulo = 'BANCO_SENHAS'
                  AND a.entidade_id = CAST(bs.id AS CHAR)
                  AND (CAST(a.dados_antes AS CHAR) LIKE ?
                    OR CAST(a.dados_depois AS CHAR) LIKE ?
                    OR CAST(a.dados_antes AS CHAR) LIKE ?
                    OR CAST(a.dados_depois AS CHAR) LIKE ?)) AS codigos_na_auditoria
         FROM banco_senhas bs WHERE bs.id = ?`,
      [
        `%${codigoInicial}%`, `%${codigoInicial}%`,
        `%${codigoAtualizado}%`, `%${codigoAtualizado}%`, senhaId
      ]
    );
    assert.deepStrictEqual(
      [estado.codigo_mecanico, estado.confiabilidade, Number(estado.ativo),
        Number(estado.auditorias), Number(estado.codigos_na_auditoria)],
      [codigoAtualizado, 'CONFIRMADA', 0, 3, 0]
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fechar(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM banco_senhas WHERE chassi = ?) AS senhas,
           (SELECT COUNT(*) FROM auditoria
             WHERE modulo = 'BANCO_SENHAS' AND entidade_id = ?) AS auditorias`,
        [chassi, String(senhaId || 0)]
      );
      assert.deepStrictEqual(
        [Number(residuos.senhas), Number(residuos.auditorias)],
        [0, 0],
        'Rollback deve remover senha e auditorias fictícias'
      );
    } catch (limpeza) {
      erro = erro || limpeza;
    } finally {
      await connection.end();
    }
  }
  if (erro) throw erro;
  console.log('OK: banco de senhas é transacional, auditado e minimizado (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: banco de senhas: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
