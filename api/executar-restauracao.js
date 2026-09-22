'use strict';

const path = require('path');
const {
  criarBackup,
  restaurarBackup,
  restaurarMysql
} = require('./backup-centralmykey');

async function executar() {
  const diretorio = process.argv[2];
  const confirmado = process.argv.includes('--confirmar-restauracao');
  if (!diretorio || !confirmado) {
    throw new Error(
      'Uso: node executar-restauracao.js DIRETORIO --confirmar-restauracao'
    );
  }
  const backupSeguranca = await criarBackup();
  try {
    await restaurarBackup(path.resolve(diretorio), {
      apiDestino: '/opt/central-mykey-api',
      webDestino: '/opt/central-mykey-web',
      webPublicDestino: '/var/www/central-mykey-test',
      envPath: '/opt/central-mykey-api/.env'
    });
  } catch (erro) {
    try {
      await restaurarMysql(
        path.join(backupSeguranca.diretorio, 'database.sql.gz'),
        '/opt/central-mykey-api/.env'
      );
      erro.message += '; banco revertido automaticamente para o backup de segurança';
    } catch (erroRollback) {
      erro.message += `; rollback do banco falhou: ${erroRollback.message}`;
    }
    erro.message += `; backup de segurança preservado em ${backupSeguranca.diretorio}`;
    throw erro;
  }
  console.log(
    `Restauração concluída; backup anterior preservado em ${backupSeguranca.diretorio}`
  );
}

executar().catch(erro => {
  console.error(`Falha na restauração: ${erro.message}`);
  process.exitCode = 1;
});
