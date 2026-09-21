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
  criarTabelaEstornosTemporaria
} = require('./teste-suporte-estornos');
const {
  prepararPartes,
  registrarPartesPedido
} = require('./identidades-pedido');
const {
  agendarConsultaFornecedor
} = require('./agendar-consulta-fornecedor');

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
  await criarTabelaEstornosTemporaria(connection);
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
  const protocoloNaoEncontrado = `NF${process.pid}${String(Date.now()).slice(-7)}`;
  const chassiNaoEncontrado = `9BGE2E2A0${String(Date.now() + 1).slice(-8)}`;
  const protocoloDadosInvalidos = `DI${process.pid}${String(Date.now()).slice(-7)}`;
  const chassiDadosInvalidos = `9BGE2E3A0${String(Date.now() + 2).slice(-8)}`;
  const chassiCorrigido = `9BGE2E4A0${String(Date.now() + 3).slice(-8)}`;
  const protocoloIndisponivel = `IN${process.pid}${String(Date.now()).slice(-7)}`;
  const chassiIndisponivel = `9BGE2E5A0${String(Date.now() + 4).slice(-8)}`;
  const protocoloResultado = `RF${process.pid}${String(Date.now()).slice(-7)}`;
  const chassiResultado = `9BGE2E6A0${String(Date.now() + 5).slice(-8)}`;
  const protocoloEstorno = `ES${process.pid}${String(Date.now()).slice(-7)}`;
  const chassiEstorno = `9BGE2E7A0${String(Date.now() + 6).slice(-8)}`;
  const telefone = `5594${String(Date.now()).slice(-8)}`;
  const nomeCliente = `CLIENTE E2E INTEGRADO ${marcador}`;
  const nomeFornecedor = `FORNECEDOR E2E INTEGRADO ${marcador}`;
  const apiSenhaId = 970000000 + (process.pid % 100000);
  const apiSenhaIdCorrigida = 971000000 + (process.pid % 100000);
  const apiSenhaIdReprocessada = 972000000 + (process.pid % 100000);
  let chamadasIndisponivel = 0;

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
  const [pedidoNaoEncontrado] = await connection.query(
    `INSERT INTO pedidos_senha
       (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
        status, valor_venda, custo, moeda)
     VALUES (?, ?, ?, ?, 'GM', 'E2E 404', 2026,
             'AGUARDANDO_PAGAMENTO', ?, 0, 'BRL')`,
    [
      protocoloNaoEncontrado,
      cliente.insertId,
      servico.id,
      chassiNaoEncontrado,
      Number(servico.preco_base)
    ]
  );
  const [pedidoDadosInvalidos] = await connection.query(
    `INSERT INTO pedidos_senha
       (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
        status, valor_venda, custo, moeda)
     VALUES (?, ?, ?, ?, 'GM', 'DADO INVÁLIDO E2E', 2025,
             'AGUARDANDO_PAGAMENTO', ?, 0, 'BRL')`,
    [
      protocoloDadosInvalidos,
      cliente.insertId,
      servico.id,
      chassiDadosInvalidos,
      Number(servico.preco_base)
    ]
  );
  const [pedidoIndisponivel] = await connection.query(
    `INSERT INTO pedidos_senha
       (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
        status, valor_venda, custo, moeda)
     VALUES (?, ?, ?, ?, 'GM', 'INDISPONÍVEL E2E', 2026,
             'AGUARDANDO_PAGAMENTO', ?, 0, 'BRL')`,
    [
      protocoloIndisponivel,
      cliente.insertId,
      servico.id,
      chassiIndisponivel,
      Number(servico.preco_base)
    ]
  );
  const [fornecedor] = await connection.query(
    `INSERT INTO fornecedores
       (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
     VALUES (?, '5511444444404', 'PESSOA', '00:00:00', '23:59:59', 1)`,
    [nomeFornecedor]
  );
  await connection.query(
    `INSERT INTO fornecedor_servicos
       (fornecedor_id, codigo_servico, custo, ativo)
     VALUES (?, 'GM_SENHA', 0.01, 1)`,
    [fornecedor.insertId]
  );
  const [pedidoResultado] = await connection.query(
    `INSERT INTO pedidos_senha
       (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
        status, valor_venda, custo, moeda, fornecedor_id, origem_id)
     VALUES (?, ?, ?, ?, 'GM', 'RESULTADO E2E', 2026,
             'EM_CONSULTA', ?, 0.01, 'BRL', ?, 2)`,
    [
      protocoloResultado,
      cliente.insertId,
      servico.id,
      chassiResultado,
      Number(servico.preco_base),
      fornecedor.insertId
    ]
  );
  const [pedidoEstorno] = await connection.query(
    `INSERT INTO pedidos_senha
       (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
        status, valor_venda, custo, moeda)
     VALUES (?, ?, ?, ?, 'GM', 'ESTORNO E2E', 2026,
             'ABERTO', ?, 0, 'BRL')`,
    [
      protocoloEstorno,
      cliente.insertId,
      servico.id,
      chassiEstorno,
      Number(servico.preco_base)
    ]
  );
  const [lancamentoEstorno] = await connection.query(
    `INSERT INTO lancamentos_financeiros
       (tipo, cliente_id, pedido_senha_id, descricao, valor, moeda,
        data_competencia, status, origem, criado_por)
     VALUES ('RECEITA', ?, ?, 'PAGAMENTO E2E PARA ESTORNO', ?, 'BRL',
             CURDATE(), 'RECEBIDO', 'CONFIRMACAO_MANUAL', ?)`,
    [
      cliente.insertId,
      pedidoEstorno.insertId,
      Number(servico.preco_base),
      usuario.id
    ]
  );
  await connection.query(
    `INSERT INTO pagamentos
       (lancamento_id, valor, moeda, data_pagamento, meio_pagamento,
        referencia_externa, observacao, registrado_por)
     VALUES (?, ?, 'BRL', NOW(), 'PIX', ?, 'E2E', ?)`,
    [
      lancamentoEstorno.insertId,
      Number(servico.preco_base),
      `PIX-ORIGINAL-${protocoloEstorno}`,
      usuario.id
    ]
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
  await registrarPartesPedido(
    connection,
    pedidoNaoEncontrado.insertId,
    prepararPartes(clienteSnapshot)
  );
  await registrarPartesPedido(
    connection,
    pedidoDadosInvalidos.insertId,
    prepararPartes(clienteSnapshot)
  );
  await registrarPartesPedido(
    connection,
    pedidoIndisponivel.insertId,
    prepararPartes(clienteSnapshot)
  );
  await registrarPartesPedido(
    connection,
    pedidoResultado.insertId,
    prepararPartes(clienteSnapshot)
  );
  await registrarPartesPedido(
    connection,
    pedidoEstorno.insertId,
    prepararPartes(clienteSnapshot)
  );
  await agendarConsultaFornecedor(connection, {
    pedido: {
      id: pedidoResultado.insertId,
      protocolo: protocoloResultado,
      chassi: chassiResultado,
      marca: 'GM',
      modelo: 'RESULTADO E2E',
      ano: 2026
    },
    fornecedor: {
      fornecedor_id: fornecedor.insertId,
      whatsapp: '5511444444404'
    },
    usuarioId: usuario.id
  });

  contexto = {
    encontrado: {
      pedidoId: pedido.insertId,
      protocolo,
      chassi,
      apiSenhaId
    },
    naoEncontrado: {
      pedidoId: pedidoNaoEncontrado.insertId,
      protocolo: protocoloNaoEncontrado,
      chassi: chassiNaoEncontrado,
      fornecedorId: fornecedor.insertId,
      fornecedor: nomeFornecedor
    },
    dadosInvalidos: {
      pedidoId: pedidoDadosInvalidos.insertId,
      protocolo: protocoloDadosInvalidos,
      chassi: chassiCorrigido,
      chassiOriginal: chassiDadosInvalidos,
      apiSenhaId: apiSenhaIdCorrigida
    },
    indisponivel: {
      pedidoId: pedidoIndisponivel.insertId,
      protocolo: protocoloIndisponivel,
      chassi: chassiIndisponivel,
      apiSenhaId: apiSenhaIdReprocessada
    },
    resultadoFornecedor: {
      pedidoId: pedidoResultado.insertId,
      protocolo: protocoloResultado,
      chassi: chassiResultado,
      fornecedorId: fornecedor.insertId,
      fornecedor: nomeFornecedor
    },
    estorno: {
      pedidoId: pedidoEstorno.insertId,
      protocolo: protocoloEstorno,
      chassi: chassiEstorno
    },
    nomeCliente,
    nomeFornecedor,
    usuario
  };

  global.fetch = async (url, opcoes) => {
    if (!String(url).startsWith('https://mock-e2e.joelpires.invalid/')) {
      return fetchOriginal(url, opcoes);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    const chassiConsultado = new URL(String(url)).searchParams.get('chassi');
    if (chassiConsultado === chassiIndisponivel.slice(-8)) {
      chamadasIndisponivel += 1;
      if (chamadasIndisponivel === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ error: 'Indisponível' })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{
          id: apiSenhaIdReprocessada,
          id_montadora: 1,
          chassis: chassiIndisponivel,
          cod_mecanico: 'MEC-E2E-REPROCESSADO',
          cod_immo: 'IMMO-E2E-REPROCESSADO'
        }])
      };
    }
    if (chassiConsultado === chassiDadosInvalidos.slice(-8)) {
      return {
        ok: false,
        status: 422,
        text: async () => JSON.stringify({
          error: { name: 'ValidationError', message: 'Dados inválidos' }
        })
      };
    }
    if (chassiConsultado === chassiNaoEncontrado.slice(-8)) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({
          error: { name: 'SenhaNotFoundError', message: 'Não encontrada' }
        })
      };
    }
    if (chassiConsultado === chassiCorrigido.slice(-8)) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{
          id: apiSenhaIdCorrigida,
          id_montadora: 1,
          chassis: chassiCorrigido,
          cod_mecanico: 'MEC-E2E-CORRIGIDO',
          cod_immo: 'IMMO-E2E-CORRIGIDO'
        }])
      };
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
    encontrado: {
      pedido_id: contexto.encontrado.pedidoId,
      protocolo: contexto.encontrado.protocolo
    },
    nao_encontrado: {
      pedido_id: contexto.naoEncontrado.pedidoId,
      protocolo: contexto.naoEncontrado.protocolo,
      fornecedor_id: contexto.naoEncontrado.fornecedorId,
      fornecedor: contexto.naoEncontrado.fornecedor
    },
    dados_invalidos: {
      pedido_id: contexto.dadosInvalidos.pedidoId,
      protocolo: contexto.dadosInvalidos.protocolo,
      chassi_corrigido: contexto.dadosInvalidos.chassi
    },
    indisponivel: {
      pedido_id: contexto.indisponivel.pedidoId,
      protocolo: contexto.indisponivel.protocolo
    },
    resultado_fornecedor: {
      pedido_id: contexto.resultadoFornecedor.pedidoId,
      protocolo: contexto.resultadoFornecedor.protocolo,
      fornecedor_id: contexto.resultadoFornecedor.fornecedorId,
      fornecedor: contexto.resultadoFornecedor.fornecedor
    },
    estorno: {
      pedido_id: contexto.estorno.pedidoId,
      protocolo: contexto.estorno.protocolo
    },
    cliente: contexto.nomeCliente
  }));
  app.get('/api/e2e/verificacao', async (req, res) => {
    const naoEncontrado = req.query.cenario === 'nao_encontrado';
    const dadosInvalidos = req.query.cenario === 'dados_invalidos';
    const indisponivel = req.query.cenario === 'indisponivel';
    const resultadoFornecedor = req.query.cenario === 'resultado_fornecedor';
    const estorno = req.query.cenario === 'estorno';
    const cenario = estorno
      ? contexto.estorno
      : resultadoFornecedor
        ? contexto.resultadoFornecedor
        : indisponivel
          ? contexto.indisponivel
          : dadosInvalidos
            ? contexto.dadosInvalidos
            : naoEncontrado
              ? contexto.naoEncontrado
              : contexto.encontrado;
    const [[estado]] = await connection.query(
      `SELECT
         p.status,
         p.custo,
         p.fornecedor_id,
         f.nome AS fornecedor,
         (SELECT COUNT(*) FROM pagamentos pg
           INNER JOIN lancamentos_financeiros lf ON lf.id = pg.lancamento_id
          WHERE lf.pedido_senha_id = p.id) AS pagamentos,
         (SELECT COUNT(*) FROM pedido_resultados pr
          WHERE pr.pedido_id = p.id AND pr.status = 'CONFIRMADO') AS resultados,
         (SELECT COUNT(*) FROM pedido_historico ph
          WHERE ph.pedido_id = p.id
            AND ph.tipo = 'DADOS_INVALIDOS_API_JOELPIRES') AS dados_invalidos,
         (SELECT COUNT(*) FROM pedido_historico ph
          WHERE ph.pedido_id = p.id
            AND ph.tipo = 'API_JOELPIRES_INDISPONIVEL') AS indisponibilidades,
         (SELECT COUNT(*) FROM estornos_pagamentos ep
          WHERE ep.pedido_senha_id = p.id
            AND ep.status = 'CONFIRMADO') AS estornos,
         (SELECT COUNT(*) FROM lancamentos_financeiros lf
          WHERE lf.pedido_senha_id = p.id AND lf.tipo = 'DESPESA'
            AND lf.origem = 'ESTORNO_MANUAL' AND lf.status = 'PAGO') AS despesas_estorno,
         (SELECT COUNT(*) FROM banco_senhas bs
          WHERE bs.chassi = ?) AS cache
       FROM pedidos_senha p
       LEFT JOIN fornecedores f ON f.id = p.fornecedor_id
       WHERE p.id = ?`,
      [
        cenario.chassi,
        cenario.pedidoId
      ]
    );
    const [[comunicacoes]] = await connection.query(
      `SELECT
         SUM(finalidade = 'ENTREGA_CLIENTE' AND status = 'PENDENTE') AS entregas,
         SUM(finalidade = 'CONSULTA_FORNECEDOR') AS consultas_fornecedor,
         SUM(finalidade = 'CONSULTA_FORNECEDOR' AND status = 'CANCELADA') AS consultas_canceladas
       FROM comunicacoes_outbox
       WHERE pedido_id = ?`,
      [cenario.pedidoId]
    );
    res.json({ ok: true, estado: { ...estado, ...comunicacoes } });
  });

  const pool = poolTransacional(connection);
  require('./rotas-pedidos')(app, pool);
  require('./rotas-financeiro')(app, pool);
  require('./rotas-estornos')(app, pool);

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
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo IN (?, ?, ?, ?, ?, ?)) AS pedidos,
           (SELECT COUNT(*) FROM clientes WHERE nome = ?) AS clientes,
           (SELECT COUNT(*) FROM fornecedores WHERE nome = ?) AS fornecedores,
           (SELECT COUNT(*) FROM banco_senhas
             WHERE JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.api_senha_id'))
               IN (?, ?, ?) OR chassi = ?) AS cache`,
        [
          contexto?.encontrado?.protocolo,
          contexto?.naoEncontrado?.protocolo,
          contexto?.dadosInvalidos?.protocolo,
          contexto?.indisponivel?.protocolo,
          contexto?.resultadoFornecedor?.protocolo,
          contexto?.estorno?.protocolo,
          contexto?.nomeCliente,
          contexto?.nomeFornecedor,
          String(contexto?.encontrado?.apiSenhaId),
          String(contexto?.dadosInvalidos?.apiSenhaId),
          String(contexto?.indisponivel?.apiSenhaId),
          contexto?.resultadoFornecedor?.chassi
        ]
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
