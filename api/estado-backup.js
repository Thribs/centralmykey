'use strict';

const { listarBackupsGerenciados } = require('./agendar-backup');
const { verificarBackup } = require('./backup-centralmykey');

const cachesIntegridade = new Map();

function inteiro(valor, padrao, minimo = 1, maximo = 8760) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= minimo && numero <= maximo
    ? numero
    : padrao;
}

async function obterEstadoRaiz({
  raiz, agora, limiteHoras, intervaloVerificacaoMinutos,
  listar, verificar, semCache
}) {
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
  const cacheIntegridade = cachesIntegridade.get(raiz);
  const cacheValido = !semCache && cacheIntegridade?.diretorio === ultimo.diretorio &&
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
    if (!semCache) {
      cachesIntegridade.set(raiz, {
        diretorio: ultimo.diretorio,
        integridade,
        ate: agora.getTime() + intervaloVerificacaoMinutos * 60000
      });
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

async function obterEstadoBackup(opcoes = {}) {
  const raiz = opcoes.raiz || process.env.BACKUP_RAIZ || '/opt/centralmykey-backups';
  const destinoExterno = opcoes.destinoExterno === undefined
    ? String(process.env.BACKUP_OFFSITE_DIR || '').trim()
    : String(opcoes.destinoExterno || '').trim();
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
  const comuns = {
    agora,
    limiteHoras,
    intervaloVerificacaoMinutos,
    listar: opcoes.listar || listarBackupsGerenciados,
    verificar: opcoes.verificar || verificarBackup,
    semCache: opcoes.semCache
  };
  const local = await obterEstadoRaiz({ ...comuns, raiz });
  const externo = destinoExterno
    ? { configurado: true, ...await obterEstadoRaiz({ ...comuns, raiz: destinoExterno }) }
    : {
        configurado: false,
        status: 'NAO_CONFIGURADO',
        integridade: false,
        ultimo_backup_em: null,
        idade_horas: null,
        limite_horas: limiteHoras
      };
  return { ...local, externo };
}

module.exports = { obterEstadoBackup };
