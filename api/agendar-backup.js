'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { criarBackup, verificarBackup } = require('./backup-centralmykey');

const PADRAO_BACKUP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

function inteiroConfigurado(valor, padrao, minimo, maximo) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= minimo && numero <= maximo
    ? numero
    : padrao;
}

function dataDoIdentificador(nome) {
  const partes = PADRAO_BACKUP.exec(nome);
  if (!partes) return null;
  const data = new Date(Date.UTC(
    Number(partes[1]),
    Number(partes[2]) - 1,
    Number(partes[3]),
    Number(partes[4]),
    Number(partes[5]),
    Number(partes[6])
  ));
  if (
    Number.isNaN(data.getTime()) ||
    data.getUTCFullYear() !== Number(partes[1]) ||
    data.getUTCMonth() !== Number(partes[2]) - 1 ||
    data.getUTCDate() !== Number(partes[3]) ||
    data.getUTCHours() !== Number(partes[4]) ||
    data.getUTCMinutes() !== Number(partes[5]) ||
    data.getUTCSeconds() !== Number(partes[6])
  ) return null;
  return data;
}

async function listarBackupsGerenciados(raiz) {
  let entradas = [];
  try {
    entradas = await fsp.readdir(raiz, { withFileTypes: true });
  } catch (erro) {
    if (erro.code === 'ENOENT') return [];
    throw erro;
  }
  const backups = [];
  for (const entrada of entradas) {
    if (!entrada.isDirectory() || entrada.isSymbolicLink()) continue;
    const criadoEm = dataDoIdentificador(entrada.name);
    if (!criadoEm) continue;
    try {
      await fsp.access(path.join(raiz, entrada.name, 'manifesto.json'));
      backups.push({
        nome: entrada.name,
        diretorio: path.join(raiz, entrada.name),
        criadoEm
      });
    } catch {
      // Diretórios incompletos ficam preservados para diagnóstico manual.
    }
  }
  return backups.sort((a, b) => b.criadoEm - a.criadoEm);
}

async function aplicarRetencao({ raiz, agora = new Date(), dias = 30, minimo = 7 }) {
  const diasValidos = inteiroConfigurado(dias, 30, 1, 3650);
  const minimoValido = inteiroConfigurado(minimo, 7, 1, 1000);
  const limite = agora.getTime() - diasValidos * 24 * 60 * 60 * 1000;
  const backups = await listarBackupsGerenciados(raiz);
  const removidos = [];

  for (const [indice, backup] of backups.entries()) {
    if (indice < minimoValido || backup.criadoEm.getTime() >= limite) continue;
    await fsp.rm(backup.diretorio, { recursive: true, force: false });
    removidos.push(backup.nome);
  }
  return { encontrados: backups.length, removidos };
}

async function adquirirTrava(raiz, agora, limiteHoras) {
  const diretorio = path.join(raiz, '.backup-em-andamento');
  const criar = async () => {
    await fsp.mkdir(diretorio, { mode: 0o700 });
    await fsp.writeFile(path.join(diretorio, 'dono.json'), `${JSON.stringify({
      pid: process.pid,
      iniciado_em: agora.toISOString()
    })}\n`, { mode: 0o600 });
  };

  try {
    await criar();
    return { adquirida: true, diretorio };
  } catch (erro) {
    if (erro.code !== 'EEXIST') throw erro;
  }

  let stat;
  try {
    stat = await fsp.stat(diretorio);
  } catch (erro) {
    if (erro.code === 'ENOENT') return adquirirTrava(raiz, agora, limiteHoras);
    throw erro;
  }
  const limiteMs = inteiroConfigurado(limiteHoras, 12, 1, 168) * 60 * 60 * 1000;
  if (agora.getTime() - stat.mtimeMs <= limiteMs) {
    return { adquirida: false, diretorio };
  }

  const obsoleta = `${diretorio}.obsoleta-${process.pid}-${Date.now()}`;
  try {
    await fsp.rename(diretorio, obsoleta);
  } catch (erro) {
    if (erro.code === 'ENOENT') return adquirirTrava(raiz, agora, limiteHoras);
    throw erro;
  }
  await fsp.rm(obsoleta, { recursive: true, force: true });
  try {
    await criar();
    return { adquirida: true, diretorio, recuperouObsoleta: true };
  } catch (erro) {
    if (erro.code === 'EEXIST') return { adquirida: false, diretorio };
    throw erro;
  }
}

async function executarBackupAgendado(opcoes = {}) {
  const raiz = opcoes.raiz || '/opt/centralmykey-backups';
  const agora = opcoes.agora || new Date();
  await fsp.mkdir(raiz, { recursive: true, mode: 0o700 });
  const trava = await adquirirTrava(
    raiz,
    agora,
    opcoes.limiteTravaHoras ?? process.env.BACKUP_LOCK_LIMITE_HORAS
  );
  if (!trava.adquirida) {
    return { executado: false, motivo: 'BACKUP_EM_ANDAMENTO' };
  }

  try {
    const criar = opcoes.criar || criarBackup;
    const verificar = opcoes.verificar || verificarBackup;
    const resultado = await criar({ ...opcoes.backup, raiz, instante: agora });
    await verificar(resultado.diretorio);
    const retencao = await aplicarRetencao({
      raiz,
      agora,
      dias: opcoes.diasRetencao ?? process.env.BACKUP_RETENCAO_DIAS,
      minimo: opcoes.minimoRetido ?? process.env.BACKUP_RETENCAO_MINIMO
    });
    return {
      executado: true,
      diretorio: resultado.diretorio,
      retencao,
      recuperou_trava_obsoleta: Boolean(trava.recuperouObsoleta)
    };
  } finally {
    await fsp.rm(trava.diretorio, { recursive: true, force: true });
  }
}

module.exports = {
  dataDoIdentificador,
  listarBackupsGerenciados,
  aplicarRetencao,
  executarBackupAgendado
};
