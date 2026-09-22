'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { createGzip, createGunzip } = require('zlib');
const { pipeline } = require('stream/promises');
const dotenv = require('dotenv');

function executar(comando, argumentos, opcoes = {}) {
  return new Promise((resolve, reject) => {
    const processo = spawn(comando, argumentos, {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...opcoes
    });
    let erro = '';
    processo.stderr?.on('data', trecho => {
      if (erro.length < 4000) erro += trecho.toString();
    });
    processo.once('error', reject);
    processo.once('close', codigo => {
      if (codigo === 0) return resolve();
      reject(new Error(`${comando} encerrou com código ${codigo}: ${erro.trim()}`));
    });
  });
}

async function sha256(arquivo) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const entrada = fs.createReadStream(arquivo);
    entrada.on('data', trecho => hash.update(trecho));
    entrada.once('error', reject);
    entrada.once('end', resolve);
  });
  return hash.digest('hex');
}

function escaparOpcaoMysql(valor) {
  const texto = String(valor ?? '');
  if (/\r|\n/.test(texto)) throw new Error('Configuração MySQL contém quebra de linha');
  return texto.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function comCredencialMysql(envPath, callback) {
  const configuracao = dotenv.parse(await fsp.readFile(envPath));
  for (const chave of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    if (!configuracao[chave]) throw new Error(`Configuração ausente: ${chave}`);
  }
  const temporario = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmk-mysql-'));
  const arquivo = path.join(temporario, 'client.cnf');
  const transporte = configuracao.DB_SOCKET
    ? [
        'protocol=socket',
        `socket="${escaparOpcaoMysql(configuracao.DB_SOCKET)}"`
      ]
    : [
        `host="${escaparOpcaoMysql(configuracao.DB_HOST)}"`,
        `port=${Number(configuracao.DB_PORT || 3306)}`
      ];
  const conteudo = [
    '[client]',
    ...transporte,
    `user="${escaparOpcaoMysql(configuracao.DB_USER)}"`,
    `password="${escaparOpcaoMysql(configuracao.DB_PASSWORD)}"`,
    ''
  ].join('\n');
  await fsp.writeFile(arquivo, conteudo, { mode: 0o600 });
  try {
    return await callback({ arquivo, database: configuracao.DB_NAME });
  } finally {
    await fsp.rm(temporario, { recursive: true, force: true });
  }
}

async function dumpMysql(destino, envPath) {
  return comCredencialMysql(envPath, async ({ arquivo, database }) => {
    const dump = spawn('mysqldump', [
      `--defaults-extra-file=${arquivo}`,
      '--single-transaction',
      '--routines',
      '--triggers',
      '--events',
      '--hex-blob',
      database
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const gzip = createGzip({ level: 9 });
    const saida = fs.createWriteStream(destino, { mode: 0o600 });
    let erro = '';
    dump.stderr.on('data', trecho => {
      if (erro.length < 4000) erro += trecho.toString();
    });
    const conclusao = new Promise((resolve, reject) => {
      dump.once('error', reject);
      dump.once('close', codigo => {
        if (codigo === 0) resolve();
        else reject(new Error(`mysqldump falhou: ${erro.trim()}`));
      });
    });
    await Promise.all([pipeline(dump.stdout, gzip, saida), conclusao]);
  });
}

async function restaurarMysql(arquivoDump, envPath) {
  return comCredencialMysql(envPath, async ({ arquivo, database }) => {
    const mysql = spawn('mysql', [
      `--defaults-extra-file=${arquivo}`,
      database
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let erro = '';
    mysql.stderr.on('data', trecho => {
      if (erro.length < 4000) erro += trecho.toString();
    });
    const conclusao = new Promise((resolve, reject) => {
      mysql.once('error', reject);
      mysql.once('close', codigo => {
        if (codigo === 0) resolve();
        else reject(new Error(`mysql falhou com código ${codigo}: ${erro.trim()}`));
      });
    });
    await Promise.all([
      pipeline(fs.createReadStream(arquivoDump), createGunzip(), mysql.stdin),
      conclusao
    ]);
  });
}

async function arquivarDiretorio(origem, destino) {
  await executar('tar', ['-czf', destino, '-C', path.dirname(origem), path.basename(origem)]);
  await fsp.chmod(destino, 0o600);
}

async function criarBackup(opcoes = {}) {
  const raiz = opcoes.raiz || '/opt/centralmykey-backups';
  const apiDir = opcoes.apiDir || '/opt/central-mykey-api';
  const webDir = opcoes.webDir || '/opt/central-mykey-web';
  const diretoriosPadrao = !opcoes.apiDir && !opcoes.webDir;
  const webPublicDir = opcoes.webPublicDir === undefined
    ? (diretoriosPadrao ? '/var/www/central-mykey-test' : null)
    : opcoes.webPublicDir;
  const envPath = opcoes.envPath || path.join(apiDir, '.env');
  const instante = opcoes.instante || new Date();
  const identificador = instante.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const final = path.join(raiz, identificador);
  const temporario = `${final}.tmp-${process.pid}`;
  await fsp.mkdir(raiz, { recursive: true, mode: 0o700 });
  await fsp.mkdir(temporario, { mode: 0o700 });
  try {
    const artefatos = [
      { nome: 'api.tar.gz', origem: apiDir },
      { nome: 'web.tar.gz', origem: webDir }
    ];
    if (webPublicDir) {
      artefatos.push({ nome: 'web-public.tar.gz', origem: webPublicDir });
    }
    for (const item of artefatos) {
      await arquivarDiretorio(item.origem, path.join(temporario, item.nome));
    }
    const dump = path.join(temporario, 'database.sql.gz');
    await (opcoes.dumpBanco || dumpMysql)(dump, envPath);
    const arquivos = [];
    const nomesArtefatos = [
      ...artefatos.map(item => item.nome),
      'database.sql.gz'
    ];
    for (const nome of nomesArtefatos) {
      const arquivo = path.join(temporario, nome);
      const stat = await fsp.stat(arquivo);
      arquivos.push({ nome, tamanho: stat.size, sha256: await sha256(arquivo) });
    }
    const manifesto = {
      versao: webPublicDir ? 2 : 1,
      criado_em: instante.toISOString(),
      api_diretorio: path.basename(apiDir),
      web_diretorio: path.basename(webDir),
      ...(webPublicDir
        ? { web_public_diretorio: path.basename(webPublicDir) }
        : {}),
      arquivos
    };
    await fsp.writeFile(
      path.join(temporario, 'manifesto.json'),
      `${JSON.stringify(manifesto, null, 2)}\n`,
      { mode: 0o600 }
    );
    await fsp.rename(temporario, final);
    return { diretorio: final, manifesto };
  } catch (erro) {
    await fsp.rm(temporario, { recursive: true, force: true });
    throw erro;
  }
}

async function verificarBackup(diretorio) {
  const manifesto = JSON.parse(await fsp.readFile(path.join(diretorio, 'manifesto.json'), 'utf8'));
  if (![1, 2].includes(manifesto.versao) || !Array.isArray(manifesto.arquivos)) {
    throw new Error('Manifesto de backup inválido');
  }
  const nomes = manifesto.arquivos.map(item => item.nome).sort();
  const esperados = [
    'api.tar.gz',
    'database.sql.gz',
    'web.tar.gz'
  ];
  if (manifesto.versao === 2) esperados.push('web-public.tar.gz');
  esperados.sort();
  if (JSON.stringify(nomes) !== JSON.stringify(esperados) ||
      (manifesto.versao === 2 && !manifesto.web_public_diretorio)) {
    throw new Error('Lista de artefatos do backup inválida');
  }
  for (const item of manifesto.arquivos) {
    const arquivo = path.join(diretorio, item.nome);
    const stat = await fsp.stat(arquivo);
    if (stat.size !== item.tamanho || await sha256(arquivo) !== item.sha256) {
      throw new Error(`Integridade inválida: ${item.nome}`);
    }
  }
  return manifesto;
}

async function extrairArquivo(arquivo, nomeRaiz, destino) {
  if (path.basename(nomeRaiz) !== nomeRaiz) {
    throw new Error('Nome de diretório inválido no manifesto');
  }
  const temporario = await fsp.mkdtemp(path.join(path.dirname(destino), '.cmk-restore-'));
  try {
    await executar('tar', ['-xzf', arquivo, '-C', temporario]);
    const extraido = path.join(temporario, nomeRaiz);
    if (!(await fsp.stat(extraido)).isDirectory()) {
      throw new Error(`Conteúdo ausente no arquivo ${path.basename(arquivo)}`);
    }
    return { temporario, extraido };
  } catch (erro) {
    await fsp.rm(temporario, { recursive: true, force: true });
    throw erro;
  }
}

async function trocarDiretorio(preparado, destino, sufixo) {
  const anterior = `${destino}.antes-restauracao-${sufixo}`;
  let existia = true;
  try {
    await fsp.access(destino);
  } catch {
    existia = false;
  }
  if (existia) await fsp.rename(destino, anterior);
  try {
    await fsp.rename(preparado.extraido, destino);
    return existia ? anterior : null;
  } catch (erro) {
    if (existia) await fsp.rename(anterior, destino);
    throw erro;
  } finally {
    await fsp.rm(preparado.temporario, { recursive: true, force: true });
  }
}

async function restaurarBackup(diretorio, opcoes = {}) {
  const manifesto = await verificarBackup(diretorio);
  if (!opcoes.apiDestino || !opcoes.webDestino) {
    throw new Error('Destinos da API e do frontend são obrigatórios');
  }
  if (manifesto.versao === 2 && !opcoes.webPublicDestino) {
    throw new Error('Destino do frontend público é obrigatório');
  }
  const apiPreparada = await extrairArquivo(
    path.join(diretorio, 'api.tar.gz'),
    manifesto.api_diretorio,
    opcoes.apiDestino
  );
  let webPreparada;
  let webPublicPreparada;
  try {
    webPreparada = await extrairArquivo(
      path.join(diretorio, 'web.tar.gz'),
      manifesto.web_diretorio,
      opcoes.webDestino
    );
    if (manifesto.versao === 2) {
      webPublicPreparada = await extrairArquivo(
        path.join(diretorio, 'web-public.tar.gz'),
        manifesto.web_public_diretorio,
        opcoes.webPublicDestino
      );
    }
    await (opcoes.restaurarBanco || restaurarMysql)(
      path.join(diretorio, 'database.sql.gz'),
      opcoes.envPath || path.join(opcoes.apiDestino, '.env')
    );
    const sufixo = Date.now();
    const trocas = [];
    try {
      trocas.push({
        destino: opcoes.apiDestino,
        anterior: await trocarDiretorio(apiPreparada, opcoes.apiDestino, sufixo)
      });
      trocas.push({
        destino: opcoes.webDestino,
        anterior: await trocarDiretorio(webPreparada, opcoes.webDestino, sufixo)
      });
      if (webPublicPreparada) {
        trocas.push({
          destino: opcoes.webPublicDestino,
          anterior: await trocarDiretorio(
            webPublicPreparada,
            opcoes.webPublicDestino,
            sufixo
          )
        });
      }
    } catch (erro) {
      for (const troca of [...trocas].reverse()) {
        await fsp.rm(troca.destino, { recursive: true, force: true });
        if (troca.anterior) await fsp.rename(troca.anterior, troca.destino);
      }
      throw erro;
    }
    for (const troca of trocas) {
      if (troca.anterior) {
        await fsp.rm(troca.anterior, { recursive: true, force: true });
      }
    }
    return manifesto;
  } finally {
    await fsp.rm(apiPreparada.temporario, { recursive: true, force: true });
    if (webPreparada) {
      await fsp.rm(webPreparada.temporario, { recursive: true, force: true });
    }
    if (webPublicPreparada) {
      await fsp.rm(webPublicPreparada.temporario, { recursive: true, force: true });
    }
  }
}

module.exports = {
  criarBackup,
  verificarBackup,
  restaurarBackup,
  dumpMysql,
  restaurarMysql
};
