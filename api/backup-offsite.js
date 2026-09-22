'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { verificarBackup } = require('./backup-centralmykey');

function falha(mensagem, codigo) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  return erro;
}

async function copiarBackupExterno(diretorioLocal, opcoes = {}) {
  const destinoRaiz = String(opcoes.destinoRaiz || '').trim();
  if (!destinoRaiz) return { configurado: false, copiado: false };
  if (!path.isAbsolute(destinoRaiz)) {
    throw falha('Destino externo deve ser absoluto', 'BACKUP_EXTERNO_DESTINO_INVALIDO');
  }
  const origem = path.resolve(diretorioLocal);
  const destino = path.resolve(destinoRaiz);
  if (origem === destino || origem.startsWith(`${destino}${path.sep}`) ||
      destino.startsWith(`${origem}${path.sep}`)) {
    throw falha('Destino externo conflita com a origem', 'BACKUP_EXTERNO_DESTINO_INVALIDO');
  }

  await fsp.mkdir(destino, { recursive: true, mode: 0o700 });
  const obterDispositivo = opcoes.obterDispositivo || (async item => (await fsp.stat(item)).dev);
  const [dispositivoOrigem, dispositivoDestino] = await Promise.all([
    obterDispositivo(origem), obterDispositivo(destino)
  ]);
  if (String(dispositivoOrigem) === String(dispositivoDestino)) {
    throw falha(
      'Destino externo está no mesmo dispositivo do backup local',
      'BACKUP_EXTERNO_MESMO_DISPOSITIVO'
    );
  }

  const verificar = opcoes.verificar || verificarBackup;
  const nome = path.basename(origem);
  const final = path.join(destino, nome);
  try {
    await fsp.access(final);
    await verificar(final);
    return { configurado: true, copiado: false, idempotente: true, diretorio: final };
  } catch (erro) {
    if (erro.code !== 'ENOENT') throw erro;
  }

  const temporario = path.join(destino, `.${nome}.tmp-${process.pid}-${Date.now()}`);
  try {
    await fsp.cp(origem, temporario, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true
    });
    await verificar(temporario);
    await fsp.rename(temporario, final);
    return { configurado: true, copiado: true, idempotente: false, diretorio: final };
  } catch (erro) {
    await fsp.rm(temporario, { recursive: true, force: true });
    throw erro;
  }
}

module.exports = { copiarBackupExterno };
