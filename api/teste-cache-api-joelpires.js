'use strict';

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { buscarSenhaFonteVerdade } = require('./consulta-api-joelpires');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

process.env.AMBIENTE_API_JOELPIRES = 'teste';
process.env.URL_API_JOELPIRES_TESTE = 'https://mock-cache.joelpires.invalid';
process.env.CHAVE_API_JOELPIRES = 'credencial-ficticia';
process.env.ID_USUARIO_API_JOELPIRES = '-1';
process.env.APIJOELPIRES_ID_DISPOSITIVO = 'centralmykey';
process.env.CACHE_SENHAS_JOELPIRES_TTL_SEGUNDOS = '3600';

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

function resposta(status, corpo) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(corpo)
  };
}

async function inserir(connection, {
  chassi,
  codigo,
  apiSenhaId = null,
  atualizado = 'NOW()',
  fonte = null
}) {
  const dadosExtras = fonte
    ? JSON.stringify({ fonte, api_senha_id: apiSenhaId, montadora_id: 1 })
    : null;
  const [registro] = await connection.query(
    `INSERT INTO banco_senhas
       (tipo, marca, modelo, chassi, codigo_mecanico, dados_extras,
        origem_id, confiabilidade, ativo, atualizado_em)
     VALUES ('GM_SENHA', 'GM', 'CACHE E2E', ?, ?, ?, 3,
             'CONFIRMADA', 1, ${atualizado})`,
    [chassi, codigo, dadosExtras]
  );
  return registro.insertId;
}

function entrada(chassi) {
  return {
    chassi,
    codigoServico: 'GM_SENHA',
    marca: 'GM',
    modelo: 'CACHE E2E'
  };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const sufixo = String(Date.now()).slice(-7);
  const chassis = [
    `9BGCACHE01${sufixo}1`.slice(-17),
    `9BGCACHE02${sufixo}2`.slice(-17),
    `9BGCACHE03${sufixo}3`.slice(-17)
  ];
  const idsApi = [
    930000000 + process.pid * 10 + 1,
    930000000 + process.pid * 10 + 2,
    930000000 + process.pid * 10 + 3
  ];
  let erro;

  try {
    await connection.beginTransaction();

    await inserir(connection, {
      chassi: chassis[0], codigo: 'CODIGO-MANUAL-IGNORADO'
    });
    const cacheValidoId = await inserir(connection, {
      chassi: chassis[0], codigo: 'CODIGO-CACHE-VALIDO',
      apiSenhaId: idsApi[0], fonte: 'API_JOELPIRES'
    });
    let chamadas = 0;
    const valido = await buscarSenhaFonteVerdade(
      connection,
      entrada(chassis[0]),
      { fetchImpl: async () => { chamadas += 1; throw new Error('não chamar'); } }
    );
    assert.strictEqual(valido.status, 'ENCONTRADO');
    assert.strictEqual(valido.origem, 'CACHE_JOELPIRES');
    assert.strictEqual(Number(valido.senha.id), Number(cacheValidoId));
    assert.strictEqual(valido.senha.codigo_mecanico, 'CODIGO-CACHE-VALIDO');
    assert.strictEqual(chamadas, 0);

    const cacheVencidoId = await inserir(connection, {
      chassi: chassis[1], codigo: 'CODIGO-VENCIDO',
      apiSenhaId: idsApi[1], fonte: 'API_JOELPIRES',
      atualizado: 'DATE_SUB(NOW(), INTERVAL 2 HOUR)'
    });
    chamadas = 0;
    const renovado = await buscarSenhaFonteVerdade(
      connection,
      entrada(chassis[1]),
      {
        fetchImpl: async () => {
          chamadas += 1;
          return resposta(200, [{
            id: idsApi[1],
            id_montadora: 1,
            chassis: chassis[1],
            cod_mecanico: 'CODIGO-RENOVADO'
          }]);
        }
      }
    );
    assert.strictEqual(renovado.status, 'ENCONTRADO');
    assert.strictEqual(renovado.origem, 'API_JOELPIRES');
    assert.strictEqual(Number(renovado.senha.id), Number(cacheVencidoId));
    assert.strictEqual(chamadas, 1);
    const [[cacheRenovado]] = await connection.query(
      `SELECT COUNT(*) AS total, MAX(codigo_mecanico) AS codigo
         FROM banco_senhas
        WHERE JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.fonte')) = 'API_JOELPIRES'
          AND JSON_UNQUOTE(JSON_EXTRACT(dados_extras, '$.api_senha_id')) = ?`,
      [String(idsApi[1])]
    );
    assert.deepStrictEqual(
      [Number(cacheRenovado.total), cacheRenovado.codigo],
      [1, 'CODIGO-RENOVADO']
    );

    await inserir(connection, {
      chassi: chassis[2], codigo: 'CODIGO-VENCIDO-PROIBIDO',
      apiSenhaId: idsApi[2], fonte: 'API_JOELPIRES',
      atualizado: 'DATE_SUB(NOW(), INTERVAL 2 HOUR)'
    });
    const indisponivel = await buscarSenhaFonteVerdade(
      connection,
      entrada(chassis[2]),
      {
        fetchImpl: async () => {
          throw new TypeError('Falha de rede simulada');
        }
      }
    );
    assert.strictEqual(indisponivel.status, 'INDISPONIVEL');
    assert.strictEqual(indisponivel.origem, 'API_JOELPIRES');
    assert.strictEqual(indisponivel.senha, undefined);
    assert.strictEqual(indisponivel.contingencia, undefined);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await connection.rollback();
      const [residuos] = await connection.query(
        'SELECT id FROM banco_senhas WHERE chassi IN (?, ?, ?)',
        chassis
      );
      assert.strictEqual(residuos.length, 0, 'Rollback deve remover todo cache fictício');
    } catch (limpeza) {
      erro = erro || limpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: cache Joel Pires respeita origem, TTL e renovação (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: cache Joel Pires: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
