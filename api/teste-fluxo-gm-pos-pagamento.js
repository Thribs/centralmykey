'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const processarPedidoPago = require('./processar-pedido-pago');
const {
  buscarSenhaFonteVerdade
} = require('./consulta-api-joelpires');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH ||
    path.join(__dirname, '.env'),
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
process.env.APIJOELPIRES_TIMEOUT_MS = '10';

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

let sequencia = 0;

function proximoContexto() {
  sequencia += 1;
  const sufixo = String(70000000 + sequencia);
  return {
    apiSenhaId: 900000000 + process.pid * 100 + sequencia,
    chassi: `9BGAA11A0${sufixo}`,
    protocolo: `TESTE-GM-${process.pid}-${sequencia}`
  };
}

function respostaHttp(status, corpo) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(corpo)
  };
}

async function carregarBase(connection) {
  const [[servico]] = await connection.query(
    `SELECT id, codigo, preco_base
       FROM servicos
      WHERE codigo = 'GM_SENHA' AND ativo = 1
      LIMIT 1`
  );
  const [[cliente]] = await connection.query(
    `SELECT id FROM clientes WHERE ativo = 1 ORDER BY id LIMIT 1`
  );

  assert.ok(servico, 'Serviço GM_SENHA ativo é obrigatório');
  assert.ok(cliente, 'Cliente ativo é obrigatório para o teste transacional');
  return { servico, cliente };
}

async function criarPedidoTemporario(connection, contexto) {
  const { servico, cliente } = await carregarBase(connection);
  const [registro] = await connection.query(
    `INSERT INTO pedidos_senha
       (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
        status, valor_venda, custo, moeda, fornecedor_id, origem_id)
     VALUES (?, ?, ?, ?, 'GM', 'TESTE AUTOMATIZADO', 2026,
             'PAGO', ?, 0, 'BRL', NULL, NULL)`,
    [contexto.protocolo, cliente.id, servico.id, contexto.chassi,
      Number(servico.preco_base || 0)]
  );
  return registro.insertId;
}

async function buscarPedido(connection, pedidoId) {
  const [[pedido]] = await connection.query(
    `SELECT p.status, p.custo, p.fornecedor_id, os.codigo AS origem
       FROM pedidos_senha p
       LEFT JOIN origens_senha os ON os.id = p.origem_id
      WHERE p.id = ?`,
    [pedidoId]
  );
  return pedido;
}

async function confirmarRollback(connection, pedidoId, apiSenhaId) {
  if (pedidoId) {
    const [[restos]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM pedidos_senha WHERE id = ?) AS pedidos,
         (SELECT COUNT(*) FROM pedido_resultados WHERE pedido_id = ?) AS resultados,
         (SELECT COUNT(*) FROM pedido_historico WHERE pedido_id = ?) AS historicos`,
      [pedidoId, pedidoId, pedidoId]
    );
    assert.deepStrictEqual(
      [Number(restos.pedidos), Number(restos.resultados), Number(restos.historicos)],
      [0, 0, 0],
      'Rollback deve remover pedido, resultado e histórico de teste'
    );
  }

  if (apiSenhaId) {
    const [[cache]] = await connection.query(
      `SELECT COUNT(*) AS total
         FROM banco_senhas
        WHERE JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.api_senha_id')) = ?`,
      [String(apiSenhaId)]
    );
    assert.strictEqual(Number(cache.total), 0, 'Rollback deve remover o cache de teste');
  }
}

