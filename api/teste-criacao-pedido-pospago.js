'use strict';

const assert = require('assert');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  criarTabelaOutboxTemporaria
} = require('./teste-suporte-outbox');
const {
  criarTabelaPartesPedidoTemporaria
} = require('./teste-suporte-partes-pedido');

dotenv.config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});
if (!process.env.DB_HOST && !process.env.CENTRALMYKEY_ENV_PATH) {
  dotenv.config({ path: '/opt/central-mykey-api/.env', quiet: true });
}

process.env.AMBIENTE_API_JOELPIRES = 'teste';
process.env.URL_API_JOELPIRES_TESTE = 'https://mock.joelpires.invalid';
process.env.CHAVE_API_JOELPIRES = 'credencial-ficticia';
process.env.ID_USUARIO_API_JOELPIRES = '-1';
process.env.APIJOELPIRES_ID_DISPOSITIVO = 'centralmykey';
process.env.APIJOELPIRES_TIMEOUT_MS = '1000';

const configBanco = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

function poolTransacional(connection) {
  return {
    getConnection: async () => ({
      query: (...args) => connection.query(...args),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {}
    }),
    query: (...args) => connection.query(...args)
  };
}

async function iniciarApi(connection, usuario) {
  const app = express();
  app.use(express.json());
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = usuario;
    next();
  };
  app.locals.exigirPermissao = () => (req, res, next) => next();
  require('./rotas-pedidos')(app, poolTransacional(connection));

  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return {
    servidor,
    url: `http://127.0.0.1:${servidor.address().port}`
  };
}

