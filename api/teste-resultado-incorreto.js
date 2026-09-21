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

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const sufixo = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const protocolo = `TI${process.pid}${String(Date.now()).slice(-7)}`;
  const nomeAtual = `FORNECEDOR RESULTADO ATUAL ${sufixo}`;
  const nomeProximo = `FORNECEDOR RESULTADO PROXIMO ${sufixo}`;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);
    await connection.query(
      `CREATE TEMPORARY TABLE fornecedor_servicos (
         id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
         fornecedor_id BIGINT NOT NULL,
         codigo_servico VARCHAR(60) NOT NULL,
         custo DECIMAL(12,2) NOT NULL,
         ativo TINYINT(1) NOT NULL
       ) ENGINE=InnoDB`
    );

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

    const [fornecedorAtual] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, '5511555555501', 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [nomeAtual]
    );
    const [fornecedorProximo] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, '5511555555502', 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [nomeProximo]
    );
    await connection.query(
      `INSERT INTO fornecedor_servicos
         (fornecedor_id, codigo_servico, custo, ativo)
       VALUES (?, 'GM_SENHA', 25, 1)`,
      [fornecedorProximo.insertId]
    );

    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda, fornecedor_id, origem_id)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE INCORRETO', 2026,
               'CONCLUIDO', 60, 22, 'BRL', ?, 2)`,
      [
        protocolo,
        cliente.id,
        servico.id,
        `9BGIR11A0${String(Date.now()).slice(-8)}`,
        fornecedorAtual.insertId
      ]
    );
    const [resultado] = await connection.query(
      `INSERT INTO pedido_resultados
         (pedido_id, origem_id, fornecedor_id, codigo_mecanico,
          resultado, custo, status)
       VALUES (?, 2, ?, 'MC-INCORRETO', '{}', 22, 'ENCONTRADO')`,
      [pedido.insertId, fornecedorAtual.insertId]
    );

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;
    const url = `${api.url}/api/pedidos/${pedido.insertId}/resultado/incorreto`;
    const opcoes = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo: 'Código mecânico não funcionou' })
    };

    const resposta = await fetch(url, opcoes);
    const corpo = await resposta.json();
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(corpo.ok, true);
    assert.strictEqual(corpo.pedido.status, 'EM_CONSULTA');
    assert.strictEqual(corpo.fornecedor.id, fornecedorProximo.insertId);
    assert.strictEqual(corpo.fornecedor.custo, 25);
    assert.strictEqual(corpo.fornecedor.envio.status, 'PENDENTE');

    const repetida = await fetch(url, opcoes);
    assert.strictEqual(repetida.status, 409);

    const [[estado]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM pedido_resultados
           WHERE id = ? AND status = 'INCORRETO') AS resultado_incorreto,
         (SELECT COUNT(*) FROM pedidos_senha
           WHERE id = ? AND status = 'EM_CONSULTA'
             AND fornecedor_id = ? AND custo = 25) AS pedido_redirecionado,
         (SELECT COUNT(*) FROM comunicacoes_outbox
           WHERE pedido_id = ? AND fornecedor_id = ?
             AND finalidade = 'CONSULTA_FORNECEDOR'
             AND status = 'PENDENTE') AS consultas,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'RESULTADO_INCORRETO') AS historicos`,
      [
        resultado.insertId,
        pedido.insertId,
        fornecedorProximo.insertId,
        pedido.insertId,
        fornecedorProximo.insertId,
        pedido.insertId
      ]
    );
    assert.deepStrictEqual(Object.values(estado).map(Number), [1, 1, 1, 1]);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo = ?) AS pedidos,
           (SELECT COUNT(*) FROM fornecedores WHERE nome IN (?, ?)) AS fornecedores`,
        [protocolo, nomeAtual, nomeProximo]
      );
      assert.deepStrictEqual(
        Object.values(residuos).map(Number),
        [0, 0],
        'Rollback deve remover pedido e fornecedores fictícios'
      );
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: resultado incorreto segue uma vez ao próximo fornecedor (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de resultado incorreto: ${erro.message}`);
  process.exitCode = 1;
});
