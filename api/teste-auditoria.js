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

async function iniciarApi(connection, usuario) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = {
      ...usuario,
      perfil_id: Number(req.get('x-perfil-id') || 1)
    };
    next();
  };
  require('./rotas-auditoria')(app, {
    query: (...args) => connection.query(...args)
  });
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

async function requisicao(url, opcoes) {
  const resposta = await fetch(url, opcoes);
  return { resposta, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const marcador = `AUDITORIA-TESTE-${process.pid}-${Date.now()}`;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    const [[usuario]] = await connection.query(
      `SELECT id, nome, perfil_id
         FROM usuarios
        WHERE status = 'ATIVO' AND perfil_id = 1
        ORDER BY id LIMIT 1`
    );
    assert.ok(usuario, 'Administrador ativo é obrigatório');

    for (const indice of [1, 2]) {
      await connection.query(
        `INSERT INTO auditoria
           (usuario_id, modulo, acao, entidade, entidade_id,
            descricao, dados_antes, dados_depois, ip)
         VALUES (?, 'TESTE_AUDITORIA', 'CONSULTAR', 'teste', ?, ?, ?, ?, ?)`,
        [
          usuario.id,
          `${marcador}-${indice}`,
          `${marcador} evento ${indice}`,
          JSON.stringify({ segredo: `nao-expor-${indice}` }),
          JSON.stringify({ token: `nao-expor-${indice}` }),
          '127.0.0.99'
        ]
      );
    }

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;

    const proibida = await requisicao(`${api.url}/api/auditoria`, {
      headers: { 'x-perfil-id': '2' }
    });
    assert.strictEqual(proibida.resposta.status, 403);

    const invalida = await requisicao(
      `${api.url}/api/auditoria?inicio=2026-02-30`
    );
    assert.strictEqual(invalida.resposta.status, 400);

    const primeira = await requisicao(
      `${api.url}/api/auditoria?busca=${encodeURIComponent(marcador)}&limite=1`
    );
    assert.strictEqual(primeira.resposta.status, 200);
    assert.strictEqual(primeira.corpo.total, 1);
    assert.ok(primeira.corpo.proximo_cursor);
    const registro = primeira.corpo.dados[0];
    assert.match(registro.descricao, new RegExp(marcador));
    for (const campo of ['dados_antes', 'dados_depois', 'ip']) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(registro, campo),
        false,
        `${campo} não deve ser exposto na listagem`
      );
    }

    const segunda = await requisicao(
      `${api.url}/api/auditoria?busca=${encodeURIComponent(marcador)}` +
      `&limite=1&antes_de=${primeira.corpo.proximo_cursor}`
    );
    assert.strictEqual(segunda.corpo.total, 1);
    assert.notStrictEqual(segunda.corpo.dados[0].id, registro.id);

    const filtros = await requisicao(`${api.url}/api/auditoria/filtros`);
    assert.strictEqual(filtros.resposta.status, 200);
    assert.ok(filtros.corpo.modulos.some(
      item => item.modulo === 'TESTE_AUDITORIA'
    ));
    assert.ok(filtros.corpo.usuarios.some(
      item => Number(item.id) === Number(usuario.id)
    ));
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        'SELECT COUNT(*) AS total FROM auditoria WHERE descricao LIKE ?',
        [`${marcador}%`]
      );
      assert.strictEqual(Number(residuos.total), 0);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: auditoria é paginada, restrita e não expõe dados sensíveis (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de auditoria: ${erro.message}`);
  process.exitCode = 1;
});
