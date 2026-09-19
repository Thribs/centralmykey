'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  agendarConsultaFornecedor
} = require('./agendar-consulta-fornecedor');
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

async function requisicaoJson(url, opcoes = {}) {
  const resposta = await fetch(url, opcoes);
  return { resposta, corpo: await resposta.json() };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const sufixo = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const prefixoProtocolo = `TR${process.pid}${String(Date.now()).slice(-6)}`;
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
    assert.ok(servico && usuario, 'Serviço e usuário ativos são obrigatórios');

    const telefone = `5597${String(Date.now()).slice(-8)}`;
    const [cliente] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, credito_status)
       VALUES (?, ?, ?, 'COMPLETO', 1, 'ANTECIPADO', 'LIBERADO')`,
      [`CLIENTE RETORNO ${sufixo}`, telefone, telefone]
    );
    const [fornecedor] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, '5511777777777', 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [`FORNECEDOR RETORNO ${sufixo}`]
    );

    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda, fornecedor_id, origem_id)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE RETORNO', 2026,
               'EM_CONSULTA', 50, 22, 'BRL', ?, 2)`,
      [
        `${prefixoProtocolo}-OK`,
        cliente.insertId,
        servico.id,
        `9BGRT11A0${String(Date.now()).slice(-8)}`,
        fornecedor.insertId
      ]
    );
    const [pedidoInvalido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda, fornecedor_id, origem_id)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE SEM ENVIO', 2026,
               'ABERTO', 50, 0, 'BRL', NULL, NULL)`,
      [
        `${prefixoProtocolo}-INVALIDO`,
        cliente.insertId,
        servico.id,
        `9BGIV11A0${String(Date.now() + 1).slice(-8)}`
      ]
    );

    const comunicacao = await agendarConsultaFornecedor(connection, {
      pedido: {
        id: pedido.insertId,
        protocolo: `${prefixoProtocolo}-OK`,
        chassi: `9BGRT11A0${String(Date.now()).slice(-8)}`,
        marca: 'GM',
        modelo: 'TESTE RETORNO',
        ano: 2026
      },
      fornecedor: {
        fornecedor_id: fornecedor.insertId,
        whatsapp: '5511777777777'
      },
      usuarioId: usuario.id
    });
    assert.strictEqual(comunicacao.status, 'PENDENTE');

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;
    const cabecalhos = { 'Content-Type': 'application/json' };

    const invalido = await requisicaoJson(
      `${api.url}/api/pedidos/${pedidoInvalido.insertId}/resultado`,
      {
        method: 'POST',
        headers: cabecalhos,
        body: JSON.stringify({ codigo_mecanico: 'NAO-DEVE-SALVAR' })
      }
    );
    assert.strictEqual(invalido.resposta.status, 409);

    const dados = {
      codigo_mecanico: '  MC-123  ',
      codigo_imobilizador: 'IM-456',
      codigo_alarme: 'AL-789',
      resultado: { b: 2, a: 1 }
    };
    const primeiro = await requisicaoJson(
      `${api.url}/api/pedidos/${pedido.insertId}/resultado`,
      {
        method: 'POST',
        headers: cabecalhos,
        body: JSON.stringify(dados)
      }
    );
    assert.strictEqual(primeiro.resposta.status, 201);
    assert.strictEqual(primeiro.corpo.ok, true);
    assert.strictEqual(primeiro.corpo.resultado.codigo_mecanico, 'MC-123');

    const repetido = await requisicaoJson(
      `${api.url}/api/pedidos/${pedido.insertId}/resultado`,
      {
        method: 'POST',
        headers: cabecalhos,
        body: JSON.stringify({
          codigo_mecanico: 'MC-123',
          codigo_imobilizador: 'IM-456',
          codigo_alarme: 'AL-789',
          resultado: { a: 1, b: 2 }
        })
      }
    );
    assert.strictEqual(repetido.resposta.status, 200);
    assert.strictEqual(repetido.corpo.idempotente, true);
    assert.strictEqual(
      repetido.corpo.resultado.id,
      primeiro.corpo.resultado.id
    );

    const divergente = await requisicaoJson(
      `${api.url}/api/pedidos/${pedido.insertId}/resultado`,
      {
        method: 'POST',
        headers: cabecalhos,
        body: JSON.stringify({ codigo_mecanico: 'OUTRO-CODIGO' })
      }
    );
    assert.strictEqual(divergente.resposta.status, 409);

    const [[estado]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM pedido_resultados WHERE pedido_id = ?) AS resultados,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'RESULTADO_RECEBIDO') AS historicos,
         (SELECT COUNT(*) FROM comunicacoes_outbox
           WHERE pedido_id = ? AND status = 'CANCELADA') AS canceladas,
         (SELECT COUNT(*) FROM pedido_resultados
           WHERE pedido_id = ? AND custo = 22 AND status = 'ENCONTRADO') AS custo_correto,
         (SELECT COUNT(*) FROM pedido_resultados
           WHERE pedido_id = ?) AS resultados_invalidos`,
      [
        pedido.insertId,
        pedido.insertId,
        pedido.insertId,
        pedido.insertId,
        pedidoInvalido.insertId
      ]
    );
    assert.deepStrictEqual(
      Object.values(estado).map(Number),
      [1, 1, 1, 1, 0]
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha
             WHERE protocolo LIKE ?) AS pedidos,
           (SELECT COUNT(*) FROM clientes WHERE nome = ?) AS clientes,
           (SELECT COUNT(*) FROM fornecedores WHERE nome = ?) AS fornecedores`,
        [
          `${prefixoProtocolo}%`,
          `CLIENTE RETORNO ${sufixo}`,
          `FORNECEDOR RETORNO ${sufixo}`
        ]
      );
      assert.deepStrictEqual(
        Object.values(residuos).map(Number),
        [0, 0, 0],
        'Rollback deve remover todos os dados fictícios do retorno'
      );
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: retorno do fornecedor valida estado e é idempotente (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste do retorno do fornecedor: ${erro.message}`);
  process.exitCode = 1;
});
