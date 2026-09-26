'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  reconciliarCobrancasSicoobExpiradas
} = require('./expirar-cobrancas-sicoob');

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

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const marcador = `SIC-REC-${process.pid}-${Date.now()}`;
  const protocolo = marcador.slice(0, 30);
  let pedidoId = 0;
  let erro;

  try {
    await connection.beginTransaction();
    await connection.query(`CREATE TEMPORARY TABLE integracao_referencias_pagamento (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, provedor VARCHAR(40) NOT NULL,
      entidade VARCHAR(40) NOT NULL, entidade_id BIGINT NOT NULL,
      referencia_provedor VARCHAR(120) NOT NULL, valor DECIMAL(12,2) NOT NULL,
      moeda CHAR(3) NOT NULL DEFAULT 'BRL', expiracao_segundos INT UNSIGNED,
      status ENUM('PREPARADA','REGISTRADA','PAGA','CANCELADA','EXPIRADA','FALHOU'),
      erro_codigo VARCHAR(80), erro_detalhe VARCHAR(500),
      criada_em DATETIME NOT NULL, atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[cliente]] = await connection.query(
      `SELECT id, telefone, telefone_normalizado
         FROM clientes WHERE ativo=1 ORDER BY id LIMIT 1`
    );
    assert.ok(servico && cliente, 'Base ativa é necessária');
    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda)
       VALUES (?, ?, ?, ?, 'GM', 'TESTE RECONCILIACAO SICOOB', 2026,
               'AGUARDANDO_PAGAMENTO', 60, 0, 'BRL')`,
      [protocolo, cliente.id, servico.id, `9BGREC${String(Date.now()).slice(-11)}`]
    );
    pedidoId = pedido.insertId;
    const [atendimento] = await connection.query(
      `INSERT INTO atendimentos
         (protocolo, cliente_id, telefone, telefone_normalizado, canal, modo,
          status, prioridade, assunto, ultima_mensagem_em)
       VALUES (?, ?, ?, ?, 'WHATSAPP', 'ELETRONICO', 'AGUARDANDO_PAGAMENTO',
               'NORMAL', 'Senha GM · aguardando Pix', NOW())`,
      [`ATD-${protocolo}`.slice(0, 30), cliente.id,
        cliente.telefone, cliente.telefone_normalizado]
    );
    await connection.query(
      `INSERT INTO pedido_historico (pedido_id, tipo, descricao, dados)
       VALUES (?, 'ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO', 'Teste', ?)`,
      [pedidoId, JSON.stringify({ atendimento_id: atendimento.insertId })]
    );
    await connection.query(
      `INSERT INTO integracao_referencias_pagamento
         (provedor, entidade, entidade_id, referencia_provedor, valor, moeda,
          expiracao_segundos, status, criada_em)
       VALUES
         ('SICOOB','PEDIDO',?,'SICRECEXPIRADA00000000000001',60,'BRL',3600,'REGISTRADA','2026-09-21 10:00:00'),
         ('SICOOB','PEDIDO',?,'SICRECLIMITE000000000000002',60,'BRL',3600,'PREPARADA','2026-09-21 11:00:00'),
         ('SICOOB','PEDIDO',?,'SICRECATIVA0000000000000003',60,'BRL',3600,'PREPARADA','2026-09-21 11:30:00'),
         ('SICOOB','PEDIDO',?,'SICRECPAGA00000000000000004',60,'BRL',3600,'PAGA','2026-09-21 10:00:00')`,
      [pedidoId, pedidoId, pedidoId, pedidoId]
    );

    const pool = poolTransacional(connection);
    const primeiro = await reconciliarCobrancasSicoobExpiradas(pool, {
      agora: '2026-09-21 12:00:00'
    });
    assert.deepStrictEqual(primeiro, {
      executado: true,
      analisadas: 2,
      pedidos: 1,
      atualizadas: 2
    });

    const [referencias] = await connection.query(
      `SELECT status, erro_codigo
         FROM integracao_referencias_pagamento ORDER BY id`
    );
    assert.deepStrictEqual(
      referencias.map(item => [item.status, item.erro_codigo]),
      [
        ['EXPIRADA', 'COBRANCA_EXPIRADA'],
        ['EXPIRADA', 'COBRANCA_EXPIRADA'],
        ['PREPARADA', null],
        ['PAGA', null]
      ]
    );

    const [[efeitos]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id=? AND tipo='COBRANCA_SICOOB_EXPIRADA') AS historicos,
         (SELECT COUNT(*) FROM auditoria
           WHERE entidade='pedidos_senha' AND entidade_id=?
             AND acao='EXPIRAR_COBRANCA_SICOOB') AS auditorias`,
      [pedidoId, String(pedidoId)]
    );
    assert.deepStrictEqual(Object.values(efeitos).map(Number), [1, 1]);
    const [[atendimentoExpirado]] = await connection.query(
      'SELECT modo, status FROM atendimentos WHERE id=?', [atendimento.insertId]
    );
    assert.deepStrictEqual(
      [atendimentoExpirado.modo, atendimentoExpirado.status],
      ['HUMANO', 'FILA']
    );

    const segundo = await reconciliarCobrancasSicoobExpiradas(pool, {
      agora: '2026-09-21 12:00:00'
    });
    assert.deepStrictEqual(segundo, {
      executado: true,
      analisadas: 0,
      pedidos: 0,
      atualizadas: 0
    });
    await assert.rejects(
      () => reconciliarCobrancasSicoobExpiradas(pool, { agora: '21/09/2026' }),
      /Data de reconciliação Sicoob inválida/
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo=?) AS pedidos,
           (SELECT COUNT(*) FROM pedido_historico
             WHERE pedido_id=? AND tipo='COBRANCA_SICOOB_EXPIRADA') AS historicos`,
        [protocolo, pedidoId]
      );
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0]);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: cobranças Sicoob vencidas são reconciliadas e revertidas');
}

executar().catch(erro => {
  console.error(`FALHA: reconciliação de cobranças Sicoob: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
