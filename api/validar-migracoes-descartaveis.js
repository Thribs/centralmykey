'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const dotenv = require('dotenv');

const MIGRACOES = [
  '20260918_comunicacoes_outbox.sql',
  '20260919_estornos_pagamentos.sql',
  '20260919_fechamentos_fornecedores.sql',
  '20260919_notificacoes_internas.sql',
  '20260920_eventos_integracoes.sql',
  '20260920_partes_pedido.sql',
  '20260921_mapeamentos_produtos_externos.sql',
  '20260921_referencias_pagamento.sql',
  '20260921_identidade_cache_joelpires.sql',
  '20260922_autoridades_integracoes.sql'
];

const TABELAS_ESPERADAS = [
  'comunicacoes_outbox',
  'estornos_pagamentos',
  'fechamentos_fornecedores',
  'fechamento_fornecedor_itens',
  'notificacoes',
  'notificacao_leituras',
  'integracao_eventos',
  'pedido_partes',
  'integracao_produto_mapeamentos',
  'integracao_referencias_pagamento',
  'integracao_autoridades'
];

function executar(comando, argumentos, opcoes = {}) {
  return new Promise((resolve, reject) => {
    const processo = spawn(comando, argumentos, {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...opcoes
    });
    let erro = '';
    processo.stderr?.on('data', trecho => {
      if (erro.length < 6000) erro += trecho.toString();
    });
    processo.once('error', reject);
    processo.once('close', codigo => {
      if (codigo === 0) return resolve();
      reject(new Error(`${path.basename(comando)} encerrou com código ${codigo}: ${erro.trim()}`));
    });
  });
}

