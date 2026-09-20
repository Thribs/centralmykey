'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  processarComunicacao
} = require('./processar-comunicacoes-outbox');
const {
  criarTabelaOutboxTemporaria
} = require('./teste-suporte-outbox');
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
  const marcador = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const protocolo = `TE${process.pid}${String(Date.now()).slice(-6)}`;
  const finalChassi = String(Date.now()).slice(-8);
  const chassi = `9BGEC11A0${finalChassi}`;
  let servidor;
  let erro;

  try {
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);
    await criarTabelasNotificacoesTemporarias(connection);

    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[usuario]] = await connection.query(
      "SELECT id, nome FROM usuarios WHERE status='ATIVO' ORDER BY id LIMIT 1"
    );
    assert.ok(servico && usuario, 'Serviço e usuário ativos são obrigatórios');

    const telefone = `5596${String(Date.now()).slice(-8)}`;
    const [cliente] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, credito_status)
       VALUES (?, ?, ?, 'COMPLETO', 1, 'ANTECIPADO', 'LIBERADO')`,
      [`CLIENTE ENTREGA ${marcador}`, telefone, telefone]
    );
    const [fornecedor] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, '5511666666666', 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [`FORNECEDOR ENTREGA ${marcador}`]
    );
    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda, fornecedor_id, origem_id)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE ENTREGA', 2026,
               'CONCLUIDO', 50, 22, 'BRL', ?, 2)`,
      [protocolo, cliente.insertId, servico.id, chassi, fornecedor.insertId]
    );
    const [resultado] = await connection.query(
      `INSERT INTO pedido_resultados
         (pedido_id, origem_id, fornecedor_id, codigo_mecanico,
          codigo_imobilizador, codigo_radio, pin, resultado, custo, status)
       VALUES (?, 2, ?, 'MC-ENTREGA', 'IM-ENTREGA',
               'RD-ENTREGA', 'PIN-ENTREGA', ?, 22, 'ENCONTRADO')`,
      [
        pedido.insertId,
        fornecedor.insertId,
        JSON.stringify({ codigo_alarme: 'AL-ENTREGA' })
      ]
    );

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;
    const respostaConfirmacao = await fetch(
      `${api.url}/api/pedidos/${pedido.insertId}/resultado/confirmar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }
    );
    const confirmacao = await respostaConfirmacao.json();
    assert.strictEqual(respostaConfirmacao.status, 200);
    assert.strictEqual(confirmacao.ok, true);
    assert.strictEqual(confirmacao.resultado_id, resultado.insertId);
    assert.strictEqual(confirmacao.entrega.status, 'PENDENTE');

    const [[comunicacao]] = await connection.query(
      `SELECT * FROM comunicacoes_outbox
        WHERE pedido_id = ? AND finalidade = 'ENTREGA_CLIENTE'`,
      [pedido.insertId]
    );
    assert.ok(comunicacao, 'Entrega deve ser criada na mesma transação');
    assert.strictEqual(comunicacao.resultado_id, resultado.insertId);
    assert.strictEqual(comunicacao.destinatario, telefone);

    await connection.query(
      `UPDATE comunicacoes_outbox
          SET status = 'FALHOU', erro_codigo = 'FALHA_SIMULADA'
        WHERE id = ?`,
      [comunicacao.id]
    );
    const respostaReagendamento = await fetch(
      `${api.url}/api/pedidos/${pedido.insertId}` +
        `/comunicacoes/${comunicacao.id}/reprocessar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }
    );
    const reagendamento = await respostaReagendamento.json();
    assert.strictEqual(respostaReagendamento.status, 200);
    assert.strictEqual(reagendamento.comunicacao.status, 'PENDENTE');

    const chamadas = [];
    const envio = await processarComunicacao(
      connection,
      comunicacao.id,
      async dados => {
        chamadas.push(dados);
        return { mensagem_externa_id: 'wamid.mock.entrega.1' };
      },
      {
        nomeModeloEntrega: 'entrega_resultado_teste',
        idiomaModelo: 'pt_BR'
      }
    );
    assert.strictEqual(envio.status, 'ENVIADA');
    assert.strictEqual(chamadas.length, 1);
    assert.strictEqual(chamadas[0].nome, 'entrega_resultado_teste');
    assert.deepStrictEqual(chamadas[0].parametros, [
      protocolo,
      'MC-ENTREGA',
      'IM-ENTREGA',
      'RD-ENTREGA',
      'AL-ENTREGA',
      'PIN-ENTREGA'
    ]);

    const repeticao = await processarComunicacao(
      connection,
      comunicacao.id,
      async () => {
        throw new Error('Não deveria reenviar');
      },
      { nomeModeloEntrega: 'entrega_resultado_teste' }
    );
    assert.deepStrictEqual(repeticao, {
      processada: false,
      motivo: 'NAO_PENDENTE'
    });

    const respostaDetalhe = await fetch(
      `${api.url}/api/pedidos/${pedido.insertId}`
    );
    const detalhe = await respostaDetalhe.json();
    assert.strictEqual(respostaDetalhe.status, 200);
    const entregaDetalhe = detalhe.comunicacoes.find(
      item => item.finalidade === 'ENTREGA_CLIENTE'
    );
    assert.strictEqual(entregaDetalhe.status, 'ENVIADA');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(entregaDetalhe, 'destinatario'),
      false,
      'O telefone do cliente não deve ser exposto no detalhe'
    );

    const [[estado]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM pedido_resultados
           WHERE id = ? AND status = 'CONFIRMADO') AS confirmados,
         (SELECT COUNT(*) FROM banco_senhas
           WHERE chassi = ? AND ativo = 1) AS cache,
         (SELECT COUNT(*) FROM comunicacoes_outbox
           WHERE pedido_id = ? AND finalidade = 'ENTREGA_CLIENTE') AS entregas,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'ENTREGA_CLIENTE_AGENDADA') AS agendamentos,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'RESULTADO_ENVIADO_CLIENTE') AS envios,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'ENTREGA_CLIENTE_REAGENDADA') AS reagendamentos`,
      [
        resultado.insertId,
        chassi,
        pedido.insertId,
        pedido.insertId,
        pedido.insertId,
        pedido.insertId
      ]
    );
    assert.deepStrictEqual(
      Object.values(estado).map(Number),
      [1, 1, 1, 1, 1, 1]
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo = ?) AS pedidos,
           (SELECT COUNT(*) FROM banco_senhas WHERE chassi = ?) AS cache,
           (SELECT COUNT(*) FROM clientes WHERE nome = ?) AS clientes,
           (SELECT COUNT(*) FROM fornecedores WHERE nome = ?) AS fornecedores`,
        [
          protocolo,
          chassi,
          `CLIENTE ENTREGA ${marcador}`,
          `FORNECEDOR ENTREGA ${marcador}`
        ]
      );
      assert.deepStrictEqual(
        Object.values(residuos).map(Number),
        [0, 0, 0, 0],
        'Rollback deve remover todos os dados fictícios da entrega'
      );
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: resultado confirmado é entregue uma única vez (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste da entrega ao cliente: ${erro.message}`);
  process.exitCode = 1;
});