async function fecharServidor(servidor) {
  if (!servidor) return;
  await new Promise((resolve, reject) => {
    servidor.close(erro => (erro ? reject(erro) : resolve()));
  });
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const fetchOriginal = global.fetch;
  const sufixo = String(Date.now()).slice(-8);
  const telefoneTeste = `5598${sufixo}`;
  let servidor;
  let protocolo;
  let erro;

  try {
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);
    await criarTabelaPartesPedidoTemporaria(connection);
    await connection.query(
      "SET timestamp = UNIX_TIMESTAMP('2026-09-19 12:00:00')"
    );

    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    const [[usuario]] = await connection.query(
      "SELECT id, nome FROM usuarios WHERE status='ATIVO' ORDER BY id LIMIT 1"
    );
    assert.ok(servico && usuario, 'Serviço e usuário ativos são obrigatórios');

    const [cliente] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, dia_fechamento, prazo_pagamento_dias, credito_status)
       VALUES (?, ?, ?, 'COMPLETO', 1,
               'FATURAMENTO_SEMANAL', 0, 3, 'LIBERADO')`,
      [
        `CLIENTE TESTE ${process.pid}-${sufixo}`,
        telefoneTeste,
        telefoneTeste
      ]
    );

    const [fornecedor] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, '5511888888888', 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [`FORNECEDOR TESTE ${process.pid}-${sufixo}`]
    );
    await connection.query(
      `INSERT INTO fornecedor_servicos
         (fornecedor_id, codigo_servico, descricao, marca, custo, moeda, ativo)
       VALUES (?, 'GM_SENHA', 'TESTE POS-PAGO', 'GM', 0.01, 'BRL', 1)`,
      [fornecedor.insertId]
    );

    const api = await iniciarApi(connection, usuario);
    servidor = api.servidor;

    global.fetch = async (url, opcoes) => {
      if (String(url).startsWith(api.url)) return fetchOriginal(url, opcoes);
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({
          error: { name: 'SenhaNotFoundError', message: 'Simulado' }
        })
      };
    };

    const respostaInvalida = await global.fetch(`${api.url}/api/pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_id: cliente.insertId,
        servico_id: servico.id,
        chassi: `9BGPI11A0${sufixo}`,
        marca: 'GM',
        modelo: 'IDENTIDADE INVALIDA',
        ano: 2026,
        comprador: { nome: 'COMPRADOR', email: 'email-invalido' }
      })
    });
    const corpoInvalido = await respostaInvalida.json();
    assert.strictEqual(respostaInvalida.status, 400);
    assert.strictEqual(corpoInvalido.codigo, 'PARTE_PEDIDO_INVALIDA');

    const resposta = await global.fetch(`${api.url}/api/pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_id: cliente.insertId,
        servico_id: servico.id,
        chassi: `9BGPO11A0${sufixo}`,
        marca: 'GM',
        modelo: 'TESTE POS-PAGO',
        ano: 2026,
        comprador: {
          nome: 'COMPRADOR TESTE',
          documento: '12345678900',
          telefone: '5511999999999',
          email: 'comprador@teste.invalid'
        },
        pagador: {
          nome: 'PAGADOR TESTE',
          documento: '00987654321',
          telefone: '5511888888888',
          email: 'pagador@teste.invalid'
        }
      })
    });
    const corpo = await resposta.json();
    assert.strictEqual(resposta.status, 201);
    assert.strictEqual(corpo.ok, true);
    assert.strictEqual(corpo.pedido.status, 'EM_CONSULTA');
    assert.strictEqual(corpo.pedido.fornecedor_id, fornecedor.insertId);
    assert.strictEqual(corpo.pedido.envio_fornecedor.status, 'PENDENTE');
    protocolo = corpo.pedido.protocolo;

    const respostaDetalhe = await global.fetch(
      `${api.url}/api/pedidos/${corpo.pedido.id}`
    );
    const detalhe = await respostaDetalhe.json();
    assert.strictEqual(respostaDetalhe.status, 200);
    assert.strictEqual(detalhe.ok, true);
    assert.strictEqual(detalhe.partes.cliente.nome.startsWith('CLIENTE TESTE'), true);
    assert.strictEqual(detalhe.partes.comprador.nome, 'COMPRADOR TESTE');
    assert.strictEqual(detalhe.partes.pagador.nome, 'PAGADOR TESTE');
    assert.strictEqual(detalhe.partes.pagador.documento, '00987654321');
    assert.strictEqual(detalhe.comunicacoes.length, 1);
    assert.strictEqual(detalhe.comunicacoes[0].status, 'PENDENTE');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        detalhe.comunicacoes[0],
        'destinatario'
      ),
      false,
      'Detalhe do pedido não deve expor o telefone do fornecedor'
    );

    const respostaFila = await global.fetch(
      `${api.url}/api/fila-pedidos?busca=${encodeURIComponent(protocolo)}`
    );
    const fila = await respostaFila.json();
    assert.strictEqual(respostaFila.status, 200);
    assert.strictEqual(fila.ok, true);
    assert.strictEqual(fila.total, 1);
    assert.strictEqual(fila.dados[0].id, corpo.pedido.id);
    assert.strictEqual(
      fila.dados[0].comunicacao_fornecedor_status,
      'PENDENTE'
    );

    await connection.query(
      "UPDATE clientes SET tipo_cobranca = 'ANTECIPADO' WHERE id = ?",
      [cliente.insertId]
    );
    const respostaAntecipada = await global.fetch(`${api.url}/api/pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_id: cliente.insertId,
        servico_id: servico.id,
        chassi: `9BGAN11A0${sufixo}`,
        marca: 'GM',
        modelo: 'TESTE ANTECIPADO',
        ano: 2026
      })
    });
    const antecipada = await respostaAntecipada.json();
    assert.strictEqual(respostaAntecipada.status, 201);
    assert.strictEqual(antecipada.pedido.status, 'AGUARDANDO_PAGAMENTO');
    const [[partesAntecipadas]] = await connection.query(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT nome) AS nomes
         FROM pedido_partes WHERE pedido_id = ?`,
      [antecipada.pedido.id]
    );
    assert.deepStrictEqual(
      [Number(partesAntecipadas.total), Number(partesAntecipadas.nomes)],
      [3, 1],
      'Cliente, comprador e pagador devem herdar o mesmo snapshot por padrão'
    );

    const respostaResumo = await global.fetch(
      `${api.url}/api/fila-pedidos/resumo`
    );
    const resumo = await respostaResumo.json();
    assert.strictEqual(respostaResumo.status, 200);
    assert.strictEqual(resumo.ok, true);
    assert.ok(
      resumo.indicadores.aguardando_envio_fornecedor >= 1,
      'Resumo deve contabilizar a consulta pendente'
    );

    await connection.query(
      `UPDATE comunicacoes_outbox
          SET status = 'FALHOU', erro_codigo = 'FALHA_SIMULADA'
        WHERE id = ?`,
      [detalhe.comunicacoes[0].id]
    );
    const respostaReagendamento = await global.fetch(
      `${api.url}/api/pedidos/${corpo.pedido.id}` +
        `/comunicacoes/${detalhe.comunicacoes[0].id}/reprocessar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmar_nao_enviado: false })
      }
    );
    const reagendamento = await respostaReagendamento.json();
    assert.strictEqual(respostaReagendamento.status, 200);
    assert.strictEqual(reagendamento.ok, true);
    assert.strictEqual(reagendamento.comunicacao.status, 'PENDENTE');

    const [[estado]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM pedidos_senha WHERE id = ?) AS pedidos,
         (SELECT COUNT(*) FROM fatura_itens WHERE pedido_senha_id = ?) AS itens,
         (SELECT COUNT(*) FROM comunicacoes_outbox
           WHERE pedido_id = ? AND status = 'PENDENTE') AS comunicacoes,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'CONSULTA_FORNECEDOR_AGENDADA')
           AS historicos,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'CONSULTA_FORNECEDOR_REAGENDADA')
           AS reagendamentos,
         (SELECT COUNT(*) FROM pedido_partes WHERE pedido_id = ?) AS partes`,
      [
        corpo.pedido.id,
        corpo.pedido.id,
        corpo.pedido.id,
        corpo.pedido.id,
        corpo.pedido.id,
        corpo.pedido.id
      ]
    );
    assert.deepStrictEqual(
      Object.values(estado).map(Number),
      [1, 1, 1, 1, 1, 3]
    );
  } catch (falha) {
    erro = falha;
  } finally {
    global.fetch = fetchOriginal;
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo = ?) AS pedidos,
           (SELECT COUNT(*) FROM clientes WHERE nome LIKE ?) AS clientes,
           (SELECT COUNT(*) FROM fornecedores WHERE nome LIKE ?) AS fornecedores`,
        [
          protocolo || '',
          `CLIENTE TESTE ${process.pid}-${sufixo}%`,
          `FORNECEDOR TESTE ${process.pid}-${sufixo}%`
        ]
      );
      assert.deepStrictEqual(
        Object.values(residuos).map(Number),
        [0, 0, 0],
        'Rollback deve remover pedido, cliente e fornecedor de teste'
      );
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: criação pós-paga, consulta e reenvio HTTP funcionam (rollback confirmado)'
  );
}

executar().catch(erro => {
  console.error(`FALHA: teste de criação pós-paga: ${erro.message}`);
  process.exitCode = 1;
});
