'use strict';

const assert = require('assert');
const { obterEstadoBackup } = require('./estado-backup');

async function executar() {
  const agora = new Date('2026-09-21T12:00:00.000Z');
  const backup = horas => [{
    diretorio: '/backup/ficticio',
    criadoEm: new Date(agora.getTime() - horas * 3600000)
  }];
  const opcoes = {
    agora,
    limiteHoras: 30,
    semCache: true,
    listar: async () => backup(2),
    verificar: async () => ({ versao: 2 })
  };

  const valido = await obterEstadoBackup(opcoes);
  assert.deepStrictEqual(valido, {
    status: 'OK', integridade: true,
    ultimo_backup_em: '2026-09-21T10:00:00.000Z',
    idade_horas: 2, limite_horas: 30,
    externo: {
      configurado: false, status: 'NAO_CONFIGURADO', integridade: false,
      ultimo_backup_em: null, idade_horas: null, limite_horas: 30
    }
  });

  const comExterno = await obterEstadoBackup({
    ...opcoes, destinoExterno: '/backup/externo'
  });
  assert.strictEqual(comExterno.externo.configurado, true);
  assert.strictEqual(comExterno.externo.status, 'OK');

  const atrasado = await obterEstadoBackup({
    ...opcoes, listar: async () => backup(31)
  });
  assert.strictEqual(atrasado.status, 'ATRASADO');
  assert.strictEqual(atrasado.integridade, true);

  const invalido = await obterEstadoBackup({
    ...opcoes, verificar: async () => { throw new Error('hash inválido'); }
  });
  assert.strictEqual(invalido.status, 'INVALIDO');
  assert.strictEqual(invalido.integridade, false);

  const ausente = await obterEstadoBackup({ ...opcoes, listar: async () => [] });
  assert.strictEqual(ausente.status, 'AUSENTE');
  assert.strictEqual(ausente.ultimo_backup_em, null);

  const inacessivel = await obterEstadoBackup({
    ...opcoes, listar: async () => { throw new Error('sem acesso'); }
  });
  assert.strictEqual(inacessivel.status, 'INVALIDO');
  assert.ok(!JSON.stringify(inacessivel).includes('/backup/'),
    'O estado público não deve expor caminhos');

  console.log('OK: estado do backup classifica ausência, atraso e integridade sem expor caminhos');
}

executar().catch(erro => {
  console.error(`FALHA: estado do backup: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