async function executarEmTransacao(
  nome,
  prepararFetch,
  statusConsultaEsperado,
  validar
) {
  const connection = await mysql.createConnection(configBanco);
  const contexto = proximoContexto();
  const fetchOriginal = global.fetch;
  let pedidoId;
  let erro;

  try {
    await connection.beginTransaction();
    await connection.query(
      "SET timestamp = UNIX_TIMESTAMP('2026-09-18 12:00:00')"
    );
    pedidoId = await criarPedidoTemporario(connection, contexto);
    global.fetch = prepararFetch(contexto);

    const classificacao = await buscarSenhaFonteVerdade(connection, {
      chassi: contexto.chassi,
      codigoServico: 'GM_SENHA',
      marca: 'GM',
      modelo: 'TESTE AUTOMATIZADO'
    });
    assert.strictEqual(classificacao.status, statusConsultaEsperado);

    if (classificacao.status === 'ENCONTRADO') {
      await connection.query(
        'DELETE FROM banco_senhas WHERE id = ?',
        [classificacao.senha.id]
      );
    }

    const processamento = await processarPedidoPago(connection, pedidoId, null);
    await validar({
      connection,
      contexto,
      pedidoId,
      processamento,
      classificacao
    });
  } catch (falha) {
    erro = falha;
  } finally {
    global.fetch = fetchOriginal;
    try {
      await connection.rollback();
      await confirmarRollback(connection, pedidoId, contexto.apiSenhaId);
    } catch (falhaRollback) {
      erro = erro || falhaRollback;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(`OK: ${nome} (rollback confirmado)`);
}

function mockEncontrado(contexto) {
  return async () => respostaHttp(200, [{
    id: contexto.apiSenhaId,
    id_montadora: 1,
    chassis: contexto.chassi,
    cod_mecanico: 'MEC-TESTE',
    cod_immo: 'IMMO-TESTE',
    cod_radio: 'RADIO-TESTE',
    cod_alarme: 'ALARME-TESTE',
    pin: 'PIN-TESTE'
  }]);
}

function mockErroHttp(status, nome = 'ErroDeTeste') {
  return () => async () => respostaHttp(status, {
    error: { name: nome, message: `HTTP ${status} simulado` }
  });
}

async function validarEncontrado({ connection, contexto, pedidoId, processamento }) {
  assert.strictEqual(processamento.status, 'CONCLUIDO');
  assert.strictEqual(processamento.origem, 'API_JOELPIRES');
  assert.strictEqual(processamento.resultado_automatico, true);

  const pedido = await buscarPedido(connection, pedidoId);
  assert.strictEqual(pedido.status, 'CONCLUIDO');
  assert.strictEqual(pedido.origem, 'API');
  assert.strictEqual(Number(pedido.custo), 0);
  assert.strictEqual(pedido.fornecedor_id, null);

  const [[resultado]] = await connection.query(
    `SELECT status, custo, fornecedor_id, banco_senha_id
       FROM pedido_resultados WHERE pedido_id = ?`,
    [pedidoId]
  );
  assert.ok(resultado, 'Resultado ENCONTRADO deve ser persistido');
  assert.strictEqual(resultado.status, 'CONFIRMADO');
  assert.strictEqual(Number(resultado.custo), 0);
  assert.strictEqual(resultado.fornecedor_id, null);

  const [[cache]] = await connection.query(
    `SELECT id, ativo
       FROM banco_senhas
      WHERE JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.fonte')) = 'API_JOELPIRES'
        AND JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.api_senha_id')) = ?`,
    [String(contexto.apiSenhaId)]
  );
  assert.ok(cache, 'Cache local deve ser alimentado');
  assert.strictEqual(Number(cache.ativo), 1);
  assert.strictEqual(Number(resultado.banco_senha_id), Number(cache.id));
}

async function validarNaoEncontrado({ connection, pedidoId, processamento }) {
  assert.strictEqual(processamento.status, 'EM_CONSULTA');
  assert.strictEqual(processamento.origem, 'FORNECEDOR');
  assert.ok(processamento.fornecedor_id);
  assert.ok(!processamento.api_indisponivel);

  const pedido = await buscarPedido(connection, pedidoId);
  assert.strictEqual(pedido.status, 'EM_CONSULTA');
  assert.strictEqual(pedido.origem, 'FORNECEDOR');
  assert.ok(pedido.fornecedor_id);
  assert.strictEqual(Number(pedido.custo), 22);

  const [[fornecedor]] = await connection.query(
    'SELECT nome FROM fornecedores WHERE id = ?',
    [pedido.fornecedor_id]
  );
  assert.strictEqual(fornecedor.nome, 'Márcio');

  const [[indisponibilidade]] = await connection.query(
    `SELECT COUNT(*) AS total FROM pedido_historico
      WHERE pedido_id = ? AND tipo = 'API_JOELPIRES_INDISPONIVEL'`,
    [pedidoId]
  );
  assert.strictEqual(Number(indisponibilidade.total), 0);
}

async function validarDadosInvalidos({ connection, pedidoId, processamento }) {
  assert.strictEqual(processamento.status, 'AGUARDANDO_DADOS');
  assert.strictEqual(processamento.origem, 'API_JOELPIRES');
  assert.strictEqual(processamento.dados_invalidos, true);

  const pedido = await buscarPedido(connection, pedidoId);
  assert.strictEqual(pedido.status, 'AGUARDANDO_DADOS');
  assert.strictEqual(Number(pedido.custo), 0);
  assert.strictEqual(pedido.fornecedor_id, null);
  assert.strictEqual(pedido.origem, null);

  const [[historico]] = await connection.query(
    `SELECT COUNT(*) AS total FROM pedido_historico
      WHERE pedido_id = ? AND tipo = 'DADOS_INVALIDOS_API_JOELPIRES'`,
    [pedidoId]
  );
  assert.strictEqual(Number(historico.total), 1);
}

async function validarIndisponivel({ connection, pedidoId, processamento }) {
  assert.strictEqual(processamento.status, 'ABERTO');
  assert.strictEqual(processamento.origem, 'API_JOELPIRES');
  assert.strictEqual(processamento.api_indisponivel, true);
  assert.strictEqual(processamento.aguardando_reprocessamento, true);

  const pedido = await buscarPedido(connection, pedidoId);
  assert.strictEqual(pedido.status, 'ABERTO');
  assert.strictEqual(Number(pedido.custo), 0);
  assert.strictEqual(pedido.fornecedor_id, null);
  assert.strictEqual(pedido.origem, null);

  const [[historico]] = await connection.query(
    `SELECT COUNT(*) AS total FROM pedido_historico
      WHERE pedido_id = ? AND tipo = 'API_JOELPIRES_INDISPONIVEL'`,
    [pedidoId]
  );
  assert.strictEqual(Number(historico.total), 1);
}

async function executar() {
  await executarEmTransacao(
    'API encontra senha e alimenta cache',
    mockEncontrado,
    'ENCONTRADO',
    validarEncontrado
  );
  await executarEmTransacao(
    '404 SenhaNotFoundError encaminha ao fornecedor',
    mockErroHttp(404, 'SenhaNotFoundError'),
    'NAO_ENCONTRADO',
    validarNaoEncontrado
  );

  for (const status of [400, 417, 422]) {
    await executarEmTransacao(
      `HTTP ${status} mantém AGUARDANDO_DADOS`,
      mockErroHttp(status),
      'DADOS_INVALIDOS',
      validarDadosInvalidos
    );
  }

  await executarEmTransacao(
    'falha de rede aguarda reprocessamento',
    () => async () => {
      throw new TypeError('Falha de rede simulada');
    },
    'INDISPONIVEL',
    validarIndisponivel
  );
  await executarEmTransacao(
    'timeout aguarda reprocessamento',
    () => async () => {
      const erro = new Error('Timeout simulado');
      erro.name = 'AbortError';
      throw erro;
    },
    'INDISPONIVEL',
    validarIndisponivel
  );
  await executarEmTransacao(
    'HTTP 5xx aguarda reprocessamento',
    mockErroHttp(503),
    'INDISPONIVEL',
    validarIndisponivel
  );
}

executar().catch(erro => {
  console.error(`FALHA: testes funcionais do fluxo GM: ${erro.message}`);
  process.exitCode = 1;
});
