'use strict';

const { criarBackup } = require('./backup-centralmykey');

criarBackup().then(resultado => {
  console.log(`Backup criado e verificado em ${resultado.diretorio}`);
}).catch(erro => {
  console.error(`Falha ao criar backup: ${erro.message}`);
  process.exitCode = 1;
});
