'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { copiarBackupExterno } = require('./backup-offsite');
const { verificarBackup } = require('./backup-centralmykey');

async function sha256(arquivo) {
  return crypto.createHash('sha256').update(await fsp.readFile(arquivo)).digest('hex');
}

async function criarPacote(raiz) {
  const diretorio = path.join(raiz, '20260922T040000Z');
  await fsp.mkdir(diretorio, { recursive: true });
  const nomes = ['api.tar.gz', 'web.tar.gz', 'database.sql.gz'];
  const arquivos = [];
  for (const nome of nomes) {
    const arquivo = path.join(diretorio, nome);
    await fsp.writeFile(arquivo, `CONTEUDO FICTICIO ${nome}\n`, { mode: 0o600 });
    arquivos.push({
      nome,
      tamanho: (await fsp.stat(arquivo)).size,
      sha256: await sha256(arquivo)
    });
  }
  await fsp.writeFile(path.join(diretorio, 'manifesto.json'), `${JSON.stringify({
    versao: 1,
    criado_em: '2026-09-22T04:00:00.000Z',
    api_diretorio: 'api',
    web_diretorio: 'web',
    arquivos
  })}\n`, { mode: 0o600 });
  return diretorio;
}

async function executar() {
  const temporario = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmk-offsite-'));
  try {
    const origemRaiz = path.join(temporario, 'local');
    const destino = path.join(temporario, 'volume-externo');
    const origem = await criarPacote(origemRaiz);
    const dispositivosSeparados = async item =>
      path.resolve(item).startsWith(path.resolve(destino)) ? 202 : 101;

    const copiado = await copiarBackupExterno(origem, {
      destinoRaiz: destino,
      obterDispositivo: dispositivosSeparados
    });
    assert.strictEqual(copiado.configurado, true);
    assert.strictEqual(copiado.copiado, true);
    assert.ok(!JSON.stringify(copiado).includes('CONTEUDO FICTICIO'));
    await verificarBackup(path.join(destino, path.basename(origem)));

    const repetido = await copiarBackupExterno(origem, {
      destinoRaiz: destino,
      obterDispositivo: dispositivosSeparados
    });
    assert.strictEqual(repetido.idempotente, true);
    assert.strictEqual(repetido.copiado, false);

    await assert.rejects(
      copiarBackupExterno(origem, {
        destinoRaiz: path.join(temporario, 'mesmo-dispositivo'),
        obterDispositivo: async () => 101
      }),
      erro => erro.codigo === 'BACKUP_EXTERNO_MESMO_DISPOSITIVO'
    );
    await assert.rejects(
      copiarBackupExterno(origem, { destinoRaiz: path.join(origem, 'filho') }),
      erro => erro.codigo === 'BACKUP_EXTERNO_DESTINO_INVALIDO'
    );

    await fsp.appendFile(
      path.join(destino, path.basename(origem), 'api.tar.gz'),
      'CORROMPIDO'
    );
    await assert.rejects(
      copiarBackupExterno(origem, {
        destinoRaiz: destino,
        obterDispositivo: dispositivosSeparados
      }),
      /Integridade inválida/
    );

    console.log('OK: cópia externa é atômica, idempotente, verificada e exige outro dispositivo');
  } finally {
    await fsp.rm(temporario, { recursive: true, force: true });
  }
}

executar().catch(erro => {
  console.error(`FALHA: backup externo: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