function escaparOpcaoMysql(valor) {
  const texto = String(valor ?? '');
  if (/\r|\n/.test(texto)) throw new Error('Configuração MySQL contém quebra de linha');
  return texto.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function aguardarArquivo(arquivo, tentativas = 100) {
  for (let tentativa = 0; tentativa < tentativas; tentativa += 1) {
    try {
      await fsp.access(arquivo);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('MySQL descartável não iniciou no prazo');
}

async function importarEsquema(configuracao, credencial, socket, banco) {
  const dump = spawn('mysqldump', [
    `--defaults-extra-file=${credencial}`,
    '--no-data',
    '--skip-triggers',
    '--set-gtid-purged=OFF',
    '--no-tablespaces',
    configuracao.DB_NAME
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const mysql = spawn('mysql', [
    '--protocol=socket', `--socket=${socket}`, '-uroot', banco
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let erroDump = '';
  let erroMysql = '';
  dump.stderr.on('data', trecho => { if (erroDump.length < 6000) erroDump += trecho; });
  mysql.stderr.on('data', trecho => { if (erroMysql.length < 6000) erroMysql += trecho; });
  const fimDump = new Promise((resolve, reject) => dump.once('close', codigo =>
    codigo === 0 ? resolve() : reject(new Error(`mysqldump estrutural falhou: ${erroDump.trim()}`))));
  const fimMysql = new Promise((resolve, reject) => mysql.once('close', codigo =>
    codigo === 0 ? resolve() : reject(new Error(`importação estrutural falhou: ${erroMysql.trim()}`))));
  await Promise.all([pipeline(dump.stdout, mysql.stdin), fimDump, fimMysql]);
}

async function aplicarSql(arquivo, socket, banco) {
  const mysql = spawn('mysql', [
    '--protocol=socket', `--socket=${socket}`, '-uroot', banco
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let erro = '';
  mysql.stderr.on('data', trecho => { if (erro.length < 6000) erro += trecho; });
  const fim = new Promise((resolve, reject) => mysql.once('close', codigo =>
    codigo === 0
      ? resolve()
      : reject(new Error(`${path.basename(arquivo)} falhou: ${erro.trim()}`))));
  await Promise.all([pipeline(fs.createReadStream(arquivo), mysql.stdin), fim]);
}

async function executarConsulta(socket, banco, sql) {
  return new Promise((resolve, reject) => {
    const processo = spawn('mysql', [
      '--protocol=socket', `--socket=${socket}`, '-uroot',
      '--batch', '--skip-column-names', banco, '-e', sql
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    let erro = '';
    processo.stdout.on('data', trecho => { if (saida.length < 12000) saida += trecho; });
    processo.stderr.on('data', trecho => { if (erro.length < 6000) erro += trecho; });
    processo.once('error', reject);
    processo.once('close', codigo => codigo === 0
      ? resolve(saida.trim())
      : reject(new Error(`consulta descartável falhou: ${erro.trim()}`)));
  });
}

async function consultarTabelas(socket, banco) {
  const temporario = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmk-lista-tabelas-'));
  const saida = path.join(temporario, 'tabelas.txt');
  try {
    const descritor = await fsp.open(saida, 'w', 0o600);
    await new Promise((resolve, reject) => {
      const processo = spawn('mysql', [
        '--protocol=socket', `--socket=${socket}`, '-uroot',
        '--batch', '--skip-column-names', banco,
        '-e', 'SHOW TABLES'
      ], { stdio: ['ignore', descritor.fd, 'pipe'] });
      let erro = '';
      processo.stderr.on('data', trecho => { if (erro.length < 6000) erro += trecho; });
      processo.once('error', reject);
      processo.once('close', codigo => codigo === 0
        ? resolve()
        : reject(new Error(`consulta estrutural falhou: ${erro.trim()}`)));
    });
    await descritor.close();
    return new Set((await fsp.readFile(saida, 'utf8')).split(/\r?\n/).filter(Boolean));
  } finally {
    await fsp.rm(temporario, { recursive: true, force: true });
  }
}

async function executarValidacao() {
  const envPath = process.env.CENTRALMYKEY_ENV_PATH || '/opt/central-mykey-api/.env';
  const configuracao = dotenv.parse(await fsp.readFile(envPath));
  for (const chave of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    if (!configuracao[chave]) throw new Error(`Configuração ausente: ${chave}`);
  }
  const raiz = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmk-migracoes-'));
  const instancia = path.join(raiz, 'instancia');
  const dados = path.join(instancia, 'data');
  const socket = path.join(instancia, 'mysql.sock');
  const pid = path.join(instancia, 'mysql.pid');
  const log = path.join(instancia, 'mysql.log');
  const credencial = path.join(raiz, 'origem.cnf');
  const banco = 'centralmykey_migracoes_descartavel';
  let iniciado = false;
  try {
    await fsp.chmod(raiz, 0o711);
    await fsp.mkdir(instancia, { mode: 0o700 });
    const usuarioMysql = (await fsp.readFile('/etc/passwd', 'utf8'))
      .split(/\r?\n/)
      .find(linha => linha.startsWith('mysql:'));
    if (!usuarioMysql) throw new Error('Usuário local mysql não encontrado');
    const partesUsuario = usuarioMysql.split(':');
    const mysqlUid = Number(partesUsuario[2]);
    const mysqlGid = Number(partesUsuario[3]);
    await fsp.chown(instancia, mysqlUid, mysqlGid);
    await fsp.writeFile(credencial, [
      '[client]',
      `host="${escaparOpcaoMysql(configuracao.DB_HOST)}"`,
      `port=${Number(configuracao.DB_PORT || 3306)}`,
      `user="${escaparOpcaoMysql(configuracao.DB_USER)}"`,
      `password="${escaparOpcaoMysql(configuracao.DB_PASSWORD)}"`,
      ''
    ].join('\n'), { mode: 0o600 });
    await executar('/usr/sbin/mysqld', [
      '--initialize-insecure', `--datadir=${dados}`
    ], { uid: mysqlUid, gid: mysqlGid });
    await executar('/usr/sbin/mysqld', [
      `--datadir=${dados}`, `--socket=${socket}`,
      `--pid-file=${pid}`, `--log-error=${log}`, '--skip-networking', '--daemonize'
    ], { uid: mysqlUid, gid: mysqlGid });
    iniciado = true;
    await aguardarArquivo(socket);
    await executar('mysql', [
      '--protocol=socket', `--socket=${socket}`, '-uroot',
      '-e', `CREATE DATABASE ${banco} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    ]);
    await importarEsquema(configuracao, credencial, socket, banco);
    await executarConsulta(socket, banco, `
      INSERT INTO clientes
        (nome, telefone, telefone_normalizado, email, cadastro_status,
         tipo_cobranca, credito_status, ativo)
      VALUES
        ('CLIENTE SINTETICO MIGRACAO', '5500000000000', '5500000000000',
         'migracao@teste.invalid', 'COMPLETO', 'ANTECIPADO', 'LIBERADO', 1);
      SET @cliente_id = LAST_INSERT_ID();
      INSERT INTO servicos
        (codigo, nome, categoria, marca, preco_base, moeda, exige_chassi, ativo)
      VALUES
        ('MIGRACAO_TESTE', 'Servico sintetico', 'TESTE', 'TESTE', 1.00,
         'BRL', 1, 1);
      SET @servico_id = LAST_INSERT_ID();
      INSERT INTO pedidos_senha
        (protocolo, cliente_id, servico_id, chassi, marca, status,
         valor_venda, custo, moeda)
      VALUES
        ('MIGRACAO-E2E-0001', @cliente_id, @servico_id,
         'CHASSISINTETICO01', 'TESTE', 'ABERTO', 1.00, 0, 'BRL');
    `);
    for (const nome of MIGRACOES) {
      await aplicarSql(path.join(__dirname, 'migrations', nome), socket, banco);
    }
    // A segunda passagem comprova que a publicação pode ser retomada com segurança.
    for (const nome of MIGRACOES) {
      await aplicarSql(path.join(__dirname, 'migrations', nome), socket, banco);
    }
    const tabelas = await consultarTabelas(socket, banco);
    const ausentes = TABELAS_ESPERADAS.filter(nome => !tabelas.has(nome));
    if (ausentes.length) throw new Error(`Tabelas ausentes após migração: ${ausentes.join(', ')}`);
    const partes = await executarConsulta(socket, banco, `
      SELECT COUNT(*), COUNT(DISTINCT papel),
             SUM(nome = 'CLIENTE SINTETICO MIGRACAO'),
             SUM(telefone = '5500000000000')
        FROM pedido_partes pp
        INNER JOIN pedidos_senha p ON p.id = pp.pedido_id
       WHERE p.protocolo = 'MIGRACAO-E2E-0001'
    `);
    if (partes !== '3\t3\t3\t3') {
      throw new Error(`Backfill de partes divergente: ${partes || 'sem resultado'}`);
    }
    const colunasCache = await executarConsulta(socket, banco, `
      SELECT COUNT(*)
        FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'banco_senhas'
         AND column_name IN ('cache_fonte', 'cache_api_senha_id')
         AND extra LIKE '%STORED GENERATED%'
    `);
    if (colunasCache !== '2') {
      throw new Error(`Colunas de identidade do cache divergentes: ${colunasCache || 'ausentes'}`);
    }
    const indiceCache = await executarConsulta(socket, banco, `
      SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ','),
             MIN(non_unique)
        FROM information_schema.statistics
       WHERE table_schema = DATABASE()
         AND table_name = 'banco_senhas'
         AND index_name = 'uk_banco_senhas_cache_api'
    `);
    if (indiceCache !== 'cache_fonte,cache_api_senha_id\t0') {
      throw new Error(`Índice único do cache divergente: ${indiceCache || 'ausente'}`);
    }
    const cacheUnico = await executarConsulta(socket, banco, `
      INSERT INTO banco_senhas
        (tipo, marca, chassi, codigo_mecanico, dados_extras,
         confiabilidade, ativo)
      VALUES
        ('GM_SENHA', 'GM', 'CACHEMIGRACAO0001', 'PRIMEIRO',
         JSON_OBJECT('fonte', 'API_JOELPIRES', 'api_senha_id', 'MIGRACAO-1'),
         'CONFIRMADA', 1)
      ON DUPLICATE KEY UPDATE codigo_mecanico = VALUES(codigo_mecanico);
      INSERT INTO banco_senhas
        (tipo, marca, chassi, codigo_mecanico, dados_extras,
         confiabilidade, ativo)
      VALUES
        ('GM_SENHA', 'GM', 'CACHEMIGRACAO0001', 'RENOVADO',
         JSON_OBJECT('fonte', 'API_JOELPIRES', 'api_senha_id', 'MIGRACAO-1'),
         'CONFIRMADA', 1)
      ON DUPLICATE KEY UPDATE codigo_mecanico = VALUES(codigo_mecanico);
      SELECT COUNT(*), MAX(codigo_mecanico)
        FROM banco_senhas
       WHERE cache_fonte = 'API_JOELPIRES'
         AND cache_api_senha_id = 'MIGRACAO-1'
    `);
    if (cacheUnico !== '1\tRENOVADO') {
      throw new Error(`Unicidade do cache divergente: ${cacheUnico || 'sem resultado'}`);
    }
    console.log(
      `OK: ${MIGRACOES.length} migrações aplicadas duas vezes em MySQL descartável; ` +
      `${TABELAS_ESPERADAS.length} tabelas e backfill sintético verificados`
    );
  } finally {
    if (iniciado) {
      try {
        await executar('mysqladmin', [
          '--protocol=socket', `--socket=${socket}`, '-uroot', 'shutdown'
        ]);
      } catch {
        if (fs.existsSync(pid)) {
          const numero = Number((await fsp.readFile(pid, 'utf8')).trim());
          if (Number.isInteger(numero)) process.kill(numero, 'SIGTERM');
        }
      }
    }
    await fsp.rm(raiz, { recursive: true, force: true });
  }
}

if (require.main === module) {
  executarValidacao().catch(erro => {
    console.error(`FALHA: validação descartável de migrações: ${erro.message}`);
    process.exitCode = 1;
  });
}

module.exports = { executarValidacao, MIGRACOES, TABELAS_ESPERADAS };
