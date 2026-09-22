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

function gerarCpf(base) {
  let cpf = String(base).replace(/\D/g, '').padStart(9, '1').slice(-9);
  if (/^(\d)\1+$/.test(cpf)) cpf = `12345678${cpf.slice(-1)}`;
  const calcular = tamanho => {
    let soma = 0;
    for (let i = 0; i < tamanho; i += 1) {
      soma += Number(cpf[i]) * (tamanho + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  cpf += calcular(9);
  cpf += calcular(10);
  return cpf;
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
  require('./rotas-clientes')(app, poolTransacional(connection));
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

async function requisitar(url, opcoes = {}) {
  const resposta = await fetch(url, opcoes);
  const corpo = await resposta.json();
  return { resposta, corpo };
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const sufixo = `${process.pid}${String(Date.now()).slice(-7)}`.slice(-9);
  const marcador = `CLIENTE FUNCIONAL ${process.pid}-${sufixo}`;
  const telefone = `5599${sufixo}`;
  const cpf = gerarCpf(sufixo);
  let servidor;
  let clienteId;
  let erro;

  try {
    await connection.beginTransaction();
    await connection.query(
      "SET timestamp = UNIX_TIMESTAMP('2026-09-21 12:00:00')"
    );
    const [[usuario]] = await connection.query(
      "SELECT id, nome FROM usuarios WHERE status='ATIVO' ORDER BY id LIMIT 1"
    );
    assert.ok(usuario, 'Usuário ativo é necessário para a auditoria do teste');
    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;
    const json = dados => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados)
    });

    const negado = await requisitar(`${api.url}/api/clientes`, {
      ...json({ nome: marcador, telefone }),
      headers: { 'Content-Type': 'application/json', 'x-negar': 'CLIENTES:criar' }
    });
    assert.strictEqual(negado.resposta.status, 403);

    const invalido = await requisitar(`${api.url}/api/clientes`, json({
      nome: marcador,
      telefone,
      cpf: '11111111111'
    }));
    assert.strictEqual(invalido.resposta.status, 400);
    assert.strictEqual(invalido.corpo.error, 'CPF inválido');

    const criado = await requisitar(`${api.url}/api/clientes`, json({
      nome: marcador,
      telefone,
      cpf,
      email: `cliente-${sufixo}@teste.invalid`,
      cidade: 'Cidade de Teste',
      tipo_cobranca: 'FATURAMENTO_SEMANAL',
      dia_fechamento: 5,
      prazo_pagamento_dias: 7,
      limite_credito: 200,
      credito_status: 'LIBERADO',
      credito_observacao: 'Cadastro fictício',
      vip: true,
      valor_mensalidade: 99.9,
      inicio: '2026-09-20',
      proximo_vencimento: '2026-10-20'
    }));
    assert.strictEqual(criado.resposta.status, 201);
    assert.strictEqual(criado.corpo.ok, true);
    assert.strictEqual(criado.corpo.cadastro_status, 'COMPLETO');
    clienteId = criado.corpo.cliente_id;

    const duplicado = await requisitar(`${api.url}/api/clientes`, json({
      nome: `${marcador} DUPLICADO`,
      telefone
    }));
    assert.strictEqual(duplicado.resposta.status, 409);

    const lista = await requisitar(
      `${api.url}/api/clientes?busca=${encodeURIComponent(sufixo)}`
    );
    assert.strictEqual(lista.resposta.status, 200);
    assert.strictEqual(lista.corpo.total, 1);
    assert.strictEqual(lista.corpo.dados[0].id, clienteId);
    assert.strictEqual(lista.corpo.dados[0].vip_status, 'ATIVO');
    assert.strictEqual(Number(lista.corpo.dados[0].vip_elegivel), 1);

    const detalhe = await requisitar(`${api.url}/api/clientes/${clienteId}`);
    assert.strictEqual(detalhe.resposta.status, 200);
    assert.strictEqual(Number(detalhe.corpo.cliente.valor_mensalidade), 99.9);
    assert.strictEqual(detalhe.corpo.cliente.tipo_cobranca, 'FATURAMENTO_SEMANAL');
    assert.strictEqual(Number(detalhe.corpo.cliente.dia_fechamento), 5);
    assert.strictEqual(Number(detalhe.corpo.cliente.prazo_pagamento_dias), 7);
    assert.strictEqual(Number(detalhe.corpo.cliente.limite_credito), 200);

    const dadosEdicao = {
      nome: `${marcador} EDITADO`,
      telefone,
      cpf,
      cnpj: '',
      email: `editado-${sufixo}@teste.invalid`,
      cidade: 'Outra Cidade de Teste',
      cadastro_status: 'COMPLETO',
      tipo_cobranca: 'FATURAMENTO_SEMANAL',
      dia_fechamento: 7,
      prazo_pagamento_dias: 3,
      limite_credito: 250,
      credito_status: 'LIBERADO',
      credito_observacao: 'Dado fictício',
      vip_status: 'SUSPENSO',
      valor_mensalidade: 110,
      proximo_vencimento: '2026-11-20'
    };
    const fechamentoInvalido = await requisitar(
      `${api.url}/api/clientes/${clienteId}`,
      { ...json(dadosEdicao), method: 'PUT' }
    );
    assert.strictEqual(fechamentoInvalido.resposta.status, 400);
    assert.match(fechamentoInvalido.corpo.error, /entre 0 e 6/);

    dadosEdicao.dia_fechamento = 1;
    const atualizado = await requisitar(`${api.url}/api/clientes/${clienteId}`, {
      ...json(dadosEdicao),
      method: 'PUT'
    });
    assert.strictEqual(atualizado.resposta.status, 200);

    const vipCancelado = await requisitar(`${api.url}/api/clientes/${clienteId}/vip`, {
      ...json({
        status: 'CANCELADO',
        valor_mensalidade: 110,
        proximo_vencimento: null
      }),
      method: 'PUT'
    });
    assert.strictEqual(vipCancelado.resposta.status, 200);
    assert.strictEqual(vipCancelado.corpo.vip.status, 'CANCELADO');
    assert.ok(vipCancelado.corpo.vip.cancelado_em);

    const vipReativado = await requisitar(`${api.url}/api/clientes/${clienteId}/vip`, {
      ...json({
        status: 'ATIVO',
        valor_mensalidade: 115,
        proximo_vencimento: '2026-12-20'
      }),
      method: 'PUT'
    });
    assert.strictEqual(vipReativado.resposta.status, 200);
    assert.strictEqual(vipReativado.corpo.vip.status, 'ATIVO');
    assert.strictEqual(vipReativado.corpo.vip.cancelado_em, null);

    for (const ativo of [0, 1]) {
      const alterado = await requisitar(`${api.url}/api/clientes/${clienteId}/status`, {
        ...json({ ativo }),
        method: 'PATCH'
      });
      assert.strictEqual(alterado.resposta.status, 200);
    }

    const resumo = await requisitar(`${api.url}/api/clientes-resumo`);
    assert.strictEqual(resumo.resposta.status, 200);
    assert.ok(Number(resumo.corpo.resumo.vips_ativos) >= 1);

    const [[estado]] = await connection.query(
      `SELECT c.nome, c.tipo_cobranca, c.dia_fechamento,
              c.prazo_pagamento_dias, c.ativo,
              v.status AS vip_status, v.valor_mensalidade, v.cancelado_em,
              (SELECT COUNT(*) FROM auditoria a
                WHERE a.entidade = 'clientes' AND a.entidade_id = ?) AS auditorias
         FROM clientes c
         JOIN cliente_vip v ON v.cliente_id = c.id
        WHERE c.id = ?`,
      [String(clienteId), clienteId]
    );
    assert.strictEqual(estado.nome, `${marcador} EDITADO`);
    assert.strictEqual(estado.tipo_cobranca, 'FATURAMENTO_SEMANAL');
    assert.strictEqual(Number(estado.dia_fechamento), 1);
    assert.strictEqual(Number(estado.prazo_pagamento_dias), 3);
    assert.strictEqual(Number(estado.ativo), 1);
    assert.strictEqual(estado.vip_status, 'ATIVO');
    assert.strictEqual(Number(estado.valor_mensalidade), 115);
    assert.strictEqual(estado.cancelado_em, null);
    assert.ok(Number(estado.auditorias) >= 6);
  } catch (falha) {
    erro = falha;
  } finally {
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM clientes WHERE nome LIKE ?) AS clientes,
           (SELECT COUNT(*) FROM cliente_vip WHERE cliente_id = ?) AS vips,
           (SELECT COUNT(*) FROM auditoria
             WHERE entidade = 'clientes' AND entidade_id = ?) AS auditorias`,
        [`${marcador}%`, clienteId || -1, String(clienteId || -1)]
      );
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0, 0],
        'Rollback deve remover cliente, VIP e auditoria fictícios');
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: ciclo de clientes e VIP funciona por HTTP (rollback confirmado)');
}

executar().catch(erro => {
  console.error(`FALHA: teste de clientes e VIP: ${erro.message}`);
  process.exitCode = 1;
});
