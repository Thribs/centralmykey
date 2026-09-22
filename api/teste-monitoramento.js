'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { criarTabelaOutboxTemporaria } = require('./teste-suporte-outbox');
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

process.env.MONITORAMENTO_PEDIDO_ATRASO_MINUTOS = '10';
process.env.MONITORAMENTO_OUTBOX_ATRASO_MINUTOS = '10';
process.env.MONITORAMENTO_EVENTO_ATRASO_MINUTOS = '10';

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

async function iniciarApi(connection) {
  const app = express();
  app.locals.autenticarToken = (req, res, next) => next();
  app.locals.exigirPermissao = (modulo, acao) => (req, res, next) => {
    if (req.headers['x-negar'] === `${modulo}:${acao}`) {
      return res.status(403).json({ ok: false, error: 'Permissão negada no teste' });
    }
    next();
  };
  require('./rotas-health')(app, {
    query: (...args) => connection.query(...args)
  }, {
    obterEstadoBackup: async () => ({
      status: 'OK', integridade: true,
      ultimo_backup_em: '2026-09-21T03:00:00.000Z',
      idade_horas: 2, limite_horas: 30,
      externo: {
        configurado: true, status: 'OK', integridade: true,
        ultimo_backup_em: '2026-09-21T03:00:00.000Z',
        idade_horas: 2, limite_horas: 30
      }
    })
  });
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function requisitar(url, headers = {}) {
  const resposta = await fetch(url, { headers });
  return { resposta, corpo: await resposta.json() };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

function delta(depois, antes, campo) {
  return Number(depois[campo] || 0) - Number(antes[campo] || 0);
}

async function criarTabelaEventosTemporaria(connection) {
  await connection.query(`
    CREATE TEMPORARY TABLE integracao_eventos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      provedor VARCHAR(40) NOT NULL,
      evento_externo_id VARCHAR(160) NOT NULL,
      tipo VARCHAR(80) NOT NULL,
      referencia_externa VARCHAR(120),
      entidade VARCHAR(40),
      entidade_id BIGINT,
      lancamento_id BIGINT,
      pagamento_id BIGINT,
      payload_hash CHAR(64) NOT NULL,
      payload JSON NOT NULL,
      status ENUM('RECEBIDO','PROCESSADO','IGNORADO','FALHOU') DEFAULT 'RECEBIDO',
      tentativas SMALLINT UNSIGNED DEFAULT 1,
      erro_codigo VARCHAR(80),
      erro_detalhe VARCHAR(500),
      recebido_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      processado_em DATETIME,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_evento (provedor, evento_externo_id)
    ) ENGINE=InnoDB
  `);
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const sufixo = `${process.pid}${String(Date.now()).slice(-8)}`;
  const marcador = `MON-${sufixo}`;
  let servidor;
  let clienteId;
  let fornecedorId;
  const pedidos = [];
  let erro;

  try {
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);
    await criarTabelasNotificacoesTemporarias(connection);
    await criarTabelaEventosTemporaria(connection);
    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    assert.ok(servico, 'Serviço GM ativo é necessário para o monitoramento');
    const api = await iniciarApi(connection);
    servidor = api.servidor;
    const url = `${api.url}/api/monitoramento/resumo`;

    const negado = await requisitar(url, {
      'x-negar': 'CONFIGURACOES:visualizar'
    });
    assert.strictEqual(negado.resposta.status, 403);
    const baseline = await requisitar(url);
    assert.strictEqual(baseline.resposta.status, 200);

    const telefone = `5577${sufixo}`;
    const [cliente] = await connection.query(`
      INSERT INTO clientes
        (nome, telefone, telefone_normalizado, cadastro_status, ativo)
      VALUES (?, ?, ?, 'COMPLETO', 1)
    `, [`CLIENTE ${marcador}`, telefone, telefone]);
    clienteId = cliente.insertId;
    const [fornecedor] = await connection.query(`
      INSERT INTO fornecedores (nome, tipo, ativo)
      VALUES (?, 'PESSOA', 1)
    `, [`FORNECEDOR ${marcador}`]);
    fornecedorId = fornecedor.insertId;

    async function criarPedido(codigo, status, fornecedorPedido = null) {
      const [resultado] = await connection.query(`
        INSERT INTO pedidos_senha
          (protocolo, cliente_id, servico_id, chassi, marca, status,
           valor_venda, custo, moeda, fornecedor_id, atualizado_em)
        VALUES (?, ?, ?, ?, 'GM', ?, 50, 0, 'BRL', ?,
                DATE_SUB(NOW(), INTERVAL 30 MINUTE))
      `, [`${marcador}-${codigo}`, clienteId, servico.id,
        `CHASSI${marcador}${codigo}`, status, fornecedorPedido]);
      pedidos.push(resultado.insertId);
      return resultado.insertId;
    }

    await criarPedido('PAG', 'AGUARDANDO_PAGAMENTO');
    await criarPedido('DAD', 'AGUARDANDO_DADOS');
    await criarPedido('CON', 'EM_CONSULTA', fornecedorId);
    await criarPedido('PGO', 'PAGO');
    const pedidoReprocessamento = await criarPedido('REP', 'ABERTO');
    await connection.query(`
      INSERT INTO pedido_historico
        (pedido_id, tipo, descricao, criado_em)
      VALUES (?, 'API_JOELPIRES_INDISPONIVEL', 'Falha simulada',
              DATE_SUB(NOW(), INTERVAL 30 MINUTE))
    `, [pedidoReprocessamento]);

    const estadosOutbox = [
      ['PENDENTE', pedidos[0]],
      ['PROCESSANDO', pedidos[1]],
      ['FALHOU', pedidos[2]],
      ['INCERTA', pedidos[3]]
    ];
    for (let indice = 0; indice < estadosOutbox.length; indice += 1) {
      const [status, pedidoId] = estadosOutbox[indice];
      await connection.query(`
        INSERT INTO comunicacoes_outbox
          (chave_idempotencia, canal, finalidade, pedido_id, fornecedor_id,
           destinatario, payload, status, processar_apos, criado_em, atualizado_em)
        VALUES (?, 'WHATSAPP', 'CONSULTA_FORNECEDOR', ?, ?, '5500000000000',
                '{}', ?, DATE_SUB(NOW(), INTERVAL 30 MINUTE),
                DATE_SUB(NOW(), INTERVAL 30 MINUTE),
                DATE_SUB(NOW(), INTERVAL 30 MINUTE))
      `, [`${marcador}-OUT-${indice}`, pedidoId, fornecedorId, status]);
    }

    for (const [indice, status] of ['RECEBIDO', 'FALHOU'].entries()) {
      await connection.query(`
        INSERT INTO integracao_eventos
          (provedor, evento_externo_id, tipo, payload_hash, payload, status,
           recebido_em, atualizado_em)
        VALUES ('SICOOB', ?, 'PIX', ?, '{}', ?,
                DATE_SUB(NOW(), INTERVAL 30 MINUTE),
                DATE_SUB(NOW(), INTERVAL 30 MINUTE))
      `, [`${marcador}-EVT-${indice}`, String(indice + 1).padStart(64, '0'), status]);
    }

    await connection.query(`
      INSERT INTO notificacoes
        (chave, tipo, nivel, modulo, titulo, mensagem, status)
      VALUES
        (?, 'MONITORAMENTO_TESTE', 'CRITICA', 'CONFIGURACOES',
         'Crítica simulada', 'Mensagem fictícia', 'ATIVA'),
        (?, 'MONITORAMENTO_TESTE', 'ATENCAO', 'CONFIGURACOES',
         'Atenção simulada', 'Mensagem fictícia', 'ATIVA')
    `, [`${marcador}-NOT-1`, `${marcador}-NOT-2`]);

    const atual = await requisitar(url);
    assert.strictEqual(atual.resposta.status, 200);
    assert.strictEqual(atual.corpo.status, 'CRITICO');
    assert.strictEqual(atual.corpo.backup.status, 'OK');
    assert.strictEqual(atual.corpo.backup.integridade, true);
    assert.strictEqual(atual.corpo.backup.externo.status, 'OK');
    assert.strictEqual(atual.corpo.limites.pedido_atraso_minutos, 10);
    for (const campo of [
      'aguardando_pagamento_atrasados', 'aguardando_dados_atrasados',
      'em_consulta_atrasados', 'pagos_atrasados',
      'aguardando_reprocessamento_gm'
    ]) {
      assert.strictEqual(delta(atual.corpo.pedidos, baseline.corpo.pedidos, campo), 1);
    }
    for (const campo of [
      'pendentes', 'pendentes_atrasadas', 'processando_atrasadas',
      'falhas', 'incertas'
    ]) {
      assert.strictEqual(
        delta(atual.corpo.comunicacoes, baseline.corpo.comunicacoes, campo),
        1
      );
    }
    for (const campo of ['recebidos', 'recebidos_atrasados', 'falhas']) {
      assert.strictEqual(delta(atual.corpo.integracoes, baseline.corpo.integracoes, campo), 1);
    }
    assert.strictEqual(delta(atual.corpo.notificacoes, baseline.corpo.notificacoes, 'ativas'), 2);
    assert.strictEqual(delta(atual.corpo.notificacoes, baseline.corpo.notificacoes, 'criticas'), 1);
    assert.strictEqual(delta(atual.corpo.notificacoes, baseline.corpo.notificacoes, 'atencoes'), 1);
    const respostaTexto = JSON.stringify(atual.corpo);
    assert.ok(!respostaTexto.includes(marcador));
    assert.ok(!respostaTexto.includes('5500000000000'));
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(`
        SELECT
          (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo LIKE ?) AS pedidos,
          (SELECT COUNT(*) FROM clientes WHERE id=?) AS clientes,
          (SELECT COUNT(*) FROM fornecedores WHERE id=?) AS fornecedores,
          (SELECT COUNT(*) FROM comunicacoes_outbox WHERE chave_idempotencia LIKE ?) AS outbox,
          (SELECT COUNT(*) FROM integracao_eventos WHERE evento_externo_id LIKE ?) AS eventos,
          (SELECT COUNT(*) FROM notificacoes WHERE chave LIKE ?) AS notificacoes
      `, [`${marcador}%`, clienteId || 0, fornecedorId || 0,
        `${marcador}%`, `${marcador}%`, `${marcador}%`]);
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0, 0, 0, 0, 0]);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: monitoramento resume atrasos e falhas sem expor dados (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: monitoramento: ${erro.message}`);
  process.exitCode = 1;
});
