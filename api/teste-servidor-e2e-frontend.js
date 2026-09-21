'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  criarTabelaOutboxTemporaria
} = require('./teste-suporte-outbox');
const {
  criarTabelaPartesPedidoTemporaria
} = require('./teste-suporte-partes-pedido');
const {
  prepararPartes,
  registrarPartesPedido
} = require('./identidades-pedido');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

process.env.AMBIENTE_API_JOELPIRES = 'teste';
process.env.URL_API_JOELPIRES_TESTE = 'https://mock-e2e.joelpires.invalid';
process.env.CHAVE_API_JOELPIRES = 'credencial-ficticia-e2e';
process.env.ID_USUARIO_API_JOELPIRES = '-1';
process.env.APIJOELPIRES_ID_DISPOSITIVO = 'centralmykey';
process.env.APIJOELPIRES_TIMEOUT_MS = '1000';

const PORTA = Number(process.env.CENTRALMYKEY_E2E_API_PORT || 4175);
const fetchOriginal = global.fetch;
let connection;
let servidor;
let contexto;
let encerrando = false;

function poolTransacional(conexao) {
  return {
    getConnection: async () => ({
      query: (...args) => conexao.query(...args),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {}
    }),
    query: (...args) => conexao.query(...args)
  };
}

async function prepararFixture() {
  connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
  await connection.beginTransaction();
  await criarTabelaOutboxTemporaria(connection);
  await criarTabelaPartesPedidoTemporaria(connection);

  const [[servico]] = await connection.query(
    "SELECT id, preco_base FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
  );
  const [[usuario]] = await connection.query(
    "SELECT id, nome FROM usuarios WHERE status='ATIVO' ORDER BY id LIMIT 1"
  );
  if (!servico || !usuario) {
    throw new Error('Serviço GM e usuário ativo são obrigatórios para o E2E');
  }

  const marcador = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const protocolo = `E2E${process.pid}${String(Date.now()).slice(-7)}`;
  const chassi = `9BGE2E1A0${String(Date.now()).slice(-8)}`;
  const telefone = `5594${String(Date.now()).slice(-8)}`;
  const nomeCliente = `CLIENTE E2E INTEGRADO ${marcador}`;
  const apiSenhaId = 970000000 + (process.pid % 100000);

  const [cliente] = await connection.query(
    `INSERT INTO clientes
       (nome, telefone, telefone_normalizado, cadastro_status, ativo,
        tipo_cobranca, credito_status)
     VALUES (?, ?, ?, 'COMPLETO', 1, 'ANTECIPADO', 'LIBERADO')`,
    [nomeCliente, telefone, telefone]
  );
  const [pedido] = await connection.query(
    `INSERT INTO pedidos_senha
       (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
        status, valor_venda, custo, moeda)
     VALUES (?, ?, ?, ?, 'GM', 'E2E INTEGRADO', 2026,
             'AGUARDANDO_PAGAMENTO', ?, 0, 'BRL')`,
    [protocolo, cliente.insertId, servico.id, chassi, Number(servico.preco_base)]
  );
  const clienteSnapshot = {
    id: cliente.insertId,
    nome: nomeCliente,
    telefone,
    telefone_normalizado: telefone
  };
  await registrarPartesPedido(
    connection,
    pedido.insertId,
    prepararPartes(clienteSnapshot)
  );

  contexto = {
    pedidoId: pedido.insertId,
    protocolo,
    chassi,
    nomeCliente,
    apiSenhaId,
    usuario
  };

  global.fetch = async (url, opcoes) => {
    if (!String(url).startsWith('https://mock-e2e.joelpires.invalid/')) {
      return fetchOriginal(url, opcoes);
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{
        id: apiSenhaId,
        id_montadora: 1,
        chassis: chassi,
        cod_mecanico: 'MEC-E2E-INTEGRADO',
        cod_immo: 'IMMO-E2E-INTEGRADO'
      }])
    };
  };
}

