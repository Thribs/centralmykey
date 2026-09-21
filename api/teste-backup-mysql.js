'use strict';

const assert = require('assert');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { gzipSync } = require('zlib');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { restaurarMysql } = require('./backup-centralmykey');

const envPath = process.env.CENTRALMYKEY_ENV_PATH || (
  process.env.DB_HOST
    ? path.join(__dirname, '.env')
    : '/opt/central-mykey-api/.env'
);
dotenv.config({ path: envPath, quiet: true });

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

async function executar() {
  const temporario = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmk-restore-mysql-'));
  const tabela = `cmk_restore_${process.pid}_${Date.now()}`;
  const arquivo = path.join(temporario, 'database.sql.gz');
  let connection;

  try {
    const sql = `
      CREATE TEMPORARY TABLE ${tabela} (
        id INT NOT NULL PRIMARY KEY,
        valor VARCHAR(40) NOT NULL
      ) ENGINE=InnoDB;
      START TRANSACTION;
      INSERT INTO ${tabela} (id, valor) VALUES (1, 'PRIMEIRA_TRANSACAO');
      ROLLBACK;
      START TRANSACTION;
      INSERT INTO ${tabela} (id, valor) VALUES (1, 'SEGUNDA_TRANSACAO');
      ROLLBACK;
      DROP TEMPORARY TABLE ${tabela};
    `;
    await fsp.writeFile(arquivo, gzipSync(sql), { mode: 0o600 });
    await restaurarMysql(arquivo, envPath);

    connection = await mysql.createConnection(configBanco);
    const [[residuo]] = await connection.query(`
      SELECT COUNT(*) AS total
        FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name = ?
    `, [tabela]);
    assert.strictEqual(Number(residuo.total), 0);
    console.log('OK: restauração MySQL real usa transações temporárias sem resíduos');
  } finally {
    if (connection) await connection.end();
    await fsp.rm(temporario, { recursive: true, force: true });
  }
}

executar().catch(erro => {
  console.error(`FALHA: restauração MySQL controlada: ${erro.message}`);
  process.exitCode = 1;
});
