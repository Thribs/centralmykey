'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { reconciliarVipsVencidos } = require('./reconciliar-vips-vencidos');

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
  const marcador = `VIP-RECONCILIACAO-${process.pid}-${Date.now()}`;
  const clientes = [];
  let erro;

  try {
    await connection.beginTransaction();
    for (let indice = 0; indice < 5; indice += 1) {
      const telefone = `5577${String(Date.now() + indice).slice(-9)}`;
      const [resultado] = await connection.query(
        `INSERT INTO clientes
           (nome, telefone, telefone_normalizado, cadastro_status, ativo)
         VALUES (?, ?, ?, 'COMPLETO', 1)`,
        [`${marcador}-${indice}`, telefone, telefone]
      );
      clientes.push(resultado.insertId);
    }

    await connection.query(
      `INSERT INTO cliente_vip
         (cliente_id, status, valor_mensalidade, inicio, proximo_vencimento)
       VALUES
         (?, 'ATIVO', 90, '2026-08-01', '2026-09-20'),
         (?, 'AGUARDANDO_PAGAMENTO', 90, '2026-08-01', '2026-09-20'),
         (?, 'ATIVO', 90, '2026-08-01', '2026-09-21'),
         (?, 'SUSPENSO', 90, '2026-08-01', '2026-09-20'),
         (?, 'ATIVO', 90, '2026-08-01', NULL)`,
      clientes
    );

    const pool = poolTransacional(connection);
    const primeiro = await reconciliarVipsVencidos(pool, { hoje: '2026-09-21' });
    assert.deepStrictEqual(primeiro, {
      executado: true,
      analisados: 2,
      atualizados: 2
    });

    const [estados] = await connection.query(
      `SELECT cliente_id, status FROM cliente_vip
        WHERE cliente_id IN (?) ORDER BY cliente_id`,
      [clientes]
    );
    assert.deepStrictEqual(
      estados.map(item => item.status),
      ['VENCIDO', 'VENCIDO', 'ATIVO', 'SUSPENSO', 'ATIVO']
    );

    const [auditorias] = await connection.query(
      `SELECT acao, entidade_id, dados_antes, dados_depois
         FROM auditoria
        WHERE acao = 'VENCER_VIP_AUTOMATICO'
          AND entidade_id IN (?)
        ORDER BY entidade_id`,
      [clientes.map(String)]
    );
    assert.strictEqual(auditorias.length, 2);
    assert.ok(auditorias.every(item => item.acao === 'VENCER_VIP_AUTOMATICO'));
    const auditoriaSerializada = JSON.stringify(auditorias);
    assert.ok(!auditoriaSerializada.includes(marcador));
    assert.ok(!auditoriaSerializada.includes('5577'));

    const segundo = await reconciliarVipsVencidos(pool, { hoje: '2026-09-21' });
    assert.deepStrictEqual(segundo, {
      executado: true,
      analisados: 0,
      atualizados: 0
    });
    await assert.rejects(
      () => reconciliarVipsVencidos(pool, { hoje: '21/09/2026' }),
      /Data de reconciliação VIP inválida/
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM clientes WHERE nome LIKE ?) AS clientes,
           (SELECT COUNT(*) FROM auditoria
             WHERE acao='VENCER_VIP_AUTOMATICO'
               AND entidade_id IN (?)) AS auditorias`,
        [`${marcador}%`, clientes.map(String)]
      );
      assert.deepStrictEqual(
        [Number(residuos.clientes), Number(residuos.auditorias)],
        [0, 0]
      );
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: VIP vencido é reconciliado uma vez, auditado e revertido');
}

executar().catch(erro => {
  console.error(`FALHA: reconciliação VIP: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
