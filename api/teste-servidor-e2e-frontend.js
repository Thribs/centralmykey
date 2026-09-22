'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
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
  criarTabelasNotificacoesTemporarias
} = require('./teste-suporte-notificacoes');
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

function ultimaSemanaConcluida() {
  const hoje = new Date();
  hoje.setHours(12, 0, 0, 0);
  const deslocamento = hoje.getDay() === 0 ? -6 : 1 - hoje.getDay();
  const inicio = new Date(hoje);
  inicio.setDate(hoje.getDate() + deslocamento - 7);
  const fim = new Date(inicio);
  fim.setDate(inicio.getDate() + 6);
  const iso = valor => [
    valor.getFullYear(),
    String(valor.getMonth() + 1).padStart(2, '0'),
    String(valor.getDate()).padStart(2, '0')
  ].join('-');
  return { inicio: iso(inicio), fim: iso(fim) };
}

async function criarTabelasFechamentoTemporarias(conexao) {
  await conexao.query(
    `CREATE TEMPORARY TABLE fechamentos_fornecedores (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       fornecedor_id BIGINT NOT NULL,
       periodo_inicio DATE NOT NULL,
       periodo_fim DATE NOT NULL,
       moeda VARCHAR(3) NOT NULL DEFAULT 'BRL',
       quantidade_itens INT NOT NULL DEFAULT 0,
       valor_total DECIMAL(12,2) NOT NULL DEFAULT 0,
       status ENUM('RASCUNHO','FECHADO','PAGO','CANCELADO')
         NOT NULL DEFAULT 'RASCUNHO',
       lancamento_financeiro_id BIGINT NULL,
       gerado_por BIGINT NULL,
       fechado_por BIGINT NULL,
       pago_por BIGINT NULL,
       fechado_em DATETIME NULL,
       pago_em DATETIME NULL,
       criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uk_periodo
         (fornecedor_id, periodo_inicio, periodo_fim, moeda)
     ) ENGINE=InnoDB`
  );
  await conexao.query(
    `CREATE TEMPORARY TABLE fechamento_fornecedor_itens (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       fechamento_id BIGINT NOT NULL,
       pedido_senha_id BIGINT NOT NULL,
       resultado_id BIGINT NOT NULL UNIQUE,
       custo DECIMAL(12,2) NOT NULL,
       criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`
  );
}

