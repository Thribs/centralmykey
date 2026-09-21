'use strict';

require('dotenv').config();

const { executarBackupAgendado } = require('./agendar-backup');

executarBackupAgendado().then(resultado => {
  if (!resultado.executado) {
    console.log('Backup não iniciado: outro processo está em andamento');
    return;
  }
  console.log(
    `Backup verificado em ${resultado.diretorio}; ` +
    `${resultado.retencao.removidos.length} pacote(s) expirado(s) removido(s)`
  );
}).catch(erro => {
  console.error(`Falha no backup agendado: ${erro.message}`);
  process.exitCode = 1;
});
