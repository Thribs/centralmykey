'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  criarTabelaOutboxTemporaria
} = require('./teste-suporte-outbox');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});

if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({
    path: '/opt/central-mykey-api/.env',
    quiet: true
  });
}

process.env.AMBIENTE_API_JOELPIRES = 'teste';
process.env.URL_API_JOELPIRES_TESTE = 'https://mock.joelpires.invalid';
process.env.CHAVE_API_JOELPIRES = 'credencial-ficticia';
process.env.ID_USUARIO_API_JOELPIRES = '-1';
process.env.APIJOELPIRES_ID_DISPOSITIVO = 'centralmykey';
process.env.APIJOELPIRES_TIMEOUT_MS = '1000';

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

function respostaHttp(status, corpo) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(corpo)
  };
}

function poolTransacional(connection) {
  return {
    getConnection: async () => ({
      query: (...argumentos) => connection.query(...argumentos),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {}
    }),
    query: (...argumentos) => connection.query(...argumentos)
  };
}

async function iniciarApi(connection, usuario) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = usuario;
    next();
  };
  app.locals.exigirPermissao = () => (req, res, next) => next();

  require('./rotas-financeiro')(app, poolTransacional(connection));

  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });

  const endereco = servidor.address();
  return {
    servidor,
    url: `http://127.0.0.1:${endereco.port}`
  };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

async function postPagamento(fetchImpl, url, pedidoId, corpo) {
  const resposta = await fetchImpl(
    `${url}/api/pedidos/${pedidoId}/pagamento/confirmar-manual`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    }
  );
  return {
    status: resposta.status,
    corpo: await resposta.json()
  };
}

async function contarRegistros(connection, pedidoId, referencia) {
  const [[totais]] = await connection.query(
    `SELECT
       (SELECT COUNT(*) FROM lancamentos_financeiros
         WHERE pedido_senha_id = ? AND origem = 'CONFIRMACAO_MANUAL')
         AS lancamentos,
       (SELECT COUNT(*)
          FROM pagamentos pg
          INNER JOIN lancamentos_financeiros lf ON lf.id = pg.lancamento_id
         WHERE lf.pedido_senha_id = ?)
         AS pagamentos,
       (SELECT COUNT(*) FROM pedido_historico
         WHERE pedido_id = ? AND tipo = 'PAGAMENTO_CONFIRMADO')
         AS historicos,
       (SELECT COUNT(*) FROM pagamentos WHERE referencia_externa = ?)
         AS referencias`,
    [pedidoId, pedidoId, pedidoId, referencia]
  );

  return Object.fromEntries(
    Object.entries(totais).map(([chave, valor]) => [chave, Number(valor)])
  );
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const fetchNativo = global.fetch;
  const sufixo = String(Date.now()).slice(-8);
  const contexto = {
    apiSenhaId: 980000000 + (process.pid % 100000),
    chassi: `9BGPM11A0${sufixo}`,
    protocolo: `TESTE-PAG-IDEM-${process.pid}-${sufixo}`,
    referencia: `REF-IDEM-${process.pid}-${sufixo}`
  };
  let pedidoId = null;
  let servidor = null;
  let erro = null;

  try {
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);

    const [[servico]] = await connection.query(
      `SELECT id, preco_base FROM servicos
        WHERE codigo = 'GM_SENHA' AND ativo = 1 LIMIT 1`
    );
    const [[cliente]] = await connection.query(
      'SELECT id FROM clientes WHERE ativo = 1 ORDER BY id LIMIT 1'
    );
    const [[usuario]] = await connection.query(
      "SELECT id, nome FROM usuarios WHERE status = 'ATIVO' ORDER BY id LIMIT 1"
    );

    assert.ok(servico && cliente && usuario, 'Base ativa para o teste é obrigatória');

    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda, fornecedor_id, origem_id)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE AUTOMATIZADO', 2026,
               'AGUARDANDO_PAGAMENTO', ?, 0, 'BRL', NULL, NULL)`,
      [contexto.protocolo, cliente.id, servico.id, contexto.chassi,
        Number(servico.preco_base || 1)]
    );
    pedidoId = pedido.insertId;

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;

    global.fetch = async (url, opcoes) => {
      if (String(url).startsWith(api.url)) {
        return fetchNativo(url, opcoes);
      }

      assert.match(String(url), /^https:\/\/mock\.joelpires\.invalid\//);
      return respostaHttp(200, [{
        id: contexto.apiSenhaId,
        id_montadora: 1,
        chassis: contexto.chassi,
        cod_mecanico: 'MEC-PAG-IDEM',
        cod_immo: 'IMMO-PAG-IDEM'
      }]);
    };

    const dadosPagamento = {
      meio_pagamento: 'PIX',
      referencia_externa: contexto.referencia,
      observacao: 'Teste automatizado transacional'
    };

    const primeira = await postPagamento(
      global.fetch,
      api.url,
      pedidoId,
      dadosPagamento
    );
    assert.strictEqual(primeira.status, 200);
    assert.strictEqual(primeira.corpo.ok, true);
    assert.strictEqual(primeira.corpo.idempotente, undefined);
    assert.strictEqual(primeira.corpo.pedido.status, 'CONCLUIDO');

    const totaisPrimeira = await contarRegistros(
      connection,
      pedidoId,
      contexto.referencia
    );
    assert.deepStrictEqual(totaisPrimeira, {
      lancamentos: 1,
      pagamentos: 1,
      historicos: 1,
      referencias: 1
    });

    const repetida = await postPagamento(
      global.fetch,
      api.url,
      pedidoId,
      dadosPagamento
    );
    assert.strictEqual(repetida.status, 200);
    assert.strictEqual(repetida.corpo.ok, true);
    assert.strictEqual(repetida.corpo.idempotente, true);
    assert.strictEqual(
      repetida.corpo.pagamento.id,
      primeira.corpo.pagamento.id
    );

    assert.deepStrictEqual(
      await contarRegistros(connection, pedidoId, contexto.referencia),
      totaisPrimeira,
      'Repetição idêntica não pode criar efeitos financeiros'
    );

    const divergente = await postPagamento(
      global.fetch,
      api.url,
      pedidoId,
      {
        ...dadosPagamento,
        referencia_externa: `${contexto.referencia}-OUTRA`
      }
    );
    assert.strictEqual(divergente.status, 409);
    assert.strictEqual(divergente.corpo.ok, false);

    assert.deepStrictEqual(
      await contarRegistros(connection, pedidoId, contexto.referencia),
      totaisPrimeira,
      'Nova referência não pode duplicar pedido já pago'
    );
  } catch (falha) {
    erro = falha;
  } finally {
    global.fetch = fetchNativo;

    try {
      await fecharServidor(servidor);
      await connection.rollback();

      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo = ?) AS pedidos,
           (SELECT COUNT(*) FROM pagamentos WHERE referencia_externa LIKE ?) AS pagamentos,
           (SELECT COUNT(*) FROM banco_senhas
             WHERE JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.api_senha_id')) = ?)
             AS cache`,
        [contexto.protocolo, `${contexto.referencia}%`, String(contexto.apiSenhaId)]
      );

      assert.deepStrictEqual(
        [Number(residuos.pedidos), Number(residuos.pagamentos), Number(residuos.cache)],
        [0, 0, 0],
        'Rollback deve remover pedido, pagamento e cache de teste'
      );
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: pagamento manual é idempotente e rollback foi confirmado');
}

executar().catch(erro => {
  console.error(`FALHA: teste de pagamento idempotente: ${erro.message}`);
  process.exitCode = 1;
});