async function criarTabelaEventosIntegracaoTemporaria(conexao) {
  await conexao.query(
    `CREATE TEMPORARY TABLE integracao_eventos (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       provedor VARCHAR(40) NOT NULL,
       evento_externo_id VARCHAR(160) NOT NULL,
       tipo VARCHAR(80) NOT NULL,
       referencia_externa VARCHAR(120) NULL,
       entidade VARCHAR(40) NULL,
       entidade_id BIGINT NULL,
       lancamento_id BIGINT NULL,
       pagamento_id BIGINT NULL,
       payload_hash CHAR(64) NOT NULL,
       payload JSON NOT NULL,
       status ENUM('RECEBIDO','PROCESSADO','IGNORADO','FALHOU')
         NOT NULL DEFAULT 'RECEBIDO',
       tentativas SMALLINT UNSIGNED NOT NULL DEFAULT 1,
       erro_codigo VARCHAR(80) NULL,
       erro_detalhe VARCHAR(500) NULL,
       recebido_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       processado_em DATETIME NULL,
       atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uk_evento (provedor, evento_externo_id)
     ) ENGINE=InnoDB`
  );
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
  await criarTabelasNotificacoesTemporarias(connection);
  await criarTabelaEventosIntegracaoTemporaria(connection);
  await criarTabelasFechamentoTemporarias(connection);
  await connection.query(
    `CREATE TEMPORARY TABLE integracao_produto_mapeamentos (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       provedor ENUM('WBUY','BLING') NOT NULL,
       produto_externo_id VARCHAR(160) NULL,
       sku VARCHAR(120) NULL,
       nome_externo VARCHAR(255) NULL,
       servico_id BIGINT NOT NULL,
       ativo TINYINT(1) NOT NULL DEFAULT 1,
       criado_por BIGINT NULL,
       atualizado_por BIGINT NULL,
       criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uk_integracao_produto (provedor, produto_externo_id),
       UNIQUE KEY uk_integracao_sku (provedor, sku)
     ) ENGINE=InnoDB`
  );
  await connection.query(
    `CREATE TEMPORARY TABLE fornecedor_servicos (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       fornecedor_id BIGINT NOT NULL,
       codigo_servico VARCHAR(60) NOT NULL,
       descricao VARCHAR(180) NULL,
       marca VARCHAR(80) NULL,
       modelo VARCHAR(120) NULL,
       ano_inicio SMALLINT NULL,
       ano_fim SMALLINT NULL,
       custo DECIMAL(12,2) NOT NULL,
       moeda VARCHAR(3) NOT NULL DEFAULT 'BRL',
       prazo_estimado_minutos INT NULL,
       ativo TINYINT(1) NOT NULL DEFAULT 1,
       criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ON UPDATE CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`
  );

  const [[servico]] = await connection.query(
    `SELECT id, codigo, nome, marca, preco_base
       FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1`
  );
  const [perfis] = await connection.query(
    'SELECT id, nome FROM perfis WHERE ativo=1 ORDER BY id'
  );
  const perfil = perfis.find(item => Number(item.id) === 1) || perfis[0];
  const perfilAtendente = perfis.find(item => item.nome !== 'Administrador') || perfil;
  const [modulos] = await connection.query(
    'SELECT id, codigo FROM modulos WHERE ativo=1 ORDER BY id'
  );
  if (!servico || !perfil || !modulos.length) {
    throw new Error('Serviço GM, perfil e módulos ativos são obrigatórios para o E2E');
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
  const protocoloFechamento = `FF${process.pid}${String(Date.now()).slice(-7)}`;
  const chassiFechamento = `9BGE2E8A0${String(Date.now() + 7).slice(-8)}`;
  const chassiBancoSenhas = `9BGE2E9A0${String(Date.now() + 8).slice(-8)}`;
  const chassiBancoSenhasNovo = `9BGE2E0A0${String(Date.now() + 9).slice(-8)}`;
  const codigoBancoSenhasNovo = `MEC-BANCO-NOVO-${marcador}`;
  const telefone = `5594${String(Date.now()).slice(-8)}`;
  const nomeCliente = `CLIENTE E2E INTEGRADO ${marcador}`;
  const nomeFornecedor = `FORNECEDOR E2E INTEGRADO ${marcador}`;
  const nomeClienteCadastro = `CLIENTE VIP E2E ${marcador}`;
  const telefoneClienteCadastro = `55119${String(Date.now()).slice(-8)}`;
  const nomeFornecedorCadastro = `FORNECEDOR CADASTRO E2E ${marcador}`;
  const loginOperador = `e2e-admin-${marcador}`;
  const senhaOperador = `Admin-${marcador}-9`;
  const loginVisualizador = `e2e-view-${marcador}`;
  const senhaVisualizador = `View-${marcador}-9`;
  const loginNovoUsuario = `e2e-novo-${marcador}`;
  const loginAtendente = `e2e-atendimento-${marcador}`;
  const senhaAtendente = `Atendimento-${marcador}-9`;
  const nomeAtendente = `ATENDENTE E2E ${marcador}`;
  const protocoloAtendimento = `ATE2E${process.pid}${String(Date.now()).slice(-7)}`;
  const notaAtendimento = `Nota interna E2E ${marcador}`;
  const respostaAtendimento = `Resposta WhatsApp E2E ${marcador}`;
  const mensagemExternaAtendimento = `wamid.e2e.${marcador}`;
  const chaveConfiguracao = `E2E_CONFIG_${process.pid}_${String(Date.now()).slice(-6)}`;
  const valorConfiguracaoInicial = `INICIAL-${marcador}`;
  const valorConfiguracaoFinal = `ATUALIZADO-${marcador}`;
  const nomeModeloWhatsapp = `modelo_e2e_${process.pid}_${String(Date.now()).slice(-6)}`;
  const produtoExternoIntegracao = `produto-e2e-${marcador}`;
  const skuIntegracao = `SKU-E2E-${marcador}`.toUpperCase();
  const apiSenhaId = 970000000 + (process.pid % 100000);
  const apiSenhaIdCorrigida = 971000000 + (process.pid % 100000);
  const apiSenhaIdReprocessada = 972000000 + (process.pid % 100000);
  let chamadasIndisponivel = 0;

  const [operador] = await connection.query(
    `INSERT INTO usuarios
       (nome, login, senha_hash, senha_provisoria, perfil_id, status)
     VALUES (?, ?, ?, 0, ?, 'ATIVO')`,
    [
      `ADMINISTRADOR E2E ${marcador}`,
      loginOperador,
      await bcrypt.hash(senhaOperador, 4),
      perfil.id
    ]
  );
  for (const modulo of modulos) {
    await connection.query(
      `INSERT INTO usuario_permissoes
         (usuario_id, modulo_id, visualizar, criar, editar, excluir, aprovar)
       VALUES (?, ?, 1, 1, 1, 1, 1)`,
      [operador.insertId, modulo.id]
    );
  }
  const moduloUsuarios = modulos.find(item => item.codigo === 'USUARIOS');
  if (!moduloUsuarios) {
    throw new Error('Módulo USUARIOS ativo é obrigatório para o E2E');
  }
  const [visualizador] = await connection.query(
    `INSERT INTO usuarios
       (nome, login, senha_hash, senha_provisoria, perfil_id, status)
     VALUES (?, ?, ?, 0, ?, 'ATIVO')`,
    [
      `VISUALIZADOR E2E ${marcador}`,
      loginVisualizador,
      await bcrypt.hash(senhaVisualizador, 4),
      perfilAtendente.id
    ]
  );
  await connection.query(
    `INSERT INTO usuario_permissoes
       (usuario_id, modulo_id, visualizar, criar, editar, excluir, aprovar)
     VALUES (?, ?, 1, 0, 0, 0, 0)`,
    [visualizador.insertId, moduloUsuarios.id]
  );
  const moduloConfiguracoes = modulos.find(
    item => item.codigo === 'CONFIGURACOES'
  );
  if (!moduloConfiguracoes) {
    throw new Error('Módulo CONFIGURACOES ativo é obrigatório para o E2E');
  }
  await connection.query(
    `INSERT INTO usuario_permissoes
       (usuario_id, modulo_id, visualizar, criar, editar, excluir, aprovar)
     VALUES (?, ?, 1, 0, 0, 0, 0)`,
    [visualizador.insertId, moduloConfiguracoes.id]
  );
  const moduloIntegracoes = modulos.find(item => item.codigo === 'INTEGRACOES');
  if (!moduloIntegracoes) {
    throw new Error('Módulo INTEGRACOES ativo é obrigatório para o E2E');
  }
  await connection.query(
    `INSERT INTO usuario_permissoes
       (usuario_id, modulo_id, visualizar, criar, editar, excluir, aprovar)
     VALUES (?, ?, 1, 0, 0, 0, 0)`,
    [visualizador.insertId, moduloIntegracoes.id]
  );
  for (const codigo of [
    'CLIENTES', 'FORNECEDORES', 'FINANCEIRO', 'PEDIDOS_SENHAS', 'BANCO_SENHAS'
  ]) {
    const modulo = modulos.find(item => item.codigo === codigo);
    if (!modulo) throw new Error(`Módulo ${codigo} ativo é obrigatório para o E2E`);
    await connection.query(
      `INSERT INTO usuario_permissoes
         (usuario_id, modulo_id, visualizar, criar, editar, excluir, aprovar)
       VALUES (?, ?, 1, 0, 0, 0, 0)`,
      [visualizador.insertId, modulo.id]
    );
  }
  const moduloAtendimento = modulos.find(item => item.codigo === 'ATENDIMENTO');
  if (!moduloAtendimento) {
    throw new Error('Módulo ATENDIMENTO ativo é obrigatório para o E2E');
  }
  const [atendente] = await connection.query(
    `INSERT INTO usuarios
       (nome, login, senha_hash, senha_provisoria, perfil_id, status)
     VALUES (?, ?, ?, 0, ?, 'ATIVO')`,
    [
      nomeAtendente,
      loginAtendente,
      await bcrypt.hash(senhaAtendente, 4),
      perfilAtendente.id
    ]
  );
  await connection.query(
    `INSERT INTO usuario_permissoes
       (usuario_id, modulo_id, visualizar, criar, editar, excluir, aprovar)
     VALUES (?, ?, 1, 0, 1, 0, 0)`,
    [atendente.insertId, moduloAtendimento.id]
  );
  const usuario = {
    id: operador.insertId,
    nome: `ADMINISTRADOR E2E ${marcador}`,
    login: loginOperador,
    perfil_id: perfil.id,
    perfil: perfil.nome,
    status: 'ATIVO',
    senha_provisoria: 0
  };
  await connection.query(
    `INSERT INTO configuracoes (chave, valor, descricao)
     VALUES (?, ?, 'Configuração fictícia para E2E integrado')`,
    [chaveConfiguracao, valorConfiguracaoInicial]
  );
  const referenciaEventoBling = `BLING-E2E-${marcador}`;
  const referenciaEventoSicoob = `SICOOB-E2E-${marcador}`;
  await connection.query(
    `INSERT INTO integracao_eventos
       (provedor, evento_externo_id, tipo, referencia_externa, entidade,
        payload_hash, payload, status, tentativas, erro_codigo, erro_detalhe)
     VALUES
       ('BLING', ?, 'order.updated', ?, 'PEDIDO_EXTERNO',
        ?, JSON_OBJECT('fixture', TRUE), 'RECEBIDO', 2, NULL, NULL),
       ('SICOOB', ?, 'PIX_RECEBIDO', ?, 'PAGAMENTO',
        ?, JSON_OBJECT('fixture', TRUE), 'FALHOU', 3,
        'REFERENCIA_NAO_ENCONTRADA', 'Falha fictícia para teste')`,
    [
      `bling-event-${marcador}`, referenciaEventoBling, 'b'.repeat(64),
      `sicoob-event-${marcador}`, referenciaEventoSicoob, 'c'.repeat(64)
    ]
  );

  const [cliente] = await connection.query(
    `INSERT INTO clientes
       (nome, telefone, telefone_normalizado, cadastro_status, ativo,
        tipo_cobranca, credito_status)
     VALUES (?, ?, ?, 'COMPLETO', 1, 'ANTECIPADO', 'LIBERADO')`,
    [nomeCliente, telefone, telefone]
  );
  const [[origemSenha]] = await connection.query(
    'SELECT id FROM origens_senha WHERE ativo = 1 ORDER BY id LIMIT 1'
  );
  const [senhaAdministrativa] = await connection.query(
    `INSERT INTO banco_senhas
       (tipo, marca, modelo, ano_inicio, chassi, codigo_mecanico,
        origem_id, confiabilidade, ativo)
     VALUES ('GM_SENHA', 'GM', 'BANCO E2E', 2026, ?, 'MEC-BANCO-E2E',
             ?, 'CONFIRMADA', 1)`,
    [chassiBancoSenhas, origemSenha?.id || null]
  );
  const [atendimento] = await connection.query(
    `INSERT INTO atendimentos
       (protocolo, cliente_id, telefone, telefone_normalizado, canal,
        modo, status, prioridade, assunto, ultima_mensagem_em)
     VALUES (?, ?, ?, ?, 'WHATSAPP', 'ELETRONICO', 'FILA', 'ALTA',
             'Atendimento integrado E2E', NOW())`,
    [protocoloAtendimento, cliente.insertId, telefone, telefone]
  );
  await connection.query(
    `INSERT INTO atendimento_mensagens
       (atendimento_id, direcao, autor_tipo, tipo_conteudo, texto, criado_em)
     VALUES (?, 'ENTRADA', 'CLIENTE', 'TEXTO',
             'Mensagem inicial fictícia E2E', NOW())`,
    [atendimento.insertId]
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
  const periodoFechamento = ultimaSemanaConcluida();
  const [pedidoFechamento] = await connection.query(
    `INSERT INTO pedidos_senha
       (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
        status, valor_venda, custo, moeda, fornecedor_id, origem_id)
     VALUES (?, ?, ?, ?, 'GM', 'FECHAMENTO E2E', 2026,
             'CONCLUIDO', ?, 0.01, 'BRL', ?, 2)`,
    [
      protocoloFechamento,
      cliente.insertId,
      servico.id,
      chassiFechamento,
      Number(servico.preco_base),
      fornecedor.insertId
    ]
  );
  await connection.query(
    `INSERT INTO pedido_resultados
       (pedido_id, origem_id, fornecedor_id, codigo_mecanico,
        resultado, custo, status, criado_em)
     VALUES (?, 2, ?, 'MEC-FECHAMENTO-E2E', JSON_OBJECT(), 0.01,
             'CONFIRMADO', ?)`,
    [pedidoFechamento.insertId, fornecedor.insertId, `${periodoFechamento.inicio} 12:00:00`]
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
    fechamentoFornecedor: {
      pedidoId: pedidoFechamento.insertId,
      protocolo: protocoloFechamento,
      chassi: chassiFechamento,
      fornecedorId: fornecedor.insertId,
      fornecedor: nomeFornecedor,
      periodoInicio: periodoFechamento.inicio,
      periodoFim: periodoFechamento.fim,
      referencia: `PIX-FECHAMENTO-${protocoloFechamento}`
    },
    autenticacao: {
      administrador: { login: loginOperador, senha: senhaOperador },
      visualizador: { login: loginVisualizador, senha: senhaVisualizador },
      atendente: { login: loginAtendente, senha: senhaAtendente }
    },
    administracao: {
      visualizadorId: visualizador.insertId,
      nomeVisualizador: `VISUALIZADOR E2E ${marcador}`,
      loginNovoUsuario,
      nomeNovoUsuario: `NOVO USUÁRIO E2E ${marcador}`,
      perfilId: perfil.id,
      perfil: perfil.nome
    },
    atendimento: {
      id: atendimento.insertId,
      protocolo: protocoloAtendimento,
      cliente: nomeCliente,
      atendenteId: atendente.insertId,
      atendente: nomeAtendente,
      nota: notaAtendimento,
      resposta: respostaAtendimento,
      mensagemExternaId: mensagemExternaAtendimento,
      chamadasWhatsapp: 0
    },
    configuracao: {
      chave: chaveConfiguracao,
      valorInicial: valorConfiguracaoInicial,
      valorFinal: valorConfiguracaoFinal
    },
    bancoSenhas: {
      id: senhaAdministrativa.insertId,
      chassi: chassiBancoSenhas,
      novoChassi: chassiBancoSenhasNovo,
      novoCodigo: codigoBancoSenhasNovo
    },
    cadastros: {
      clienteNome: nomeClienteCadastro,
      clienteTelefone: telefoneClienteCadastro,
      clienteEmail: `cliente-${marcador}@teste.invalid`,
      fornecedorNome: nomeFornecedorCadastro,
      fornecedorEmail: `fornecedor-${marcador}@teste.invalid`,
      servicoCodigo: servico.codigo,
      servicoNome: servico.nome
    },
    integracoes: {
      nomeModeloWhatsapp,
      produtoExternoId: produtoExternoIntegracao,
      sku: skuIntegracao,
      nomeExterno: `Produto fictício E2E ${marcador}`,
      servicoId: servico.id,
      servicoCodigo: servico.codigo,
      referenciaEventoBling,
      referenciaEventoSicoob
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
  const pool = poolTransacional(connection);
  require('./rotas-auth')(app, pool);
  require('./rotas-administracao')(app, pool);
  app.locals.enviarMensagemWhatsapp = async () => {
    contexto.atendimento.chamadasWhatsapp += 1;
    return {
      mensagem_externa_id: contexto.atendimento.mensagemExternaId
    };
  };
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
    fechamento_fornecedor: {
      pedido_id: contexto.fechamentoFornecedor.pedidoId,
      protocolo: contexto.fechamentoFornecedor.protocolo,
      fornecedor_id: contexto.fechamentoFornecedor.fornecedorId,
      fornecedor: contexto.fechamentoFornecedor.fornecedor,
      periodo_inicio: contexto.fechamentoFornecedor.periodoInicio,
      periodo_fim: contexto.fechamentoFornecedor.periodoFim,
      referencia: contexto.fechamentoFornecedor.referencia
    },
    autenticacao: contexto.autenticacao,
    administracao: {
      visualizador_id: contexto.administracao.visualizadorId,
      nome_visualizador: contexto.administracao.nomeVisualizador,
      login_novo_usuario: contexto.administracao.loginNovoUsuario,
      nome_novo_usuario: contexto.administracao.nomeNovoUsuario,
      perfil_id: contexto.administracao.perfilId,
      perfil: contexto.administracao.perfil
    },
    atendimento: {
      id: contexto.atendimento.id,
      protocolo: contexto.atendimento.protocolo,
      cliente: contexto.atendimento.cliente,
      atendente_id: contexto.atendimento.atendenteId,
      atendente: contexto.atendimento.atendente,
      nota: contexto.atendimento.nota,
      resposta: contexto.atendimento.resposta
    },
    configuracao: {
      chave: contexto.configuracao.chave,
      valor_inicial: contexto.configuracao.valorInicial,
      valor_final: contexto.configuracao.valorFinal
    },
    banco_senhas: {
      id: contexto.bancoSenhas.id,
      chassi: contexto.bancoSenhas.chassi,
      novo_chassi: contexto.bancoSenhas.novoChassi,
      novo_codigo: contexto.bancoSenhas.novoCodigo
    },
    cadastros: {
      cliente_nome: contexto.cadastros.clienteNome,
      cliente_telefone: contexto.cadastros.clienteTelefone,
      cliente_email: contexto.cadastros.clienteEmail,
      fornecedor_nome: contexto.cadastros.fornecedorNome,
      fornecedor_email: contexto.cadastros.fornecedorEmail,
      servico_codigo: contexto.cadastros.servicoCodigo,
      servico_nome: contexto.cadastros.servicoNome
    },
    integracoes: {
      modelo_nome: contexto.integracoes.nomeModeloWhatsapp,
      produto_externo_id: contexto.integracoes.produtoExternoId,
      sku: contexto.integracoes.sku,
      nome_externo: contexto.integracoes.nomeExterno,
      servico_id: contexto.integracoes.servicoId,
      servico_codigo: contexto.integracoes.servicoCodigo,
      referencia_evento_bling: contexto.integracoes.referenciaEventoBling,
      referencia_evento_sicoob: contexto.integracoes.referenciaEventoSicoob
    },
    cliente: contexto.nomeCliente
  }));
  app.get('/api/e2e/verificacao', async (req, res) => {
    if (req.query.cenario === 'banco_senhas') {
      const [[estado]] = await connection.query(
        `SELECT bs.id, bs.ativo,
                (SELECT COUNT(*) FROM auditoria a
                  WHERE a.modulo = 'BANCO_SENHAS'
                    AND a.acao = 'ALTERAR_STATUS'
                    AND a.entidade_id = CAST(bs.id AS CHAR)) AS auditorias
           FROM banco_senhas bs WHERE bs.id = ? LIMIT 1`,
        [contexto.bancoSenhas.id]
      );
      const [[criada]] = await connection.query(
        `SELECT bs.id, bs.ativo,
                (SELECT COUNT(*) FROM auditoria a
                  WHERE a.modulo = 'BANCO_SENHAS'
                    AND a.entidade_id = CAST(bs.id AS CHAR)) AS auditorias,
                (SELECT COUNT(*) FROM auditoria a
                  WHERE a.modulo = 'BANCO_SENHAS'
                    AND a.entidade_id = CAST(bs.id AS CHAR)
                    AND (CAST(a.dados_antes AS CHAR) LIKE ?
                      OR CAST(a.dados_depois AS CHAR) LIKE ?)) AS codigos_na_auditoria
           FROM banco_senhas bs WHERE bs.chassi = ? LIMIT 1`,
        [
          `%${contexto.bancoSenhas.novoCodigo}%`,
          `%${contexto.bancoSenhas.novoCodigo}%`,
          contexto.bancoSenhas.novoChassi
        ]
      );
      return res.json({
        ok: true,
        estado: estado || null,
        criada: criada || null
      });
    }
    if (req.query.cenario === 'integracoes') {
      const [[mapeamento]] = await connection.query(
        `SELECT m.id, m.provedor, m.produto_externo_id, m.sku, m.servico_id,
                m.ativo,
                (SELECT COUNT(*) FROM auditoria a
                  WHERE a.entidade = 'integracao_produto_mapeamentos'
                    AND a.entidade_id = CAST(m.id AS CHAR)) AS auditorias
           FROM integracao_produto_mapeamentos m
          WHERE m.provedor = 'WBUY' AND m.produto_externo_id = ? LIMIT 1`,
        [contexto.integracoes.produtoExternoId]
      );
      const [[modelo]] = await connection.query(
        `SELECT w.id, w.nome, w.status, w.ativo,
                (SELECT COUNT(*) FROM auditoria a
                  WHERE a.entidade = 'whatsapp_modelos'
                    AND a.entidade_id = CAST(w.id AS CHAR)) AS auditorias
           FROM whatsapp_modelos w WHERE w.nome = ? LIMIT 1`,
        [contexto.integracoes.nomeModeloWhatsapp]
      );
      if (mapeamento?.id) contexto.integracoes.mapeamentoId = mapeamento.id;
      if (modelo?.id) contexto.integracoes.modeloId = modelo.id;
      return res.json({ ok: true, mapeamento: mapeamento || null, modelo: modelo || null });
    }
    if (req.query.cenario === 'cadastros') {
      const [[cliente]] = await connection.query(
        `SELECT
           c.id, c.ativo, c.tipo_cobranca, c.dia_fechamento,
           c.prazo_pagamento_dias, c.credito_status,
           v.status AS vip_status, v.valor_mensalidade,
           (SELECT COUNT(*) FROM auditoria a
             WHERE a.modulo = 'CLIENTES' AND a.entidade = 'clientes'
               AND a.entidade_id = CAST(c.id AS CHAR)) AS auditorias
         FROM clientes c
         LEFT JOIN cliente_vip v ON v.cliente_id = c.id
         WHERE c.nome = ? LIMIT 1`,
        [contexto.cadastros.clienteNome]
      );
      const [[fornecedor]] = await connection.query(
        `SELECT
           f.id, f.ativo, f.tipo, f.horario_inicio, f.horario_fim,
           (SELECT COUNT(*) FROM fornecedor_servicos fs
             WHERE fs.fornecedor_id = f.id
               AND fs.codigo_servico = ? AND fs.ativo = 1
               AND fs.custo = 17.50 AND fs.moeda = 'BRL') AS servicos,
           (SELECT COUNT(*) FROM auditoria a
             WHERE a.modulo = 'FORNECEDORES'
               AND a.entidade = 'fornecedores'
               AND a.entidade_id = CAST(f.id AS CHAR)) AS auditorias
         FROM fornecedores f WHERE f.nome = ? LIMIT 1`,
        [contexto.cadastros.servicoCodigo, contexto.cadastros.fornecedorNome]
      );
      let auditoriasServicos = 0;
      if (fornecedor?.id) {
        const [[auditoriaServico]] = await connection.query(
          `SELECT COUNT(*) AS total
             FROM auditoria a
             INNER JOIN fornecedor_servicos fs
               ON a.entidade = 'fornecedor_servicos'
              AND a.entidade_id = CAST(fs.id AS CHAR)
            WHERE fs.fornecedor_id = ?`,
          [fornecedor.id]
        );
        auditoriasServicos = Number(auditoriaServico.total || 0);
      }
      if (cliente?.id) contexto.cadastros.clienteId = cliente.id;
      if (fornecedor?.id) contexto.cadastros.fornecedorId = fornecedor.id;
      return res.json({
        ok: true,
        cliente: cliente || null,
        fornecedor: fornecedor
          ? { ...fornecedor, auditorias_servicos: auditoriasServicos }
          : null
      });
    }
    if (req.query.cenario === 'configuracao') {
      const [[estado]] = await connection.query(
        `SELECT
           c.valor = ? AS valor_atualizado,
           (SELECT COUNT(*) FROM auditoria a
             WHERE a.modulo = 'CONFIGURACOES'
               AND a.acao = 'ALTERAR_CONFIGURACAO'
               AND a.entidade = 'configuracoes'
               AND a.entidade_id = c.chave) AS auditorias,
           (SELECT COUNT(*) FROM auditoria a
             WHERE a.entidade = 'configuracoes'
               AND a.entidade_id = c.chave
               AND (CAST(a.dados_antes AS CHAR) LIKE ?
                 OR CAST(a.dados_depois AS CHAR) LIKE ?)) AS valores_na_auditoria
         FROM configuracoes c WHERE c.chave = ? LIMIT 1`,
        [
          contexto.configuracao.valorFinal,
          `%${contexto.configuracao.valorInicial}%`,
          `%${contexto.configuracao.valorFinal}%`,
          contexto.configuracao.chave
        ]
      );
      return res.json({ ok: true, estado: estado || null });
    }
    if (req.query.cenario === 'atendimento') {
      const [[estado]] = await connection.query(
        `SELECT
           a.status,
           a.modo,
           a.responsavel_id,
           a.finalizado_em IS NOT NULL AS finalizado,
           (SELECT COUNT(*) FROM atendimento_transferencias t
             WHERE t.atendimento_id = a.id) AS transferencias,
           (SELECT COUNT(*) FROM atendimento_mensagens m
             WHERE m.atendimento_id = a.id AND m.direcao = 'INTERNA'
               AND m.autor_tipo = 'ATENDENTE' AND m.texto = ?) AS notas,
           (SELECT COUNT(*) FROM atendimento_mensagens m
             WHERE m.atendimento_id = a.id AND m.direcao = 'SAIDA'
               AND m.mensagem_externa_id = ?) AS mensagens_whatsapp,
           (SELECT COUNT(*) FROM auditoria au
             WHERE au.entidade = 'atendimentos'
               AND au.entidade_id = CAST(a.id AS CHAR)) AS auditorias
         FROM atendimentos a WHERE a.id = ? LIMIT 1`,
        [
          contexto.atendimento.nota,
          contexto.atendimento.mensagemExternaId,
          contexto.atendimento.id
        ]
      );
      return res.json({
        ok: true,
        estado: estado || null,
        chamadas_whatsapp: contexto.atendimento.chamadasWhatsapp
      });
    }
    if (req.query.cenario === 'administracao') {
      const [[estado]] = await connection.query(
        `SELECT
           u.id,
           u.status,
           u.senha_provisoria,
           (SELECT COUNT(*) FROM usuario_permissoes up
             WHERE up.usuario_id = u.id AND up.visualizar = 1) AS permissoes_visualizar,
           (SELECT COUNT(*) FROM auditoria a
             WHERE a.entidade = 'usuarios'
               AND a.entidade_id = CAST(u.id AS CHAR)) AS auditorias
         FROM usuarios u
         WHERE u.login = ?
         LIMIT 1`,
        [contexto.administracao.loginNovoUsuario]
      );
      const [[negado]] = await connection.query(
        'SELECT COUNT(*) AS criacoes_negadas FROM usuarios WHERE login = ?',
        [`${contexto.administracao.loginNovoUsuario}-negado`]
      );
      if (estado?.id) contexto.administracao.novoUsuarioId = estado.id;
      return res.json({
        ok: true,
        estado: { ...(estado || {}), criacoes_negadas: negado.criacoes_negadas }
      });
    }
    if (req.query.cenario === 'fechamento_fornecedor') {
      const [[estado]] = await connection.query(
        `SELECT
           ff.status,
           ff.quantidade_itens,
           ff.valor_total,
           ff.lancamento_financeiro_id,
           (SELECT COUNT(*) FROM fechamento_fornecedor_itens ffi
             WHERE ffi.fechamento_id = ff.id) AS itens,
           (SELECT COUNT(*) FROM lancamentos_financeiros lf
             WHERE lf.id = ff.lancamento_financeiro_id
               AND lf.tipo = 'DESPESA' AND lf.status = 'PAGO'
               AND lf.fornecedor_id = ff.fornecedor_id) AS lancamentos,
           (SELECT COUNT(*) FROM pagamentos pg
             WHERE pg.lancamento_id = ff.lancamento_financeiro_id
               AND pg.referencia_externa = ?) AS pagamentos
         FROM fechamentos_fornecedores ff
         WHERE ff.fornecedor_id = ? AND ff.periodo_inicio = ?
           AND ff.periodo_fim = ? AND ff.moeda = 'BRL'
         LIMIT 1`,
        [
          contexto.fechamentoFornecedor.referencia,
          contexto.fechamentoFornecedor.fornecedorId,
          contexto.fechamentoFornecedor.periodoInicio,
          contexto.fechamentoFornecedor.periodoFim
        ]
      );
      return res.json({ ok: true, estado: estado || null });
    }
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

  require('./rotas-pedidos')(app, pool);
  require('./rotas-clientes')(app, pool);
  require('./rotas-cadastros')(app, pool);
  require('./rotas-atendimento')(app, pool);
  require('./rotas-financeiro')(app, pool);
  require('./rotas-relatorios')(app, pool);
  require('./rotas-estornos')(app, pool);
  require('./rotas-fechamentos-fornecedores')(app, pool);
  require('./rotas-auditoria')(app, pool);
  require('./rotas-health')(app, pool);
  require('./rotas-integracoes')(app, pool);
  require('./rotas-mapeamentos-integracoes')(app, pool);
  require('./rotas-whatsapp-admin')(app, pool);
  require('./rotas-operacionais')(app, pool);

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
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo IN (?, ?, ?, ?, ?, ?, ?)) AS pedidos,
           (SELECT COUNT(*) FROM clientes WHERE nome IN (?, ?)) AS clientes,
           (SELECT COUNT(*) FROM fornecedores WHERE nome IN (?, ?)) AS fornecedores,
           (SELECT COUNT(*) FROM usuarios WHERE login IN (?, ?, ?, ?, ?)) AS usuarios,
           (SELECT COUNT(*) FROM usuario_permissoes
             WHERE usuario_id IN (?, ?, ?, ?)) AS permissoes,
           (SELECT COUNT(*) FROM auditoria
             WHERE entidade = 'usuarios' AND entidade_id IN (?, ?, ?, ?)) AS auditorias,
           (SELECT COUNT(*) FROM atendimentos WHERE protocolo = ?) AS atendimentos,
           (SELECT COUNT(*) FROM atendimento_mensagens
             WHERE atendimento_id = ?) AS mensagens_atendimento,
           (SELECT COUNT(*) FROM atendimento_transferencias
             WHERE atendimento_id = ?) AS transferencias_atendimento,
           (SELECT COUNT(*) FROM configuracoes WHERE chave = ?) AS configuracoes,
           (SELECT COUNT(*) FROM auditoria
             WHERE entidade = 'configuracoes' AND entidade_id = ?) AS auditorias_configuracao,
           (SELECT COUNT(*) FROM integracao_produto_mapeamentos
             WHERE produto_externo_id = ?) AS mapeamentos_integracao,
           (SELECT COUNT(*) FROM whatsapp_modelos
             WHERE nome = ?) AS modelos_whatsapp,
           (SELECT COUNT(*) FROM banco_senhas
             WHERE JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.api_senha_id'))
               IN (?, ?, ?) OR chassi IN (?, ?, ?)) AS cache`,
        [
          contexto?.encontrado?.protocolo,
          contexto?.naoEncontrado?.protocolo,
          contexto?.dadosInvalidos?.protocolo,
          contexto?.indisponivel?.protocolo,
          contexto?.resultadoFornecedor?.protocolo,
          contexto?.estorno?.protocolo,
          contexto?.fechamentoFornecedor?.protocolo,
          contexto?.nomeCliente,
          contexto?.cadastros?.clienteNome,
          contexto?.nomeFornecedor,
          contexto?.cadastros?.fornecedorNome,
          contexto?.autenticacao?.administrador?.login,
          contexto?.autenticacao?.visualizador?.login,
          contexto?.administracao?.loginNovoUsuario,
          `${contexto?.administracao?.loginNovoUsuario}-negado`,
          contexto?.autenticacao?.atendente?.login,
          contexto?.usuario?.id || 0,
          contexto?.administracao?.visualizadorId || 0,
          contexto?.administracao?.novoUsuarioId || 0,
          contexto?.atendimento?.atendenteId || 0,
          String(contexto?.usuario?.id || 0),
          String(contexto?.administracao?.visualizadorId || 0),
          String(contexto?.administracao?.novoUsuarioId || 0),
          String(contexto?.atendimento?.atendenteId || 0),
          contexto?.atendimento?.protocolo,
          contexto?.atendimento?.id || 0,
          contexto?.atendimento?.id || 0,
          contexto?.configuracao?.chave,
          contexto?.configuracao?.chave,
          contexto?.integracoes?.produtoExternoId,
          contexto?.integracoes?.nomeModeloWhatsapp,
          String(contexto?.encontrado?.apiSenhaId),
          String(contexto?.dadosInvalidos?.apiSenhaId),
          String(contexto?.indisponivel?.apiSenhaId),
          contexto?.resultadoFornecedor?.chassi,
          contexto?.bancoSenhas?.chassi,
          contexto?.bancoSenhas?.novoChassi
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
