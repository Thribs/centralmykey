'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { criarTabelaOutboxTemporaria } = require('./teste-suporte-outbox');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
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
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-pedidos')(app, poolTransacional(connection));
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

async function postar(url, corpo) {
  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo)
  });
  return { resposta, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const fetchOriginal = global.fetch;
  const marcador = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const prefixo = `TD${process.pid}${String(Date.now()).slice(-5)}`;
  const chassiCorrigido = `9BGCD11A0${String(Date.now()).slice(-8)}`;
  const apiSenhaId = 800000000 + process.pid;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);
    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[usuario]] = await connection.query(
      "SELECT id, nome FROM usuarios WHERE status='ATIVO' ORDER BY id LIMIT 1"
    );
    const [[cliente]] = await connection.query(
      'SELECT id FROM clientes WHERE ativo=1 ORDER BY id LIMIT 1'
    );
    assert.ok(servico && usuario && cliente, 'Base ativa é obrigatória');

    async function criarPedido(sufixo, status) {
      const [pedido] = await connection.query(
        `INSERT INTO pedidos_senha
           (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
            status, valor_venda, custo, moeda)
         VALUES (?, ?, ?, ?, 'GM', 'MODELO INCORRETO', 2025,
                 ?, 50, 0, 'BRL')`,
        [
          `${prefixo}-${sufixo}`,
          cliente.id,
          servico.id,
          `9BGXX11A0${String(Date.now()).slice(-8)}`,
          status
        ]
      );
      return pedido.insertId;
    }

    const pedidoId = await criarPedido('CORRIGIR', 'AGUARDANDO_DADOS');
    const pedidoAberto = await criarPedido('ABERTO', 'ABERTO');
    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;
    global.fetch = async (url, opcoes) => {
      if (String(url).startsWith(api.url)) return fetchOriginal(url, opcoes);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{
          id: apiSenhaId,
          id_montadora: 1,
          chassis: chassiCorrigido,
          cod_mecanico: 'MC-CORRIGIDO'
        }])
      };
    };

    const dados = {
      chassi: chassiCorrigido.toLowerCase(),
      marca: 'gm',
      modelo: 'onix',
      ano: 2026
    };
    const estadoInvalido = await postar(
      `${api.url}/api/pedidos/${pedidoAberto}/corrigir-dados`,
      dados
    );
    assert.strictEqual(estadoInvalido.resposta.status, 409);
    assert.strictEqual(estadoInvalido.corpo.codigo, 'PEDIDO_NAO_AGUARDA_DADOS');

    const chassiInvalido = await postar(
      `${api.url}/api/pedidos/${pedidoId}/corrigir-dados`,
      { ...dados, chassi: '123' }
    );
    assert.strictEqual(chassiInvalido.resposta.status, 400);

    const corrigido = await postar(
      `${api.url}/api/pedidos/${pedidoId}/corrigir-dados`,
      dados
    );
    assert.strictEqual(corrigido.resposta.status, 200);
    assert.strictEqual(corrigido.corpo.processamento.status, 'CONCLUIDO');
    assert.strictEqual(corrigido.corpo.dados.chassi, chassiCorrigido);

    const [[estado]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM pedidos_senha
           WHERE id = ? AND status = 'CONCLUIDO' AND chassi = ?
             AND marca = 'GM' AND modelo = 'ONIX' AND ano = 2026
             AND fornecedor_id IS NULL AND custo = 0) AS pedido,
         (SELECT COUNT(*) FROM pedido_resultados
           WHERE pedido_id = ? AND status = 'CONFIRMADO'
             AND codigo_mecanico = 'MC-CORRIGIDO') AS resultados,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'DADOS_PEDIDO_CORRIGIDOS') AS correcoes,
         (SELECT COUNT(*) FROM auditoria
           WHERE entidade = 'pedidos_senha' AND entidade_id = ?
             AND acao = 'CORRIGIR_DADOS') AS auditorias,
         (SELECT COUNT(*) FROM comunicacoes_outbox
           WHERE pedido_id = ? AND finalidade = 'ENTREGA_CLIENTE'
             AND status = 'PENDENTE') AS entregas`,
      [
        pedidoId,
        chassiCorrigido,
        pedidoId,
        pedidoId,
        String(pedidoId),
        pedidoId
      ]
    );
    assert.deepStrictEqual(Object.values(estado).map(Number), [1, 1, 1, 1, 1]);
  } catch (falha) {
    erro = falha;
  } finally {
    global.fetch = fetchOriginal;
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo LIKE ?) AS pedidos,
           (SELECT COUNT(*) FROM banco_senhas
             WHERE JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.api_senha_id')) = ?) AS cache`,
        [`${prefixo}%`, String(apiSenhaId)]
      );
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0]);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: dados GM são corrigidos e reprocessados atomicamente (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de correção de dados GM: ${erro.message}`);
  process.exitCode = 1;
});
