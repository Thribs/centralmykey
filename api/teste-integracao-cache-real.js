'use strict';

require('dotenv').config({ override: true });
const mysql = require('mysql2/promise');
const {
  buscarSenhaFonteVerdade
} = require('./consulta-api-joelpires');

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  await db.beginTransaction();
  try {
    const resultado = await buscarSenhaFonteVerdade(db, {
      chassi: process.env.CHASSI_TESTE_JOELPIRES || 'MB197925',
      codigoServico: process.env.SERVICO_TESTE_JOELPIRES || 'GM_SENHA',
      marca: process.env.MARCA_TESTE_JOELPIRES || 'GM'
    });

    if (resultado.status !== 'ENCONTRADO') {
      throw new Error(`Resultado inesperado: ${resultado.status}`);
    }

    const senha = resultado.senha;
    const camposCodigo = [
      'codigo_mecanico',
      'codigo_radio',
      'codigo_imobilizador',
      'codigo_alarme',
      'pin'
    ];
    const codigosPresentes = camposCodigo.filter(
      campo => Boolean(senha[campo])
    );

    if (!codigosPresentes.length) {
      throw new Error(
        'API retornou registro sem nenhum código utilizável'
      );
    }

    console.log({
      resultado: 'APROVADO',
      status: resultado.status,
      origem: resultado.origem,
      contingencia: Boolean(resultado.contingencia),
      banco_senha_id_temporario: senha.id,
      chassi: senha.chassi,
      codigos_presentes: codigosPresentes
    });
  } finally {
    await db.rollback();
    await db.end();
    console.log('ROLLBACK: EXECUTADO');
  }
})().catch(erro => {
  console.error({
    resultado: 'FALHA',
    codigo: erro.codigo || erro.code || null,
    mensagem: erro.message
  });
  process.exitCode = 1;
});
