'use strict';

const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  MIGRACOES,
  TABELAS_ESPERADAS
} = require('./validar-migracoes-descartaveis');

async function aplicarMigracoes(opcoes = {}) {
  const envPath = opcoes.envPath || process.env.CENTRALMYKEY_ENV_PATH ||
    '/opt/central-mykey-api/.env';
  const configuracao = dotenv.parse(await fs.readFile(envPath));
  for (const chave of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    if (!configuracao[chave]) throw new Error(`Configuração ausente: ${chave}`);
  }
  const connection = await mysql.createConnection({
    host: configuracao.DB_HOST,
    port: Number(configuracao.DB_PORT || 3306),
    user: configuracao.DB_USER,
    password: configuracao.DB_PASSWORD,
    database: configuracao.DB_NAME,
    multipleStatements: true
  });
  try {
    for (const nome of MIGRACOES) {
      const sql = await fs.readFile(path.join(__dirname, 'migrations', nome), 'utf8');
      await connection.query(sql);
      console.log(`Migração aplicada: ${nome}`);
    }
    const [tabelas] = await connection.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = ? AND table_name IN (?)`,
      [configuracao.DB_NAME, TABELAS_ESPERADAS]
    );
    const presentes = new Set(tabelas.map(item => item.TABLE_NAME || item.table_name));
    const ausentes = TABELAS_ESPERADAS.filter(nome => !presentes.has(nome));
    if (ausentes.length) {
      throw new Error(`Tabelas ausentes após migração: ${ausentes.join(', ')}`);
    }
    return { migracoes: MIGRACOES.length, tabelas: presentes.size };
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  if (!process.argv.includes('--confirmar-migracoes')) {
    console.error(
      'Uso: node aplicar-migracoes-release.js --confirmar-migracoes'
    );
    process.exitCode = 2;
  } else {
    aplicarMigracoes().then(resultado => {
      console.log(
        `Migrações concluídas: ${resultado.migracoes}; ` +
        `tabelas verificadas: ${resultado.tabelas}`
      );
    }).catch(erro => {
      console.error(`Falha ao aplicar migrações: ${erro.message}`);
      process.exitCode = 1;
    });
  }
}

module.exports = { aplicarMigracoes };
