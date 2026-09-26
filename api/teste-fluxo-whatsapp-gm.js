'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { criarTabelaOutboxTemporaria } = require('./teste-suporte-outbox');
const { criarTabelaPartesPedidoTemporaria } = require('./teste-suporte-partes-pedido');
const { criarTabelasNotificacoesTemporarias } = require('./teste-suporte-notificacoes');
const { processarMensagemAtendimento } = require('./processar-mensagens-atendimento');
const { processarComunicacao } = require('./processar-comunicacoes-outbox');
const { finalizarResultadoGmAutomatico } = require('./finalizar-resultado-gm-automatico');

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

function respostaHttp(status, corpo) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(corpo)
  };
}

async function iniciarApi(connection) {
  const app = express();
  app.use(express.json({
    verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); }
  }));
  app.locals.autenticarToken = (req, res, next) => {
    req.usuario = { id: null, nome: 'AUTOMACAO' };
    next();
  };
  app.locals.exigirPermissao = () => (req, res, next) => next();
  const pool = poolTransacional(connection);
  require('./rotas-pedidos')(app, pool);
  require('./rotas-whatsapp')(app, pool);
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

async function webhook(url, segredo, { telefone, mensagemId, texto, nome }) {
  const corpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: telefone, profile: { name: nome || 'Teste GM' } }],
      messages: [{
        from: telefone,
        id: mensagemId,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: texto }
      }]
    } }] }]
  });
  const assinatura = `sha256=${crypto.createHmac('sha256', segredo)
    .update(Buffer.from(corpo)).digest('hex')}`;
  return fetch(`${url}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': assinatura },
    body: corpo
  });
}

async function executar() {
  const connection = await mysql.createConnection(configBanco);
  const fetchOriginal = global.fetch;
  const segredoOriginal = process.env.META_APP_SECRET;
  const segredo = 'segredo-ficticio-fluxo-gm';
  const marcador = `${process.pid}-${String(Date.now()).slice(-8)}`;
  const clienteNome = `CLIENTE WHATSAPP GM ${marcador}`;
  const fornecedorNome = `FORNECEDOR WHATSAPP GM ${marcador}`;
  const clienteTelefone = `5561${String(Date.now()).slice(-9)}`;
  const fornecedorTelefone = `5562${String(Date.now()).slice(-9)}`;
  const chassi = `9BGWA19A0${String(Date.now()).slice(-8)}`;
  const requisicoesJoel = [];
  let gravada = false;
  let servidor;
  let erro;

  try {
    process.env.META_APP_SECRET = segredo;
    await connection.beginTransaction();
    await criarTabelaOutboxTemporaria(connection);
    await criarTabelaPartesPedidoTemporaria(connection);
    await criarTabelasNotificacoesTemporarias(connection);
    await connection.query("SET timestamp = UNIX_TIMESTAMP('2026-09-26 12:00:00')");

    const [[servico]] = await connection.query(
      "SELECT id FROM servicos WHERE codigo='GM_SENHA' AND ativo=1 LIMIT 1"
    );
    assert.ok(servico, 'Serviço GM ativo é obrigatório');
    await connection.query('UPDATE servicos SET exige_documento=0 WHERE id=?', [servico.id]);

    const [cliente] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, dia_fechamento, prazo_pagamento_dias, credito_status)
       VALUES (?, ?, ?, 'COMPLETO', 1, 'FATURAMENTO_SEMANAL', 3, 3, 'LIBERADO')`,
      [clienteNome, clienteTelefone, clienteTelefone]
    );
    const [fornecedor] = await connection.query(
      `INSERT INTO fornecedores
         (nome, whatsapp, tipo, horario_inicio, horario_fim, ativo)
       VALUES (?, ?, 'PESSOA', '00:00:00', '23:59:59', 1)`,
      [fornecedorNome, fornecedorTelefone]
    );
    await connection.query(
      `INSERT INTO fornecedor_servicos
         (fornecedor_id, codigo_servico, descricao, marca, custo, moeda, ativo)
       VALUES (?, 'GM_SENHA', 'TESTE FLUXO WHATSAPP', 'GM', 0.01, 'BRL', 1)`,
      [fornecedor.insertId]
    );

    const api = await iniciarApi(connection);
    servidor = api.servidor;
    global.fetch = async (url, opcoes = {}) => {
      const endereco = String(url);
      if (endereco.startsWith(api.url)) return fetchOriginal(url, opcoes);
      if (!endereco.startsWith('https://mock.joelpires.invalid')) {
        throw new Error(`Destino externo inesperado no teste: ${new URL(endereco).hostname}`);
      }
      requisicoesJoel.push({ url: endereco, method: opcoes.method || 'GET', body: opcoes.body });
      if ((opcoes.method || 'GET') === 'POST') {
        gravada = true;
        return respostaHttp(201, { ok: true });
      }
      if (!gravada) {
        return respostaHttp(404, {
          error: { name: 'SenhaNotFoundError', message: 'Não encontrada (simulado)' }
        });
      }
      const chassiConsulta = new URL(endereco).searchParams.get('chassi');
      return respostaHttp(200, [{
        id: `mock-${marcador}`,
        chassi: chassiConsulta,
        montadoraId: 1,
        codMecanico: 'MC-GM-101',
        codImmo: 'IM-GM-202',
        codRadio: 'RD-GM-303',
        codAlarme: 'AL-GM-404',
        pin: '5050'
      }]);
    };

    let resposta = await webhook(api.url, segredo, {
      telefone: clienteTelefone,
      mensagemId: `wamid.mock.intencao.${marcador}`,
      texto: 'Olá, quero a senha GM do meu carro'
    });
    assert.strictEqual(resposta.status, 200);
    const [[atendimento]] = await connection.query(
      `SELECT id, modo, status FROM atendimentos
        WHERE telefone_normalizado=? ORDER BY id DESC LIMIT 1`, [clienteTelefone]
    );
    assert.deepStrictEqual([atendimento.modo, atendimento.status],
      ['ELETRONICO', 'AGUARDANDO_CLIENTE']);
    const [[pergunta]] = await connection.query(
      `SELECT id, status_entrega FROM atendimento_mensagens
        WHERE atendimento_id=? AND direcao='SAIDA' AND autor_tipo='IA'
        ORDER BY id DESC LIMIT 1`, [atendimento.id]
    );
    const mensagensTexto = [];
    const envioPergunta = await processarMensagemAtendimento(
      connection, pergunta.id,
      async dados => {
        mensagensTexto.push(dados);
        return { mensagem_externa_id: `wamid.mock.pergunta.${marcador}` };
      }
    );
    assert.strictEqual(envioPergunta.enviada, true);
    assert.strictEqual(mensagensTexto.length, 1);

    resposta = await webhook(api.url, segredo, {
      telefone: clienteTelefone,
      mensagemId: `wamid.mock.chassi.${marcador}`,
      texto: chassi
    });
    assert.strictEqual(resposta.status, 200);
    const [[pedido]] = await connection.query(
      `SELECT id, protocolo, status, origem_id, fornecedor_id, custo
         FROM pedidos_senha WHERE cliente_id=? ORDER BY id DESC LIMIT 1`,
      [cliente.insertId]
    );
    assert.strictEqual(pedido.status, 'EM_CONSULTA');
    assert.strictEqual(Number(pedido.fornecedor_id), fornecedor.insertId);
    assert.strictEqual(Number(pedido.custo), 0.01);
    assert.strictEqual(requisicoesJoel.filter(item => item.method === 'GET').length, 1);
    const [[consulta]] = await connection.query(
      `SELECT id, status FROM comunicacoes_outbox
        WHERE pedido_id=? AND finalidade='CONSULTA_FORNECEDOR' LIMIT 1`, [pedido.id]
    );
    assert.strictEqual(consulta.status, 'PENDENTE');
    const envioFornecedor = await processarComunicacao(
      connection, consulta.id,
      async () => ({ mensagem_externa_id: `wamid.mock.fornecedor.${marcador}` }),
      { nomeModeloFornecedor: 'consulta_fornecedor_gm_teste' }
    );
    assert.strictEqual(envioFornecedor.enviada, true);

    resposta = await webhook(api.url, segredo, {
      telefone: fornecedorTelefone,
      mensagemId: `wamid.mock.resultado.${marcador}`,
      texto: [
        `MYKEY ${pedido.protocolo}`,
        'MECÂNICO: MC-GM-101',
        'IMOBILIZADOR: IM-GM-202',
        'RÁDIO: RD-GM-303',
        'ALARME: AL-GM-404',
        'PIN: 5050'
      ].join('\n'),
      nome: 'Fornecedor teste'
    });
    assert.strictEqual(resposta.status, 200);

    const post = requisicoesJoel.find(item => item.method === 'POST');
    assert.ok(post, 'Resultado do fornecedor deve ser salvo na API Joel Pires');
    const payload = JSON.parse(post.body);
    assert.strictEqual(String(payload.userId), '-1');
    assert.strictEqual(payload.senha.montadoraId, 1);
    assert.strictEqual(payload.senha.codMecanico, 'MC-GM-101');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'ID_TRANSACAO'), false);
    assert.strictEqual(JSON.stringify(payload).includes('ID_TRANSACAO'), false);

    const [[resultado]] = await connection.query(
      `SELECT pr.status, pr.banco_senha_id, p.status AS pedido_status,
              (SELECT COUNT(*) FROM banco_senhas bs
                WHERE bs.id=pr.banco_senha_id
                  AND JSON_UNQUOTE(JSON_EXTRACT(bs.dados_extras, '$.fonte'))='API_JOELPIRES') AS cache_oficial,
              (SELECT COUNT(*) FROM pedido_historico ph
                WHERE ph.pedido_id=p.id AND ph.tipo='RESULTADO_PUBLICADO_API_JOELPIRES') AS publicado
         FROM pedido_resultados pr JOIN pedidos_senha p ON p.id=pr.pedido_id
        WHERE pr.pedido_id=? ORDER BY pr.id DESC LIMIT 1`, [pedido.id]
    );
    assert.deepStrictEqual([
      resultado.status, resultado.pedido_status,
      Number(resultado.cache_oficial), Number(resultado.publicado)
    ], ['CONFIRMADO', 'CONCLUIDO', 1, 1]);

    const [[entrega]] = await connection.query(
      `SELECT id, status FROM comunicacoes_outbox
        WHERE pedido_id=? AND finalidade='ENTREGA_CLIENTE' LIMIT 1`, [pedido.id]
    );
    assert.strictEqual(entrega.status, 'PENDENTE');
    const envioCliente = await processarComunicacao(
      connection, entrega.id,
      async () => ({ mensagem_externa_id: `wamid.mock.entrega.${marcador}` }),
      { nomeModeloEntrega: 'entrega_resultado_gm_teste' }
    );
    assert.strictEqual(envioCliente.enviada, true);
    const [[final]] = await connection.query(
      'SELECT modo, status, finalizado_em FROM atendimentos WHERE id=?', [atendimento.id]
    );
    assert.strictEqual(final.modo, 'ELETRONICO');
    assert.strictEqual(final.status, 'FINALIZADO');
    assert.ok(final.finalizado_em);

    resposta = await webhook(api.url, segredo, {
      telefone: fornecedorTelefone,
      mensagemId: `wamid.mock.resultado.${marcador}`,
      texto: `MYKEY ${pedido.protocolo}\nMECÂNICO: MC-GM-101`
    });
    assert.strictEqual(resposta.status, 200);
    const [[semDuplicidade]] = await connection.query(
      `SELECT
        (SELECT COUNT(*) FROM pedido_resultados WHERE pedido_id=?) AS resultados,
        (SELECT COUNT(*) FROM comunicacoes_outbox
          WHERE pedido_id=? AND finalidade='ENTREGA_CLIENTE') AS entregas`,
      [pedido.id, pedido.id]
    );
    assert.deepStrictEqual(Object.values(semDuplicidade).map(Number), [1, 1]);

    const telefoneApi = `5564${String(Date.now()).slice(-9)}`;
    const chassiApi = `9BGAPI1A0${String(Date.now()).slice(-8)}`;
    const [clienteApi] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, credito_status)
       VALUES (?, ?, ?, 'COMPLETO', 1, 'FATURAMENTO_SEMANAL', 'LIBERADO')`,
      [`CLIENTE API DIRETA ${marcador}`, telefoneApi, telefoneApi]
    );
    resposta = await webhook(api.url, segredo, {
      telefone: telefoneApi,
      mensagemId: `wamid.mock.api.direta.${marcador}`,
      texto: `Quero senha GM para o chassi ${chassiApi}`
    });
    assert.strictEqual(resposta.status, 200);
    const [[pedidoApi]] = await connection.query(
      `SELECT p.id, p.status, p.fornecedor_id, p.custo,
              pr.status AS resultado_status, pr.banco_senha_id,
              a.id AS atendimento_id, a.status AS atendimento_status
         FROM pedidos_senha p
         JOIN pedido_resultados pr ON pr.pedido_id=p.id
         JOIN pedido_historico ph ON ph.pedido_id=p.id
          AND ph.tipo='ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO'
         JOIN atendimentos a ON a.id=CAST(JSON_UNQUOTE(
          JSON_EXTRACT(ph.dados, '$.atendimento_id')) AS UNSIGNED)
        WHERE p.cliente_id=? ORDER BY p.id DESC LIMIT 1`, [clienteApi.insertId]
    );
    assert.deepStrictEqual([
      pedidoApi.status, pedidoApi.fornecedor_id, Number(pedidoApi.custo),
      pedidoApi.resultado_status, pedidoApi.atendimento_status
    ], ['CONCLUIDO', null, 0, 'CONFIRMADO', 'PRONTO_ENVIO']);
    assert.ok(pedidoApi.banco_senha_id);
    const [[entregaApi]] = await connection.query(
      `SELECT id FROM comunicacoes_outbox
        WHERE pedido_id=? AND finalidade='ENTREGA_CLIENTE' AND status='PENDENTE'`,
      [pedidoApi.id]
    );
    await processarComunicacao(connection, entregaApi.id,
      async () => ({ mensagem_externa_id: `wamid.mock.entrega.api.${marcador}` }),
      { nomeModeloEntrega: 'entrega_resultado_gm_teste' });
    const [[atendimentoApiFinal]] = await connection.query(
      'SELECT status FROM atendimentos WHERE id=?', [pedidoApi.atendimento_id]
    );
    assert.strictEqual(atendimentoApiFinal.status, 'FINALIZADO');

    const telefoneCache = `5565${String(Date.now()).slice(-9)}`;
    const [clienteCache] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, credito_status)
       VALUES (?, ?, ?, 'COMPLETO', 1, 'FATURAMENTO_SEMANAL', 'LIBERADO')`,
      [`CLIENTE CACHE ${marcador}`, telefoneCache, telefoneCache]
    );
    const chamadasAntesCache = requisicoesJoel.length;
    resposta = await webhook(api.url, segredo, {
      telefone: telefoneCache,
      mensagemId: `wamid.mock.cache.${marcador}`,
      texto: `Senha Chevrolet para ${chassiApi}`
    });
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(requisicoesJoel.length, chamadasAntesCache,
      'Cache oficial válido deve evitar nova chamada à API Joel Pires');
    const [[pedidoCache]] = await connection.query(
      `SELECT p.id, p.status, p.fornecedor_id, p.custo, pr.banco_senha_id
         FROM pedidos_senha p JOIN pedido_resultados pr ON pr.pedido_id=p.id
        WHERE p.cliente_id=? ORDER BY p.id DESC LIMIT 1`, [clienteCache.insertId]
    );
    assert.deepStrictEqual([
      pedidoCache.status, pedidoCache.fornecedor_id, Number(pedidoCache.custo),
      Number(pedidoCache.banco_senha_id)
    ], ['CONCLUIDO', null, 0, Number(pedidoApi.banco_senha_id)]);

    const telefoneFalhaEnvio = `5563${String(Date.now()).slice(-9)}`;
    await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, credito_status)
       VALUES (?, ?, ?, 'COMPLETO', 1, 'FATURAMENTO_SEMANAL', 'LIBERADO')`,
      [`CLIENTE FALHA ENVIO ${marcador}`, telefoneFalhaEnvio, telefoneFalhaEnvio]
    );
    resposta = await webhook(api.url, segredo, {
      telefone: telefoneFalhaEnvio,
      mensagemId: `wamid.mock.falha.envio.${marcador}`,
      texto: 'Preciso da senha GM'
    });
    assert.strictEqual(resposta.status, 200);
    const [[atendimentoFalhaEnvio]] = await connection.query(
      `SELECT a.id,
              (SELECT m.id FROM atendimento_mensagens m
                WHERE m.atendimento_id=a.id AND m.autor_tipo='IA'
                ORDER BY m.id DESC LIMIT 1) AS mensagem_id
         FROM atendimentos a WHERE a.telefone_normalizado=?
        ORDER BY a.id DESC LIMIT 1`, [telefoneFalhaEnvio]
    );
    const falhaEnvio = await processarMensagemAtendimento(
      connection, atendimentoFalhaEnvio.mensagem_id,
      async () => { const falha = new Error('Falha simulada'); falha.codigo = 'MOCK'; throw falha; }
    );
    assert.strictEqual(falhaEnvio.enviada, false);
    const [[filaPorFalhaEnvio]] = await connection.query(
      'SELECT modo, status FROM atendimentos WHERE id=?', [atendimentoFalhaEnvio.id]
    );
    assert.deepStrictEqual([filaPorFalhaEnvio.modo, filaPorFalhaEnvio.status],
      ['HUMANO', 'FILA']);

    const protocoloFalhaJoel = `FAIL${process.pid}${String(Date.now()).slice(-6)}`;
    const [atendimentoFalhaJoel] = await connection.query(
      `INSERT INTO atendimentos
         (protocolo, cliente_id, telefone, telefone_normalizado, canal, modo,
          status, prioridade, assunto, ultima_mensagem_em)
       VALUES (?, ?, ?, ?, 'WHATSAPP', 'ELETRONICO', 'AGUARDANDO_FORNECEDOR',
               'NORMAL', 'Senha GM', NOW())`,
      [`ATD-${protocoloFalhaJoel}`, cliente.insertId, clienteTelefone, clienteTelefone]
    );
    const [pedidoFalhaJoel] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, status, valor_venda,
          custo, moeda, fornecedor_id, origem_id, concluido_em)
       VALUES (?, ?, ?, ?, 'GM', 'CONCLUIDO', 50, 0.01, 'BRL', ?, 2, NOW())`,
      [protocoloFalhaJoel, cliente.insertId, servico.id,
        `9BGFAILA0${String(Date.now()).slice(-8)}`, fornecedor.insertId]
    );
    const [resultadoFalhaJoel] = await connection.query(
      `INSERT INTO pedido_resultados
         (pedido_id, origem_id, fornecedor_id, codigo_mecanico, resultado,
          custo, status)
       VALUES (?, 2, ?, 'MC-FALHA', JSON_OBJECT(), 0.01, 'ENCONTRADO')`,
      [pedidoFalhaJoel.insertId, fornecedor.insertId]
    );
    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, tipo, descricao, dados)
       VALUES (?, 'ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO', 'Teste', ?)`,
      [pedidoFalhaJoel.insertId,
        JSON.stringify({ atendimento_id: atendimentoFalhaJoel.insertId })]
    );
    const publicacaoFalhou = await finalizarResultadoGmAutomatico(
      poolTransacional(connection), pedidoFalhaJoel.insertId,
      { fetchImpl: async () => respostaHttp(500, { error: 'simulado' }) }
    );
    assert.strictEqual(publicacaoFalhou.humano, true);
    const [[estadoFalhaJoel]] = await connection.query(
      `SELECT a.modo, a.status,
              (SELECT status FROM pedido_resultados WHERE id=?) AS resultado_status,
              (SELECT COUNT(*) FROM comunicacoes_outbox
                WHERE pedido_id=? AND finalidade='ENTREGA_CLIENTE') AS entregas
         FROM atendimentos a WHERE a.id=?`,
      [resultadoFalhaJoel.insertId, pedidoFalhaJoel.insertId,
        atendimentoFalhaJoel.insertId]
    );
    assert.deepStrictEqual([
      estadoFalhaJoel.modo, estadoFalhaJoel.status,
      estadoFalhaJoel.resultado_status, Number(estadoFalhaJoel.entregas)
    ], ['HUMANO', 'FILA', 'ENCONTRADO', 0]);
  } catch (falha) {
    erro = falha;
  } finally {
    global.fetch = fetchOriginal;
    if (segredoOriginal === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = segredoOriginal;
    try {
      await fecharServidor(servidor);
      await connection.rollback();
      const [[residuos]] = await connection.query(
        `SELECT
          (SELECT COUNT(*) FROM clientes WHERE nome=?) AS clientes,
          (SELECT COUNT(*) FROM fornecedores WHERE nome=?) AS fornecedores,
          (SELECT COUNT(*) FROM pedidos_senha p JOIN clientes c ON c.id=p.cliente_id
            WHERE c.nome=?) AS pedidos`,
        [clienteNome, fornecedorNome, clienteNome]
      );
      assert.deepStrictEqual(Object.values(residuos).map(Number), [0, 0, 0]);
    } catch (falhaLimpeza) {
      erro = erro || falhaLimpeza;
    } finally {
      await connection.end();
    }
  }

  if (erro) throw erro;
  console.log('OK: fluxo WhatsApp GM completo usa mocks, confirma na API Joel Pires e faz rollback');
}

executar().catch(erro => {
  console.error(`FALHA: fluxo WhatsApp GM: ${erro.stack || erro.message}`);
  process.exitCode = 1;
});
