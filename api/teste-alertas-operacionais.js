'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  reconciliarAlertasOperacionais
} = require('./reconciliar-alertas-operacionais');
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
    })
  };
}

async function criarTabelaEventosTemporaria(connection) {
  await connection.query(`
    CREATE TEMPORARY TABLE integracao_eventos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      provedor VARCHAR(40) NOT NULL,
      evento_externo_id VARCHAR(160) NOT NULL,
      tipo VARCHAR(80) NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      payload JSON NOT NULL,
      status ENUM('RECEBIDO','PROCESSADO','IGNORADO','FALHOU') DEFAULT 'RECEBIDO',
      recebido_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_evento (provedor, evento_externo_id)
    ) ENGINE=InnoDB
  `);
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const marcador = `ALERTA-${process.pid}-${String(Date.now()).slice(-8)}`;
  let pedidoId;
  let clienteId;
  let erro;
  try {
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);
    await criarTabelasNotificacoesTemporarias(connection);
    await criarTabelaEventosTemporaria(connection);
    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    assert.ok(servico, 'Serviço GM ativo é obrigatório');

    const telefone = `5576${String(Date.now()).slice(-8)}`;
    const [cliente] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo)
       VALUES (?, ?, ?, 'COMPLETO', 1)`,
      [`CLIENTE ${marcador}`, telefone, telefone]
    );
    clienteId = cliente.insertId;
    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, status,
          valor_venda, custo, moeda, atualizado_em)
       VALUES (?, ?, ?, ?, 'GM', 'ABERTO', 50, 0, 'BRL',
               DATE_SUB(NOW(), INTERVAL 30 MINUTE))`,
      [marcador, clienteId, servico.id, `CHASSI${marcador}`]
    );
    pedidoId = pedido.insertId;
    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, tipo, descricao, criado_em)
       VALUES (?, 'FORNECEDOR_GM_INDISPONIVEL', 'Espera simulada',
               DATE_SUB(NOW(), INTERVAL 30 MINUTE))`,
      [pedidoId]
    );
    await connection.query(
      `INSERT INTO comunicacoes_outbox
         (chave_idempotencia, canal, finalidade, pedido_id,
          destinatario, payload, status, processar_apos, atualizado_em)
       VALUES
         (?, 'WHATSAPP', 'ENTREGA_CLIENTE', ?, '5500000000000', '{}',
          'PENDENTE', DATE_SUB(NOW(), INTERVAL 30 MINUTE),
          DATE_SUB(NOW(), INTERVAL 30 MINUTE)),
         (?, 'WHATSAPP', 'ENTREGA_CLIENTE', ?, '5500000000000', '{}',
          'PROCESSANDO', NOW(), DATE_SUB(NOW(), INTERVAL 30 MINUTE))`,
      [`${marcador}:P`, pedidoId, `${marcador}:X`, pedidoId]
    );
    await connection.query(
      `INSERT INTO integracao_eventos
         (provedor, evento_externo_id, tipo, payload_hash, payload, status,
          recebido_em)
       VALUES
         ('SICOOB', ?, 'PIX', ?, '{}', 'FALHOU', NOW()),
         ('WBUY', ?, 'PEDIDO', ?, '{}', 'RECEBIDO',
          DATE_SUB(NOW(), INTERVAL 30 MINUTE))`,
      [
        `${marcador}:F`, '1'.padStart(64, '0'),
        `${marcador}:R`, '2'.padStart(64, '0')
      ]
    );

    const pool = poolTransacional(connection);
    const primeiro = await reconciliarAlertasOperacionais(pool, {
      pedidoMinutos: 10,
      outboxMinutos: 10,
      eventoMinutos: 10,
      obterEstadoBackup: async () => ({
        status: 'ATRASADO', integridade: true,
        ultimo_backup_em: '2026-09-19T03:00:00.000Z',
        idade_horas: 48, limite_horas: 30
      })
    });
    assert.strictEqual(primeiro.executado, true);
    assert.deepStrictEqual(primeiro.totais, {
      gm: 1,
      outboxPendentes: 1,
      outboxProcessando: 1,
      integracoesFalhas: 1,
      integracoesAtrasadas: 1,
      backupStatus: 'ATRASADO'
    });
    assert.strictEqual(primeiro.alertas.filter(item => item.alterada).length, 4);

    const [notificacoes] = await connection.query(
      `SELECT id, chave, nivel, status, dados FROM notificacoes ORDER BY chave`
    );
    assert.strictEqual(notificacoes.length, 4);
    assert.deepStrictEqual(
      notificacoes.map(item => item.nivel).sort(),
      ['ATENCAO', 'CRITICA', 'CRITICA', 'CRITICA']
    );
    const serializado = JSON.stringify(notificacoes);
    assert.ok(!serializado.includes(marcador));
    assert.ok(!serializado.includes('5500000000000'));
    for (const notificacao of notificacoes) {
      await connection.query(
        `INSERT INTO notificacao_leituras
           (notificacao_id, usuario_id, lida_em) VALUES (?, 999999, NOW())`,
        [notificacao.id]
      );
    }

    const segundo = await reconciliarAlertasOperacionais(pool, {
      pedidoMinutos: 10,
      outboxMinutos: 10,
      eventoMinutos: 10,
      obterEstadoBackup: async () => ({
        status: 'ATRASADO', integridade: true,
        ultimo_backup_em: '2026-09-19T03:00:00.000Z',
        idade_horas: 48, limite_horas: 30
      })
    });
    assert.strictEqual(segundo.alertas.filter(item => item.alterada).length, 0);
    const [[leituras]] = await connection.query(
      'SELECT COUNT(*) AS total FROM notificacao_leituras'
    );
    assert.strictEqual(Number(leituras.total), 4, 'Ciclo igual não deve reabrir leitura');

    await connection.query(
      "UPDATE pedidos_senha SET status='CANCELADO' WHERE id=?",
      [pedidoId]
    );
    await connection.query(
      "UPDATE comunicacoes_outbox SET status='CANCELADA' WHERE chave_idempotencia LIKE ?",
      [`${marcador}%`]
    );
    await connection.query(
      "UPDATE integracao_eventos SET status='PROCESSADO' WHERE evento_externo_id LIKE ?",
      [`${marcador}%`]
    );
    const resolvido = await reconciliarAlertasOperacionais(pool, {
      pedidoMinutos: 10,
      outboxMinutos: 10,
      eventoMinutos: 10,
      obterEstadoBackup: async () => ({
        status: 'OK', integridade: true,
        ultimo_backup_em: '2026-09-21T03:00:00.000Z',
        idade_horas: 1, limite_horas: 30
      })
    });
    assert.strictEqual(resolvido.alertas.filter(item => item.alterada).length, 4);
    const [[estadoFinal]] = await connection.query(
      `SELECT SUM(status='ATIVA') AS ativas,
              SUM(status='RESOLVIDA') AS resolvidas
         FROM notificacoes`
    );
    assert.deepStrictEqual(
      [Number(estadoFinal.ativas), Number(estadoFinal.resolvidas)],
      [0, 4]
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo=?) AS pedidos,
           (SELECT COUNT(*) FROM clientes WHERE id=?) AS clientes`,
        [marcador, clienteId || 0]
      );
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0]);
    } catch (limpeza) {
      erro = erro || limpeza;
    } finally {
      await connection.end();
    }
  }
  if (erro) throw erro;
  console.log(
    'OK: alertas operacionais são persistentes, estáveis e resolvidos (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: alertas operacionais: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
