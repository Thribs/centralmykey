'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { sincronizarModelosSendPulse } = require('./sincronizar-modelos-sendpulse');

dotenv.config({ path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'), quiet: true });
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

async function executar() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
  const marcador = `${process.pid}_${Date.now()}`;
  const aprovado = `modelo_aprovado_${marcador}`;
  const rejeitado = `modelo_rejeitado_${marcador}`;
  let erro;
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO whatsapp_modelos
         (nome, idioma, categoria, status, ativo)
       VALUES (?, 'pt_BR', 'UTILIDADE', 'PENDENTE', 0),
              (?, 'pt_BR', 'UTILIDADE', 'APROVADO', 1)`,
      [aprovado, rejeitado]
    );
    const resultado = await sincronizarModelosSendPulse(connection, [
      { name: aprovado, language: 'pt_BR', status: 'APPROVED' },
      { name: rejeitado, language: { code: 'pt_BR' }, status: 'REJECTED' },
      { name: 'modelo_remoto_sem_cadastro', language: 'pt_BR', status: 'APPROVED' }
    ], { usuarioId: null, ip: '127.0.0.1' });
    assert.deepStrictEqual(resultado, { remotos: 3, encontrados: 2, atualizados: 2 });
    const [modelos] = await connection.query(
      `SELECT nome, status, ativo FROM whatsapp_modelos
        WHERE nome IN (?, ?) ORDER BY nome`, [aprovado, rejeitado]
    );
    const mapa = Object.fromEntries(modelos.map(item => [item.nome, item]));
    assert.deepStrictEqual([mapa[aprovado].status, Number(mapa[aprovado].ativo)],
      ['APROVADO', 0]);
    assert.deepStrictEqual([mapa[rejeitado].status, Number(mapa[rejeitado].ativo)],
      ['REJEITADO', 0]);
    const [[auditoria]] = await connection.query(
      `SELECT COUNT(*) AS total FROM auditoria
        WHERE acao='SINCRONIZAR_MODELO_SENDPULSE'
          AND entidade_id IN (
            SELECT CAST(id AS CHAR) FROM whatsapp_modelos WHERE nome IN (?, ?)
          )`, [aprovado, rejeitado]
    );
    assert.strictEqual(Number(auditoria.total), 2);
  } catch (falha) {
    erro = falha;
  } finally {
    await connection.rollback();
    const [[residuos]] = await connection.query(
      'SELECT COUNT(*) AS total FROM whatsapp_modelos WHERE nome IN (?, ?)',
      [aprovado, rejeitado]
    );
    try { assert.strictEqual(Number(residuos.total), 0); }
    catch (falha) { erro = erro || falha; }
    await connection.end();
  }
  if (erro) throw erro;
  console.log('OK: modelos SendPulse sincronizam status real com rollback confirmado');
}

executar().catch(error => {
  console.error(`FALHA: sincronização de modelos SendPulse: ${error.message}`);
  process.exitCode = 1;
});
