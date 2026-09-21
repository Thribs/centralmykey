'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

function poolTransacional(connection) {
  return {
    query: (...args) => connection.query(...args),
    getConnection: async () => ({
      query: (...args) => connection.query(...args),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {}
    })
  };
}

async function iniciarApi(connection, usuario) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = usuario;
    next();
  };
  app.locals.exigirPermissao = (modulo, acao) => (req, res, next) => {
    if (req.headers['x-negar'] === `${modulo}:${acao}`) {
      return res.status(403).json({ ok: false, error: 'Permissão negada no teste' });
    }
    return next();
  };
  const pool = poolTransacional(connection);
  require('./rotas-cadastros')(app, pool);
  require('./rotas-operacionais')(app, pool);

  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function requisitar(url, { metodo = 'GET', corpo, headers = {} } = {}) {
  const resposta = await fetch(url, {
    method: metodo,
    headers: corpo
      ? { 'Content-Type': 'application/json', ...headers }
      : headers,
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  return { resposta, corpo: await resposta.json() };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const sufixo = `${process.pid}-${Date.now()}`;
  const nome = `FORNECEDOR FUNCIONAL ${sufixo}`;
  let servidor;
  let fornecedorId;
  let vinculoId;
  let erro;

  try {
    await connection.beginTransaction();
    const [[usuario]] = await connection.query(
      "SELECT id, nome FROM usuarios WHERE status='ATIVO' ORDER BY id LIMIT 1"
    );
    const [[servico]] = await connection.query(
      "SELECT codigo, nome, marca FROM servicos WHERE ativo=1 ORDER BY id LIMIT 1"
    );
    assert.ok(usuario, 'Usuário ativo é necessário para auditar o teste');
    assert.ok(servico, 'Serviço ativo é necessário para vincular ao fornecedor');

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;

    const criado = await requisitar(`${api.url}/api/fornecedores`, {
      metodo: 'POST',
      corpo: {
        nome,
        contato: 'Contato fictício',
        telefone: '5500000000000',
        whatsapp: '5500000000000',
        email: `fornecedor-${sufixo}@teste.invalid`,
        tipo: 'PESSOA',
        horario_inicio: '08:00',
        horario_fim: '18:00',
        observacoes: 'Criado por teste com rollback'
      }
    });
    assert.strictEqual(criado.resposta.status, 201);
    fornecedorId = criado.corpo.fornecedor_id;

    const negado = await requisitar(
      `${api.url}/api/fornecedores/${fornecedorId}/servicos`,
      {
        metodo: 'POST',
        headers: { 'x-negar': 'FORNECEDORES:editar' },
        corpo: { codigo_servico: servico.codigo, custo: 10 }
      }
    );
    assert.strictEqual(negado.resposta.status, 403);

    const anosInvalidos = await requisitar(
      `${api.url}/api/fornecedores/${fornecedorId}/servicos`,
      {
        metodo: 'POST',
        corpo: {
          codigo_servico: servico.codigo,
          custo: 21.5,
          ano_inicio: 2020,
          ano_fim: 2019
        }
      }
    );
    assert.strictEqual(anosInvalidos.resposta.status, 400);

    const regra = {
      codigo_servico: servico.codigo,
      descricao: `Regra ${servico.nome}`,
      marca: servico.marca || null,
      modelo: `MODELO-${process.pid}`,
      ano_inicio: 2017,
      ano_fim: 2026,
      custo: 21.5,
      moeda: 'BRL',
      prazo_estimado_minutos: 45,
      ativo: 1
    };
    const vinculado = await requisitar(
      `${api.url}/api/fornecedores/${fornecedorId}/servicos`,
      { metodo: 'POST', corpo: regra }
    );
    assert.strictEqual(vinculado.resposta.status, 201);
    vinculoId = vinculado.corpo.servico_id;

    const duplicado = await requisitar(
      `${api.url}/api/fornecedores/${fornecedorId}/servicos`,
      { metodo: 'POST', corpo: regra }
    );
    assert.strictEqual(duplicado.resposta.status, 409);

    const listado = await requisitar(
      `${api.url}/api/fornecedores/${fornecedorId}/servicos`
    );
    assert.strictEqual(listado.resposta.status, 200);
    assert.strictEqual(listado.corpo.total, 1);
    assert.strictEqual(listado.corpo.dados[0].id, vinculoId);
    assert.strictEqual(Number(listado.corpo.dados[0].custo), 21.5);
    assert.ok(
      listado.corpo.catalogo.some(item => item.codigo === servico.codigo),
      'Catálogo ativo deve acompanhar os vínculos sem exigir outra permissão'
    );

    const atualizado = await requisitar(
      `${api.url}/api/fornecedores/${fornecedorId}/servicos/${vinculoId}`,
      {
        metodo: 'PUT',
        corpo: { ...regra, custo: 23.75, prazo_estimado_minutos: 30, ativo: 0 }
      }
    );
    assert.strictEqual(atualizado.resposta.status, 200);

    const fornecedorAtualizado = await requisitar(
      `${api.url}/api/fornecedores/${fornecedorId}`,
      {
        metodo: 'PUT',
        corpo: {
          nome: `${nome} EDITADO`,
          contato: 'Outro contato',
          tipo: 'EMPRESA',
          horario_inicio: '09:00',
          horario_fim: '19:00'
        }
      }
    );
    assert.strictEqual(fornecedorAtualizado.resposta.status, 200);

    const bloqueado = await requisitar(
      `${api.url}/api/fornecedores/${fornecedorId}/status`,
      { metodo: 'PATCH', corpo: { ativo: 0 } }
    );
    assert.strictEqual(bloqueado.resposta.status, 200);

    const [[persistido]] = await connection.query(`
      SELECT f.nome, f.tipo, f.ativo, fs.custo, fs.prazo_estimado_minutos,
             fs.ativo AS servico_ativo,
             (SELECT COUNT(*) FROM auditoria a
               WHERE a.entidade='fornecedor_servicos'
                 AND a.entidade_id=CAST(fs.id AS CHAR)) AS auditorias_servico,
             (SELECT COUNT(*) FROM auditoria a
               WHERE a.entidade='fornecedores'
                 AND a.entidade_id=CAST(f.id AS CHAR)) AS auditorias_fornecedor
        FROM fornecedores f
        JOIN fornecedor_servicos fs ON fs.fornecedor_id=f.id
       WHERE f.id=? AND fs.id=?
    `, [fornecedorId, vinculoId]);
    assert.deepStrictEqual(
      [persistido.nome, persistido.tipo, Number(persistido.ativo),
        Number(persistido.custo), Number(persistido.prazo_estimado_minutos),
        Number(persistido.servico_ativo), Number(persistido.auditorias_servico),
        Number(persistido.auditorias_fornecedor)],
      [`${nome} EDITADO`, 'EMPRESA', 0, 23.75, 30, 0, 2, 3]
    );
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(`
        SELECT
          (SELECT COUNT(*) FROM fornecedores WHERE nome LIKE ?) AS fornecedores,
          (SELECT COUNT(*) FROM fornecedor_servicos fs
            JOIN fornecedores f ON f.id=fs.fornecedor_id
           WHERE f.nome LIKE ?) AS servicos,
          (SELECT COUNT(*) FROM auditoria
           WHERE entidade='fornecedor_servicos'
             AND entidade_id=?) AS auditorias_servico,
          (SELECT COUNT(*) FROM auditoria
           WHERE entidade='fornecedores'
             AND entidade_id=?) AS auditorias_fornecedor
      `, [`${nome}%`, `${nome}%`, String(vinculoId || 0), String(fornecedorId || 0)]);
      assert.strictEqual(Number(residuos.fornecedores), 0);
      assert.strictEqual(Number(residuos.servicos), 0);
      assert.strictEqual(Number(residuos.auditorias_servico), 0);
      assert.strictEqual(Number(residuos.auditorias_fornecedor), 0);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: fornecedor, serviços, custos e auditoria funcionam (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: cadastro de fornecedores: ${erro.message}`);
  process.exitCode = 1;
});
