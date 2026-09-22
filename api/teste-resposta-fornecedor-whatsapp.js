'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const {
  interpretarRespostaFornecedor
} = require('./resposta-fornecedor-whatsapp');
const {
  criarTabelaOutboxTemporaria
} = require('./teste-suporte-outbox');

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

async function iniciarApi(connection) {
  const app = express();
  app.use(express.json({
    verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); }
  }));
  require('./rotas-whatsapp')(app, poolTransacional(connection));
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

async function enviarMensagem(url, segredo, { telefone, mensagemId, texto }) {
  const corpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: telefone, profile: { name: 'Fornecedor teste' } }],
          messages: [{
            from: telefone,
            id: mensagemId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: texto }
          }]
        }
      }]
    }]
  });
  const assinatura = `sha256=${crypto
    .createHmac('sha256', segredo)
    .update(Buffer.from(corpo))
    .digest('hex')}`;
  return fetch(`${url}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': assinatura
    },
    body: corpo
  });
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const segredoOriginal = process.env.META_APP_SECRET;
  const segredo = 'segredo-ficticio-retorno-fornecedor';
  const marcador = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const protocolo = `WFR${process.pid}${String(Date.now()).slice(-7)}`.toUpperCase();
  const fornecedorTelefone = `5511${String(Date.now()).slice(-9)}`;
  const mensagemId = `wamid.mock.retorno.${marcador}`;
  const chassi = `9BGWF11A0${String(Date.now()).slice(-8)}`;
  let servidor;
  let erro;

  try {
    const interpretada = interpretarRespostaFornecedor(
      `MYKEY ${protocolo}\nCódigo mecânico: MC-123\nRádio: RD-456`
    );
    assert.strictEqual(interpretada.valido, true);
    assert.strictEqual(interpretada.dados.codigo_mecanico, 'MC-123');
    assert.strictEqual(
      interpretarRespostaFornecedor('Olá, preciso de ajuda'),
      null
    );
    assert.strictEqual(
      interpretarRespostaFornecedor(`MYKEY ${protocolo}\nCAMPO LIVRE: X`).valido,
      false
    );

    process.env.META_APP_SECRET = segredo;
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);

    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    assert.ok(servico, 'Serviço GM ativo é obrigatório');

    const telefoneCliente = `5598${String(Date.now()).slice(-8)}`;
    const [cliente] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, credito_status)
       VALUES (?, ?, ?, 'COMPLETO', 1, 'ANTECIPADO', 'LIBERADO')`,
      [`CLIENTE WEBHOOK FORNECEDOR ${marcador}`, telefoneCliente, telefoneCliente]
    );
    const [fornecedor] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, ?, 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [`FORNECEDOR WEBHOOK ${marcador}`, fornecedorTelefone]
    );
    const [pedido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, modelo, ano,
          status, valor_venda, custo, moeda, fornecedor_id, origem_id)
       VALUES (?, ?, ?, ?, 'GM', 'RETORNO WHATSAPP', 2026,
               'EM_CONSULTA', 50, 22, 'BRL', ?, 2)`,
      [
        protocolo,
        cliente.insertId,
        servico.id,
        chassi,
        fornecedor.insertId
      ]
    );
    await connection.query(
      `INSERT INTO comunicacoes_outbox
         (chave_idempotencia, canal, finalidade, pedido_id, fornecedor_id,
          destinatario, payload, status, tentativas, mensagem_externa_id, enviado_em)
       VALUES (?, 'WHATSAPP', 'CONSULTA_FORNECEDOR', ?, ?, ?,
               JSON_OBJECT(), 'ENVIADA', 1, ?, NOW())`,
      [
        `CONSULTA_FORNECEDOR:${pedido.insertId}:${fornecedor.insertId}`,
        pedido.insertId,
        fornecedor.insertId,
        fornecedorTelefone,
        `wamid.mock.consulta.${marcador}`
      ]
    );

    const api = await iniciarApi(connection);
    servidor = api.servidor;
    const texto = [
      `MYKEY ${protocolo}`,
      'MECÂNICO: MC-WHATSAPP-01',
      'IMOBILIZADOR: IM-WHATSAPP-02',
      'RÁDIO: RD-WHATSAPP-03',
      'ALARME: AL-WHATSAPP-04',
      'PIN: 9876'
    ].join('\n');

    let resposta = await enviarMensagem(api.url, segredo, {
      telefone: `5521${String(Date.now()).slice(-9)}`,
      mensagemId: `${mensagemId}.remetente-invalido`,
      texto
    });
    assert.strictEqual(resposta.status, 200);
    const [[antesDoFornecedor]] = await connection.query(
      `SELECT p.status,
              (SELECT COUNT(*) FROM pedido_resultados pr
                WHERE pr.pedido_id = p.id) AS resultados
         FROM pedidos_senha p WHERE p.id = ?`,
      [pedido.insertId]
    );
    assert.deepStrictEqual(
      [antesDoFornecedor.status, Number(antesDoFornecedor.resultados)],
      ['EM_CONSULTA', 0]
    );

    resposta = await enviarMensagem(api.url, segredo, {
      telefone: fornecedorTelefone,
      mensagemId,
      texto
    });
    assert.strictEqual(resposta.status, 200);
    resposta = await enviarMensagem(api.url, segredo, {
      telefone: fornecedorTelefone,
      mensagemId,
      texto: `${texto}\n`
    });
    assert.strictEqual(resposta.status, 200);

    const [[estado]] = await connection.query(
      `SELECT
         (SELECT status FROM pedidos_senha WHERE id = ?) AS pedido_status,
         (SELECT COUNT(*) FROM pedido_resultados WHERE pedido_id = ?) AS resultados,
         (SELECT MAX(codigo_mecanico) FROM pedido_resultados WHERE pedido_id = ?) AS mecanico,
         (SELECT MAX(JSON_UNQUOTE(JSON_EXTRACT(resultado, '$.codigo_alarme')))
            FROM pedido_resultados WHERE pedido_id = ?) AS alarme,
         (SELECT COUNT(*) FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'RESULTADO_RECEBIDO') AS historicos,
         (SELECT MAX(JSON_UNQUOTE(JSON_EXTRACT(dados, '$.canal_retorno')))
            FROM pedido_historico
           WHERE pedido_id = ? AND tipo = 'RESULTADO_RECEBIDO') AS canal,
         (SELECT COUNT(*) FROM atendimento_mensagens
           WHERE mensagem_externa_id = ?) AS mensagens_atendimento,
         (SELECT COUNT(*) FROM banco_senhas WHERE chassi = ?) AS cache`,
      [
        pedido.insertId,
        pedido.insertId,
        pedido.insertId,
        pedido.insertId,
        pedido.insertId,
        pedido.insertId,
        mensagemId,
        chassi
      ]
    );
    assert.deepStrictEqual(
      {
        pedido_status: estado.pedido_status,
        resultados: Number(estado.resultados),
        mecanico: estado.mecanico,
        alarme: estado.alarme,
        historicos: Number(estado.historicos),
        canal: estado.canal,
        mensagens_atendimento: Number(estado.mensagens_atendimento),
        cache: Number(estado.cache)
      },
      {
        pedido_status: 'CONCLUIDO',
        resultados: 1,
        mecanico: 'MC-WHATSAPP-01',
        alarme: 'AL-WHATSAPP-04',
        historicos: 1,
        canal: 'WHATSAPP',
        mensagens_atendimento: 0,
        cache: 0
      }
    );
  } catch (falha) {
    erro = falha;
  } finally {
    if (segredoOriginal === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = segredoOriginal;
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
           (SELECT COUNT(*) FROM pedidos_senha WHERE protocolo = ?) AS pedidos,
           (SELECT COUNT(*) FROM fornecedores WHERE nome = ?) AS fornecedores,
           (SELECT COUNT(*) FROM clientes WHERE nome = ?) AS clientes`,
        [
          protocolo,
          `FORNECEDOR WEBHOOK ${marcador}`,
          `CLIENTE WEBHOOK FORNECEDOR ${marcador}`
        ]
      );
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0, 0]);
    } catch (limpeza) {
      erro = erro || limpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log(
    'OK: resposta estruturada do fornecedor via WhatsApp é vinculada, idempotente e revertida'
  );
}

executar().catch(erro => {
  console.error(`FALHA: resposta do fornecedor via WhatsApp: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
