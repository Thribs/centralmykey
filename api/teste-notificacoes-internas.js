'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  registrarNotificacao,
  resolverNotificacao
} = require('./notificacoes-internas');
const {
  criarTabelasNotificacoesTemporarias
} = require('./teste-suporte-notificacoes');

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
    getConnection: async () => ({
      query: (...args) => connection.query(...args),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {}
    }),
    query: (...args) => connection.query(...args)
  };
}

async function iniciarApi(connection, usuario) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = usuario;
    next();
  };
  require('./rotas-notificacoes')(app, poolTransacional(connection));
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
  const chave = `TESTE_NOTIFICACAO:${process.pid}:${Date.now()}`;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    await criarTabelasNotificacoesTemporarias(connection);
    const [[usuario]] = await connection.query(
      `SELECT u.id, u.nome
         FROM usuarios u
         INNER JOIN usuario_permissoes up ON up.usuario_id = u.id
         INNER JOIN modulos m ON m.id = up.modulo_id
        WHERE u.status = 'ATIVO'
          AND m.codigo = 'PEDIDOS_SENHAS'
          AND m.ativo = 1
          AND up.visualizar = 1
        ORDER BY u.id
        LIMIT 1`
    );
    assert.ok(usuario, 'Usuário com acesso a pedidos é obrigatório');

    const criada = await registrarNotificacao(connection, {
      chave,
      tipo: 'TESTE_OPERACIONAL',
      nivel: 'CRITICA',
      modulo: 'PEDIDOS_SENHAS',
      titulo: 'Pendência de teste',
      mensagem: 'Uma pendência funcional exige atenção.',
      entidade: 'pedidos_senha',
      entidadeId: '123',
      dados: { pedido_id: 123 }
    });
    const oculta = await registrarNotificacao(connection, {
      chave: `${chave}:OCULTA`,
      tipo: 'TESTE_RESTRITO',
      nivel: 'ATENCAO',
      modulo: 'PEDIDOS_SENHAS',
      usuarioDestinoId: Number(usuario.id) + 999999,
      titulo: 'Notificação restrita',
      mensagem: 'Não deve aparecer para o usuário do teste.'
    });

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;

    const resumoInicial = await requisicao(`${api.url}/api/notificacoes/resumo`);
    assert.strictEqual(resumoInicial.resposta.status, 200);
    assert.strictEqual(resumoInicial.corpo.nao_lidas, 1);
    assert.strictEqual(resumoInicial.corpo.criticas, 1);

    const lista = await requisicao(
      `${api.url}/api/notificacoes?nao_lidas=1&limite=10`
    );
    assert.strictEqual(lista.resposta.status, 200);
    assert.strictEqual(lista.corpo.total, 1);
    assert.strictEqual(Number(lista.corpo.dados[0].id), criada.id);
    assert.strictEqual(lista.corpo.dados[0].lida, 0);

    const leituraOculta = await requisicao(
      `${api.url}/api/notificacoes/${oculta.id}/ler`,
      { method: 'PATCH' }
    );
    assert.strictEqual(leituraOculta.resposta.status, 404);

    const leitura = await requisicao(
      `${api.url}/api/notificacoes/${criada.id}/ler`,
      { method: 'PATCH' }
    );
    assert.strictEqual(leitura.resposta.status, 200);
    const resumoLido = await requisicao(`${api.url}/api/notificacoes/resumo`);
    assert.strictEqual(resumoLido.corpo.nao_lidas, 0);

    const reativada = await registrarNotificacao(connection, {
      chave,
      tipo: 'TESTE_OPERACIONAL',
      nivel: 'ATENCAO',
      modulo: 'PEDIDOS_SENHAS',
      titulo: 'Pendência atualizada',
      mensagem: 'A mesma pendência voltou a exigir atenção.'
    });
    assert.strictEqual(reativada.id, criada.id);
    const resumoReativado = await requisicao(`${api.url}/api/notificacoes/resumo`);
    assert.strictEqual(resumoReativado.corpo.nao_lidas, 1);

    const todas = await requisicao(
      `${api.url}/api/notificacoes/ler-todas`,
      { method: 'POST' }
    );
    assert.strictEqual(todas.resposta.status, 200);
    const resumoTodas = await requisicao(`${api.url}/api/notificacoes/resumo`);
    assert.strictEqual(resumoTodas.corpo.nao_lidas, 0);

    assert.strictEqual(await resolverNotificacao(connection, chave), true);
    const listaResolvida = await requisicao(`${api.url}/api/notificacoes`);
    assert.strictEqual(listaResolvida.corpo.total, 0);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: notificações respeitam acesso, leitura, reativação e resolução (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de notificações internas: ${erro.message}`);
  process.exitCode = 1;
});