async function iniciar() {
  await prepararFixture();
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = contexto.usuario;
    next();
  };
  app.locals.exigirPermissao = () => (req, res, next) => next();

  app.get('/api/auth/me', (req, res) => res.json({
    ok: true,
    usuario: {
      id: contexto.usuario.id,
      nome: contexto.usuario.nome,
      login: 'e2e_integrado',
      perfil_id: 1,
      perfil: 'Administrador',
      status: 'ATIVO',
      senha_provisoria: 0
    },
    permissoes: [
      { codigo: 'DASHBOARD', modulo: 'Dashboard', visualizar: 1 },
      { codigo: 'PEDIDOS_SENHAS', modulo: 'Pedidos e senhas', visualizar: 1 },
      { codigo: 'FINANCEIRO', modulo: 'Financeiro', visualizar: 1, aprovar: 1 }
    ]
  }));
  app.get('/api/notificacoes/resumo', (req, res) => res.json({
    ok: true,
    nao_lidas: 0,
    criticas: 0
  }));
  app.get('/api/e2e/health', (req, res) => res.json({ ok: true }));
  app.get('/api/e2e/contexto', (req, res) => res.json({
    ok: true,
    pedido_id: contexto.pedidoId,
    protocolo: contexto.protocolo,
    cliente: contexto.nomeCliente
  }));
  app.get('/api/e2e/verificacao', async (req, res) => {
    const [[estado]] = await connection.query(
      `SELECT
         p.status,
         p.custo,
         p.fornecedor_id,
         (SELECT COUNT(*) FROM pagamentos pg
           INNER JOIN lancamentos_financeiros lf ON lf.id = pg.lancamento_id
          WHERE lf.pedido_senha_id = p.id) AS pagamentos,
         (SELECT COUNT(*) FROM pedido_resultados pr
          WHERE pr.pedido_id = p.id AND pr.status = 'CONFIRMADO'
            AND pr.fornecedor_id IS NULL AND pr.custo = 0) AS resultados,
         (SELECT COUNT(*) FROM banco_senhas bs
          WHERE JSON_UNQUOTE(JSON_EXTRACT(bs.dados_extras, '$.api_senha_id')) = ?) AS cache
       FROM pedidos_senha p
       WHERE p.id = ?`,
      [String(contexto.apiSenhaId), contexto.pedidoId]
    );
    const [[comunicacoes]] = await connection.query(
      `SELECT
         SUM(finalidade = 'ENTREGA_CLIENTE' AND status = 'PENDENTE') AS entregas,
         SUM(finalidade = 'CONSULTA_FORNECEDOR') AS consultas_fornecedor
       FROM comunicacoes_outbox
       WHERE pedido_id = ?`,
      [contexto.pedidoId]
    );
    res.json({ ok: true, estado: { ...estado, ...comunicacoes } });
  });

  const pool = poolTransacional(connection);
  require('./rotas-pedidos')(app, pool);
  require('./rotas-financeiro')(app, pool);

  servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(PORTA, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  console.log(`API E2E transacional pronta na porta ${PORTA}`);
}

async function encerrar(codigo = 0) {
  if (encerrando) return;
  encerrando = true;
  let codigoFinal = codigo;
  try {
    if (servidor) {
      await new Promise(resolve => servidor.close(resolve));
    }
    if (connection) {
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo = ?) AS pedidos,
           (SELECT COUNT(*) FROM clientes WHERE nome = ?) AS clientes,
           (SELECT COUNT(*) FROM banco_senhas
             WHERE JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.api_senha_id')) = ?) AS cache`,
        [contexto?.protocolo, contexto?.nomeCliente, String(contexto?.apiSenhaId)]
      );
      if (Object.values(residuos).some(Number)) {
        codigoFinal = 1;
        console.error('FALHA: o E2E integrado deixou resíduos');
      } else {
        console.log('API E2E encerrada com rollback confirmado');
      }
      await connection.end();
    }
  } catch (erro) {
    codigoFinal = 1;
    console.error(`FALHA ao encerrar API E2E: ${erro.message}`);
  } finally {
    global.fetch = fetchOriginal;
    process.exit(codigoFinal);
  }
}

process.once('SIGTERM', () => encerrar());
process.once('SIGINT', () => encerrar());

iniciar().catch(async erro => {
  console.error(`FALHA ao iniciar API E2E: ${erro.message}`);
  await encerrar(1);
});
