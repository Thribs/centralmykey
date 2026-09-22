'use strict';

const { listarBackupsGerenciados } = require('./agendar-backup');
const { verificarBackup } = require('./backup-centralmykey');

let cacheIntegridade = null;

function inteiro(valor, padrao, minimo = 1, maximo = 8760) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= minimo && numero <= maximo
    ? numero
    : padrao;
}

async function obterEstadoBackup(opcoes = {}) {
  const raiz = opcoes.raiz || process.env.BACKUP_RAIZ || '/opt/centralmykey-backups';
  const agora = opcoes.agora || new Date();
  const limiteHoras = inteiro(
    opcoes.limiteHoras ?? process.env.MONITORAMENTO_BACKUP_ATRASO_HORAS,
    30
  );
  const intervaloVerificacaoMinutos = inteiro(
    opcoes.intervaloVerificacaoMinutos ??
      process.env.MONITORAMENTO_BACKUP_VERIFICACAO_MINUTOS,
    60,
    1,
    1440
  );
  const listar = opcoes.listar || listarBackupsGerenciados;
  const verificar = opcoes.verificar || verificarBackup;
  let backups;
  try {
    backups = await listar(raiz);
  } catch {
    return {
      status: 'INVALIDO', integridade: false, ultimo_backup_em: null,
      idade_horas: null, limite_horas: limiteHoras
    };
  }
  if (!backups.length) {
    return {
      status: 'AUSENTE', integridade: false, ultimo_backup_em: null,
      idade_horas: null, limite_horas: limiteHoras
    };
  }

  const ultimo = backups[0];
  const idadeMs = Math.max(0, agora.getTime() - ultimo.criadoEm.getTime());
  const idadeHoras = Math.floor(idadeMs / 3600000);
  const cacheValido = !opcoes.semCache &&
    cacheIntegridade?.diretorio === ultimo.diretorio &&
    cacheIntegridade?.ate > agora.getTime();
  let integridade;
  if (cacheValido) {
    integridade = cacheIntegridade.integridade;
  } else {
    try {
      await verificar(ultimo.diretorio);
      integridade = true;
    } catch {
      integridade = false;
    }
    if (!opcoes.semCache) {
      cacheIntegridade = {
        diretorio: ultimo.diretorio,
        integridade,
        ate: agora.getTime() + intervaloVerificacaoMinutos * 60000
      };
    }
  }

  return {
    status: !integridade ? 'INVALIDO' : idadeHoras >= limiteHoras ? 'ATRASADO' : 'OK',
    integridade,
    ultimo_backup_em: ultimo.criadoEm.toISOString(),
    idade_horas: idadeHoras,
    limite_horas: limiteHoras
  };
}

module.exports = { obterEstadoBackup };
