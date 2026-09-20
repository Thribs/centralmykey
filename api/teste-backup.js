'use strict';

const assert = require('assert');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { gzipSync, gunzipSync } = require('zlib');
const {
  criarBackup,
  verificarBackup,
  restaurarBackup
} = require('./backup-centralmykey');

async function executar() {
  const raiz = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmk-backup-teste-'));
  try {
    const api = path.join(raiz, 'api-publicada');
    const web = path.join(raiz, 'web-publicado');
    const backups = path.join(raiz, 'backups');
    await fsp.mkdir(path.join(api, 'sub'), { recursive: true });
    await fsp.mkdir(path.join(web, 'assets'), { recursive: true });
    await fsp.writeFile(path.join(api, 'server.js'), 'SERVIDOR TESTE\n');
    await fsp.writeFile(path.join(api, '.env'), 'SEGREDO_FICTICIO=teste\n');
    await fsp.writeFile(path.join(api, 'sub', 'arquivo.txt'), 'API SUB\n');
    await fsp.writeFile(path.join(web, 'index.html'), '<h1>WEB TESTE</h1>\n');
    await fsp.writeFile(path.join(web, 'assets', 'app.js'), 'WEB ASSET\n');

    const resultado = await criarBackup({
      raiz: backups,
      apiDir: api,
      webDir: web,
      envPath: path.join(api, '.env'),
      instante: new Date('2026-09-20T12:00:00.000Z'),
      dumpBanco: async destino => {
        await fsp.writeFile(destino, gzipSync('CREATE TABLE teste (id INT);\n'));
      }
    });
    const manifesto = await verificarBackup(resultado.diretorio);
    assert.strictEqual(manifesto.arquivos.length, 3);
    assert.ok(manifesto.arquivos.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));

    const apiRestaurada = path.join(raiz, 'api-restaurada');
    const webRestaurada = path.join(raiz, 'web-restaurado');
    let bancoRestaurado = false;
    await restaurarBackup(resultado.diretorio, {
      apiDestino: apiRestaurada,
      webDestino: webRestaurada,
      envPath: path.join(apiRestaurada, '.env'),
      restaurarBanco: async arquivo => {
        const sql = gunzipSync(await fsp.readFile(arquivo)).toString();
        assert.match(sql, /CREATE TABLE teste/);
        bancoRestaurado = true;
      }
    });
    assert.strictEqual(bancoRestaurado, true);
    assert.strictEqual(
      await fsp.readFile(path.join(apiRestaurada, 'server.js'), 'utf8'),
      'SERVIDOR TESTE\n'
    );
    assert.strictEqual(
      await fsp.readFile(path.join(apiRestaurada, '.env'), 'utf8'),
      'SEGREDO_FICTICIO=teste\n'
    );
    assert.strictEqual(
      await fsp.readFile(path.join(webRestaurada, 'assets', 'app.js'), 'utf8'),
      'WEB ASSET\n'
    );

    const arquivoCorrompido = path.join(resultado.diretorio, 'web.tar.gz');
    await fsp.appendFile(arquivoCorrompido, 'CORROMPIDO');
    await assert.rejects(
      verificarBackup(resultado.diretorio),
      /Integridade inválida: web\.tar\.gz/
    );

    await assert.rejects(
      criarBackup({
        raiz: backups,
        apiDir: api,
        webDir: web,
        envPath: path.join(api, '.env'),
        instante: new Date('2026-09-20T12:00:01.000Z'),
        dumpBanco: async () => {
          throw new Error('dump fictício interrompido');
        }
      }),
      /dump fictício interrompido/
    );
    const entradas = await fsp.readdir(backups);
    assert.strictEqual(
      entradas.some(nome => nome.includes('20260920T120001Z')),
      false,
      'Backup incompleto não pode permanecer no destino'
    );

    console.log('OK: backup, hashes, restauração e detecção de corrupção funcionam');
  } finally {
    await fsp.rm(raiz, { recursive: true, force: true });
  }
}

executar().catch(erro => {
  console.error(`FALHA: teste de backup: ${erro.message}`);
  process.exitCode = 1;
});
