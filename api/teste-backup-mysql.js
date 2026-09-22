'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { dumpMysql, restaurarMysql } = require('./backup-centralmykey');

function executar(comando, argumentos, opcoes = {}) {
  return new Promise((resolve, reject) => {
    const processo = spawn(comando, argumentos, {
      stdio: ['ignore', 'ignore', 'pipe'], ...opcoes
    });
    let erro = '';
    processo.stderr?.on('data', trecho => {
      if (erro.length < 6000) erro += trecho.toString();
    });
    processo.once('error', reject);
    processo.once('close', codigo => codigo === 0
      ? resolve()
      : reject(new Error(`${path.basename(comando)} falhou: ${erro.trim()}`)));
  });
}

async function aguardarArquivo(arquivo) {
  for (let tentativa = 0; tentativa < 100; tentativa += 1) {
    try {
      await fsp.access(arquivo);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('MySQL descartável não iniciou no prazo');
}

async function consulta(socket, banco, sql) {
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

async function executarTeste() {
  const raiz = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmk-backup-mysql-'));
  const instancia = path.join(raiz, 'instancia');
  const dados = path.join(instancia, 'data');
  const socket = path.join(instancia, 'mysql.sock');
  const pid = path.join(instancia, 'mysql.pid');
  const log = path.join(instancia, 'mysql.log');
  const envPath = path.join(raiz, 'teste.env');
  const dump = path.join(raiz, 'database.sql.gz');
  const banco = 'centralmykey_backup_descartavel';
  let iniciado = false;

  try {
    await fsp.chmod(raiz, 0o711);
    await fsp.mkdir(instancia, { mode: 0o700 });
    const usuarioMysql = (await fsp.readFile('/etc/passwd', 'utf8'))
      .split(/\r?\n/)
      .find(linha => linha.startsWith('mysql:'));
    if (!usuarioMysql) throw new Error('Usuário local mysql não encontrado');
    const partes = usuarioMysql.split(':');
    const mysqlUid = Number(partes[2]);
    const mysqlGid = Number(partes[3]);
    await fsp.chown(instancia, mysqlUid, mysqlGid);

    await executar('/usr/sbin/mysqld', [
      '--initialize-insecure', `--datadir=${dados}`
    ], { uid: mysqlUid, gid: mysqlGid });
    await executar('/usr/sbin/mysqld', [
      `--datadir=${dados}`, `--socket=${socket}`,
      `--pid-file=${pid}`, `--log-error=${log}`,
      '--skip-networking', '--daemonize'
    ], { uid: mysqlUid, gid: mysqlGid });
    iniciado = true;
    await aguardarArquivo(socket);

    await consulta(socket, 'mysql', `
      CREATE DATABASE ${banco} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE USER 'backup_teste'@'localhost' IDENTIFIED BY 'senha-ficticia-local';
      GRANT ALL PRIVILEGES ON *.* TO 'backup_teste'@'localhost';
      FLUSH PRIVILEGES;
    `);
    await consulta(socket, banco, `
      CREATE TABLE itens (
        id INT NOT NULL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        conteudo BLOB NOT NULL
      ) ENGINE=InnoDB;
      CREATE TABLE auditoria (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        item_id INT NOT NULL,
        evento VARCHAR(30) NOT NULL
      ) ENGINE=InnoDB;
      CREATE TRIGGER trg_item_inserido AFTER INSERT ON itens
        FOR EACH ROW INSERT INTO auditoria (item_id, evento)
        VALUES (NEW.id, 'INSERIDO');
      CREATE VIEW resumo_itens AS
        SELECT COUNT(*) AS total, MAX(nome) AS ultimo_nome FROM itens;
      CREATE PROCEDURE contar_itens(OUT total INT)
        SELECT COUNT(*) INTO total FROM itens;
      INSERT INTO itens (id, nome, conteudo) VALUES
        (1, 'Chave São Paulo', X'000102FF'),
        (2, 'Senha Paraná', X'10203040'),
        (3, 'Rádio Goiás', X'FFEEDDCC');
    `);

    await fsp.writeFile(envPath, [
      'DB_HOST=localhost',
      `DB_SOCKET=${socket}`,
      'DB_USER=backup_teste',
      'DB_PASSWORD=senha-ficticia-local',
      `DB_NAME=${banco}`,
      ''
    ].join('\n'), { mode: 0o600 });

    await dumpMysql(dump, envPath);
    const statDump = await fsp.stat(dump);
    assert.strictEqual(statDump.mode & 0o777, 0o600);
    assert.ok(statDump.size > 0, 'Dump comprimido deve possuir conteúdo');

    await consulta(socket, banco, `
      DROP VIEW resumo_itens;
      DROP TRIGGER trg_item_inserido;
      DROP PROCEDURE contar_itens;
      DROP TABLE auditoria;
      ALTER TABLE itens ADD COLUMN adulterado INT NOT NULL DEFAULT 1;
      DELETE FROM itens;
    `);
    await restaurarMysql(dump, envPath);

    const estrutura = await consulta(socket, banco, `
      SELECT COUNT(*), SUM(nome LIKE '%á%' OR nome LIKE '%ã%'),
             SUM(HEX(conteudo) IN ('000102FF','10203040','FFEEDDCC'))
        FROM itens;
      SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'itens'
         AND column_name = 'adulterado';
      SELECT COUNT(*) FROM information_schema.views
       WHERE table_schema = DATABASE() AND table_name = 'resumo_itens';
      SELECT COUNT(*) FROM information_schema.routines
       WHERE routine_schema = DATABASE() AND routine_name = 'contar_itens';
      SELECT COUNT(*) FROM information_schema.triggers
       WHERE trigger_schema = DATABASE() AND trigger_name = 'trg_item_inserido';
      INSERT INTO itens (id, nome, conteudo) VALUES (4, 'Teste gatilho', X'AA');
      SELECT COUNT(*) FROM auditoria WHERE item_id = 4 AND evento = 'INSERIDO';
    `);
    assert.deepStrictEqual(
      estrutura.split(/\r?\n/),
      ['3\t3\t3', '0', '1', '1', '1', '1']
    );
    console.log(
      'OK: dump e restauração integral funcionam em MySQL descartável sem acessar produção'
    );
  } finally {
    if (iniciado) {
      try {
        await executar('mysqladmin', [
          '--protocol=socket', `--socket=${socket}`, '-uroot', 'shutdown'
        ]);
      } catch {
        try {
          const numero = Number((await fsp.readFile(pid, 'utf8')).trim());
          if (Number.isInteger(numero)) process.kill(numero, 'SIGTERM');
        } catch {}
      }
    }
    await fsp.rm(raiz, { recursive: true, force: true });
  }
}

executarTeste().catch(erro => {
  console.error(`FALHA: restauração MySQL descartável: ${erro.message}`);
  process.exitCode = 1;
});
