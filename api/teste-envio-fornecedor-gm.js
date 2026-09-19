'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const processarPedidoPago = require('./processar-pedido-pago');
const {
  agendarConsultaFornecedor,
  reagendarConsultaFornecedor
} = require('./agendar-consulta-fornecedor');
const {
  processarComunicacao,
  processarComunicacoesOutbox
} = require('./processar-comunicacoes-outbox');
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

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const fetchOriginal = global.fetch;
  const sufixo = String(Date.now()).slice(-8);
  const protocolo = `TESTE-ENVIO-GM-${process.pid}-${sufixo}`;
  let pedidoId;
  let erro;

  try {
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);
    await connection.query(
      "SET timestamp = UNIX_TIMESTAMP('2026-09-18 12:00:00')"
    );

    const [[servico]] = await connection.query(
      "SELECT id, preco_base FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[cliente]] = await connection.query(
      'SELECT id FROM clientes WHERE ativo=1 ORDER BY id LIMIT 1'
    );
    assert.ok(servico && cliente, 'Base ativa do fluxo GM é obrigatória');

    const [fornecedorTeste] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, '5511999999999', 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [`TESTE AUTOMATIZADO ${process.pid}-${sufixo}`]
    );
    await connection.query(
      `INSERT INTO fornecedor_servicos
         (fornecedor_id, codigo_servico, descricao, marca, custo, moeda, ativo)
       VALUES (?, 'GM_SENHA', 'TESTE AUTOMATIZADO', 'GM', 0.01, 'BRL', 1)`,
      [fornecedorTeste.insertId]
    );

    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda, fornecedor_id, origem_id)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE ENVIO', 2026,
               'PAGO', ?, 0, 'BRL', NULL, NULL)`,
      [
        protocolo,
        cliente.id,
        servico.id,
        `9BGWE11A0${sufixo}`,
        Number(servico.preco_base || 1)
      ]
    );
    pedidoId = pedido.insertId;

    global.fetch = async () => respostaHttp(404, {
      error: {
        name: 'SenhaNotFoundError',
        message: 'Não encontrada (simulado)'
      }
    });

    const processamento = await processarPedidoPago(
      connection,
      pedidoId,
      null
    );
    assert.strictEqual(processamento.status, 'EM_CONSULTA');
    assert.strictEqual(processamento.origem, 'FORNECEDOR');
    assert.strictEqual(processamento.fornecedor_id, fornecedorTeste.insertId);
    assert.strictEqual(processamento.comunicacao.status, 'PENDENTE');

    const [[comunicacao]] = await connection.query(
      `SELECT * FROM comunicacoes_outbox WHERE pedido_id = ? LIMIT 1`,
      [pedidoId]
    );
    assert.ok(comunicacao, 'Consulta ao fornecedor deve entrar na outbox');
    assert.strictEqual(comunicacao.status, 'PENDENTE');
    assert.match(comunicacao.destinatario, /^\d{10,15}$/);

    const [[fornecedor]] = await connection.query(
      `SELECT id AS fornecedor_id, nome AS fornecedor, whatsapp, telefone
         FROM fornecedores WHERE id = ? LIMIT 1`,
      [processamento.fornecedor_id]
    );
    const [[pedidoCompleto]] = await connection.query(
      `SELECT id, protocolo, chassi, marca, modelo, ano
         FROM pedidos_senha WHERE id = ?`,
      [pedidoId]
    );

    const repeticaoAgenda = await agendarConsultaFornecedor(connection, {
      pedido: pedidoCompleto,
      fornecedor,
      usuarioId: null
    });
    assert.strictEqual(repeticaoAgenda.criada, false);
    assert.strictEqual(repeticaoAgenda.id, comunicacao.id);

    const [[agendamentos]] = await connection.query(
      `SELECT COUNT(*) AS total FROM pedido_historico
        WHERE pedido_id = ? AND tipo = 'CONSULTA_FORNECEDOR_AGENDADA'`,
      [pedidoId]
    );
    assert.strictEqual(Number(agendamentos.total), 1);

    const chamadas = [];
    const enviarModelo = async dados => {
      chamadas.push(dados);
      return { mensagem_externa_id: 'wamid.mock.fornecedor.1' };
    };

    const envio = await processarComunicacao(
      connection,
      comunicacao.id,
      enviarModelo,
      {
        nomeModelo: 'consulta_fornecedor_gm_teste',
        idiomaModelo: 'pt_BR'
      }
    );
    assert.strictEqual(envio.status, 'ENVIADA');
    assert.strictEqual(chamadas.length, 1);
    assert.strictEqual(chamadas[0].telefone, comunicacao.destinatario);
    assert.strictEqual(chamadas[0].parametros[0], protocolo);

    const repeticaoEnvio = await processarComunicacao(
      connection,
      comunicacao.id,
      enviarModelo,
      { nomeModelo: 'consulta_fornecedor_gm_teste' }
    );
    assert.deepStrictEqual(repeticaoEnvio, {
      processada: false,
      motivo: 'NAO_PENDENTE'
    });
    assert.strictEqual(chamadas.length, 1, 'Envio concluído não pode repetir');

    const [incerta] = await connection.query(
      `INSERT INTO comunicacoes_outbox
         (chave_idempotencia, canal, finalidade, pedido_id,
          fornecedor_id, destinatario, payload, status)
       VALUES (?, 'WHATSAPP', 'CONSULTA_FORNECEDOR', ?, ?, ?, ?, 'PENDENTE')`,
      [
        `TESTE_INCERTO:${pedidoId}`,
        pedidoId,
        processamento.fornecedor_id,
        comunicacao.destinatario,
        JSON.stringify({ tipo: 'MODELO_WHATSAPP', parametros: [protocolo] })
      ]
    );

    const resultadoIncerto = await processarComunicacao(
      connection,
      incerta.insertId,
      async () => {
        const falha = new Error('Timeout simulado');
        falha.name = 'AbortError';
        throw falha;
      },
      { nomeModelo: 'consulta_fornecedor_gm_teste' }
    );
    assert.strictEqual(resultadoIncerto.status, 'INCERTA');

    await assert.rejects(
      () => reagendarConsultaFornecedor(connection, {
        pedidoId,
        comunicacaoId: incerta.insertId,
        confirmarIncerto: false
      }),
      erroReagendamento =>
        erroReagendamento.codigo === 'ENVIO_INCERTO_EXIGE_CONFIRMACAO'
    );

    const reagendada = await reagendarConsultaFornecedor(connection, {
      pedidoId,
      comunicacaoId: incerta.insertId,
      confirmarIncerto: true
    });
    assert.strictEqual(reagendada.status, 'PENDENTE');

    const ciclo = await processarComunicacoesOutbox(
      {
        getConnection: async () => ({
          query: (...argumentos) => connection.query(...argumentos),
          release: () => {}
        })
      },
      enviarModelo,
      {
        habilitado: true,
        limite: 10,
        nomeModelo: 'consulta_fornecedor_gm_teste',
        idiomaModelo: 'pt_BR'
      }
    );
    assert.strictEqual(ciclo.executado, true);
    assert.strictEqual(ciclo.encontrados, 1);
    assert.strictEqual(ciclo.enviados, 1);

    const [[estadoFinal]] = await connection.query(
      `SELECT status, tentativas, mensagem_externa_id
         FROM comunicacoes_outbox WHERE id = ?`,
      [comunicacao.id]
    );
    assert.deepStrictEqual(
      {
        status: estadoFinal.status,
        tentativas: Number(estadoFinal.tentativas),
        mensagem_externa_id: estadoFinal.mensagem_externa_id
      },
      {
        status: 'ENVIADA',
        tentativas: 1,
        mensagem_externa_id: 'wamid.mock.fornecedor.1'
      }
    );
  } catch (falha) {
    erro = falha;
  } finally {
    global.fetch = fetchOriginal;
    try {
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo = ?) AS pedidos,
           (SELECT COUNT(*) FROM fornecedores WHERE nome LIKE ?) AS fornecedores`,
        [protocolo, `TESTE AUTOMATIZADO ${process.pid}-${sufixo}%`]
      );
      assert.deepStrictEqual(
        Object.values(residuos).map(Number),
        [0, 0],
        'Rollback deve remover pedido e fornecedor de teste'
      );
    } catch (falhaRollback) {
      erro = erro || falhaRollback;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: consulta GM é agendada e enviada uma única vez (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: teste de envio ao fornecedor: ${erro.message}`);
  process.exitCode = 1;
});
