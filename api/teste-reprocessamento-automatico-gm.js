'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  listarCandidatos,
  obterConfiguracao,
  processarCandidato,
  reprocessarPedidosGm
} = require('./reprocessar-pedidos-gm');

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
process.env.APIJOELPIRES_TIMEOUT_MS = '10';

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

let sequencia = 0;

function respostaHttp(status, corpo) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(corpo)
  };
}

async function criarPedido(connection, ultimoHistorico) {
  sequencia += 1;
  const sufixo = String(80000000 + sequencia);
  const contexto = {
    apiSenhaId: 910000000 + process.pid * 100 + sequencia,
    chassi: `9BGAA11A0${sufixo}`,
    protocolo: `TESTE-RETRY-${process.pid}-${sequencia}`
  };
  const [[servico]] = await connection.query(
    "SELECT id, preco_base FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
  );
  const [[cliente]] = await connection.query(
    'SELECT id FROM clientes WHERE ativo=1 ORDER BY id LIMIT 1'
  );
  assert.ok(servico && cliente, 'Configuração base do fluxo GM é obrigatória');

  const [registro] = await connection.query(
    `INSERT INTO pedidos_senha
       (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
        status, valor_venda, custo, moeda, fornecedor_id, origem_id)
     VALUES (?, ?, ?, ?, 'GM', 'TESTE RETENTATIVA', 2026,
             'ABERTO', ?, 0, 'BRL', NULL, NULL)`,
    [contexto.protocolo, cliente.id, servico.id, contexto.chassi,
      Number(servico.preco_base || 0)]
  );
  contexto.pedidoId = registro.insertId;

  await connection.query(
    `INSERT INTO pedido_historico
       (pedido_id, usuario_id, tipo, descricao, dados)
     VALUES (?, NULL, ?, 'Histórico de teste', JSON_OBJECT())`,
    [contexto.pedidoId, ultimoHistorico]
  );
  return contexto;
}

async function confirmarAusencia(connection, contexto) {
  const [[restos]] = await connection.query(
    `SELECT
       (SELECT COUNT(*) FROM pedidos_senha WHERE id=?) pedidos,
       (SELECT COUNT(*) FROM pedido_historico WHERE pedido_id=?) historicos,
       (SELECT COUNT(*) FROM pedido_resultados WHERE pedido_id=?) resultados,
       (SELECT COUNT(*) FROM banco_senhas
         WHERE JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.api_senha_id'))=?) cache`,
    [contexto.pedidoId, contexto.pedidoId, contexto.pedidoId,
      String(contexto.apiSenhaId)]
  );
  assert.deepStrictEqual(
    Object.values(restos).map(Number),
    [0, 0, 0, 0],
    'Rollback deve remover todos os registros da retentativa'
  );
}

async function emTransacao(ultimoHistorico, executar) {
  const connection = await mysql.createConnection(configBanco);
  let contexto;
  let erro;
  try {
    await connection.beginTransaction();
    await connection.query("SET timestamp=UNIX_TIMESTAMP('2026-09-18 12:00:00')");
    contexto = await criarPedido(connection, ultimoHistorico);
    await executar(connection, contexto);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await connection.rollback();
      if (contexto) await confirmarAusencia(connection, contexto);
    } catch (falhaRollback) {
      erro = erro || falhaRollback;
    } finally {
      await connection.end();
    }
  }
  if (erro) throw erro;
}

async function testarEncontrado() {
  const fetchOriginal = global.fetch;
  try {
    await emTransacao('API_JOELPIRES_INDISPONIVEL', async (connection, contexto) => {
      const candidatos = await listarCandidatos(connection, {
        esperaSegundos: 0,
        limite: 10
      });
      assert.ok(candidatos.includes(Number(contexto.pedidoId)));

      global.fetch = async () => respostaHttp(200, [{
        id: contexto.apiSenhaId,
        id_montadora: 1,
        chassis: contexto.chassi,
        cod_mecanico: 'MEC-RETRY'
      }]);
      const tentativa = await processarCandidato(connection, contexto.pedidoId);
      assert.strictEqual(tentativa.processado, true);
      assert.strictEqual(tentativa.resultado.status, 'CONCLUIDO');
      assert.strictEqual(tentativa.resultado.origem, 'API_JOELPIRES');

      const [[estado]] = await connection.query(
        `SELECT p.status, p.custo, p.fornecedor_id,
          (SELECT COUNT(*) FROM pedido_historico h
            WHERE h.pedido_id=p.id AND h.tipo='REPROCESSAMENTO_AUTOMATICO_GM') tentativas
         FROM pedidos_senha p WHERE p.id=?`,
        [contexto.pedidoId]
      );
      assert.strictEqual(estado.status, 'CONCLUIDO');
      assert.strictEqual(Number(estado.custo), 0);
      assert.strictEqual(estado.fornecedor_id, null);
      assert.strictEqual(Number(estado.tentativas), 1);
    });
  } finally {
    global.fetch = fetchOriginal;
  }
  console.log('OK: retentativa automática conclui pedido encontrado (rollback confirmado)');
}

async function testarIndisponivelNovamente() {
  const fetchOriginal = global.fetch;
  try {
    await emTransacao('API_JOELPIRES_INDISPONIVEL', async (connection, contexto) => {
      global.fetch = async () => respostaHttp(503, {
        error: { name: 'ServiceUnavailable', message: 'Falha simulada' }
      });
      const tentativa = await processarCandidato(connection, contexto.pedidoId);
      assert.strictEqual(tentativa.resultado.status, 'ABERTO');
      assert.strictEqual(tentativa.resultado.aguardando_reprocessamento, true);

      const candidatos = await listarCandidatos(connection, {
        esperaSegundos: 0,
        limite: 10
      });
      assert.ok(candidatos.includes(Number(contexto.pedidoId)));
    });
  } finally {
    global.fetch = fetchOriginal;
  }
  console.log('OK: nova indisponibilidade permanece elegível (rollback confirmado)');
}

async function testarNaoElegivel() {
  let fetchChamado = false;
  const fetchOriginal = global.fetch;
  global.fetch = async () => {
    fetchChamado = true;
    throw new Error('Fetch não deveria ser chamado');
  };
  try {
    await emTransacao('DADOS_INVALIDOS_API_JOELPIRES', async (connection, contexto) => {
      const tentativa = await processarCandidato(connection, contexto.pedidoId);
      assert.deepStrictEqual(tentativa, {
        processado: false,
        motivo: 'PEDIDO_NAO_ELEGIVEL'
      });
      assert.strictEqual(fetchChamado, false);
    });
  } finally {
    global.fetch = fetchOriginal;
  }
  console.log('OK: pedido sem indisponibilidade como último evento é ignorado');
}

async function executar() {
  const configuracao = obterConfiguracao({ habilitado: true, limite: 3, esperaSegundos: 20 });
  assert.deepStrictEqual(configuracao, {
    habilitado: true,
    limite: 3,
    esperaSegundos: 20
  });
  const desabilitado = await reprocessarPedidosGm(
    { getConnection: () => { throw new Error('Não deve conectar'); } },
    { habilitado: false }
  );
  assert.deepStrictEqual(desabilitado, { executado: false, motivo: 'DESABILITADO' });

  await testarEncontrado();
  await testarIndisponivelNovamente();
  await testarNaoElegivel();
}

executar().catch(erro => {
  console.error(`FALHA: reprocessamento automático GM: ${erro.message}`);
  process.exitCode = 1;
});
