'use strict';

const assert = require('assert');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const {
  dataDoIdentificador,
  listarBackupsGerenciados,
  aplicarRetencao,
  executarBackupAgendado
} = require('./agendar-backup');

async function criarPacoteFicticio(raiz, nome) {
  const diretorio = path.join(raiz, nome);
  await fsp.mkdir(diretorio, { recursive: true });
  await fsp.writeFile(path.join(diretorio, 'manifesto.json'), '{}\n');
  return diretorio;
}

async function executar() {
  const temporario = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmk-backup-agenda-'));
  try {
    assert.equal(dataDoIdentificador('invalido'), null);
    assert.equal(dataDoIdentificador('20261340T250000Z'), null);
    assert.equal(
      dataDoIdentificador('20260921T120000Z').toISOString(),
      '2026-09-21T12:00:00.000Z'
    );

    const raizRetencao = path.join(temporario, 'retencao');
    await fsp.mkdir(raizRetencao);
    for (const nome of [
      '20260920T120000Z',
      '20260919T120000Z',
      '20260901T120000Z',
      '20260801T120000Z',
      '20260701T120000Z'
    ]) {
      await criarPacoteFicticio(raizRetencao, nome);
    }
    await fsp.mkdir(path.join(raizRetencao, '20260601T120000Z'));
    await fsp.mkdir(path.join(raizRetencao, 'backup-manual-preservado'));
    const retencao = await aplicarRetencao({
      raiz: raizRetencao,
      agora: new Date('2026-09-21T12:00:00Z'),
      dias: 30,
      minimo: 2
    });
    assert.deepStrictEqual(retencao.removidos, [
      '20260801T120000Z',
      '20260701T120000Z'
    ]);
    assert.deepStrictEqual(
      (await listarBackupsGerenciados(raizRetencao)).map(item => item.nome),
      ['20260920T120000Z', '20260919T120000Z', '20260901T120000Z']
    );
    await fsp.access(path.join(raizRetencao, '20260601T120000Z'));
    await fsp.access(path.join(raizRetencao, 'backup-manual-preservado'));

    const raizExecucao = path.join(temporario, 'execucao');
    await fsp.mkdir(raizExecucao);
    const trava = path.join(raizExecucao, '.backup-em-andamento');
    await fsp.mkdir(trava);
    const agora = new Date('2026-09-21T12:00:00Z');
    await fsp.utimes(trava, agora, agora);
    const concorrente = await executarBackupAgendado({
      raiz: raizExecucao,
      agora,
      criar: async () => assert.fail('Backup concorrente não deve iniciar')
    });
    assert.deepStrictEqual(concorrente, {
      executado: false,
      motivo: 'BACKUP_EM_ANDAMENTO'
    });

    const obsoleta = new Date('2026-09-20T20:00:00Z');
    await fsp.utimes(trava, obsoleta, obsoleta);
    let verificacoes = 0;
    const recuperado = await executarBackupAgendado({
      raiz: raizExecucao,
      agora,
      limiteTravaHoras: 12,
      minimoRetido: 2,
      diasRetencao: 30,
      criar: async ({ raiz }) => ({
        diretorio: await criarPacoteFicticio(raiz, '20260921T120000Z')
      }),
      verificar: async diretorio => {
        verificacoes += 1;
        await fsp.access(path.join(diretorio, 'manifesto.json'));
      }
    });
    assert.equal(recuperado.executado, true);
    assert.equal(recuperado.recuperou_trava_obsoleta, true);
    assert.deepStrictEqual(recuperado.copia_externa, {
      configurada: false,
      copiada: false,
      idempotente: false,
      retencao: null
    });
    assert.equal(verificacoes, 1);
    await assert.rejects(fsp.access(trava), erro => erro.code === 'ENOENT');

    await assert.rejects(
      executarBackupAgendado({
        raiz: raizExecucao,
        agora: new Date('2026-09-22T12:00:00Z'),
        criar: async () => {
          throw new Error('falha simulada');
        }
      }),
      /falha simulada/
    );
    await assert.rejects(fsp.access(trava), erro => erro.code === 'ENOENT');
    console.log('OK: agenda de backup aplica trava e retenção sem tocar produção');
  } finally {
    await fsp.rm(temporario, { recursive: true, force: true });
  }
}

executar().catch(erro => {
  console.error(`FALHA: backup agendado: ${erro.message}`);
  process.exitCode = 1;
});
