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
const {
  processarComunicacao,
  processarComunicacoesOutbox
} = require('./processar-comunicacoes-outbox');
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

async function iniciarApi(connection, sicoob) {
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
  require('./rotas-integracoes')(app, pool, {
    configuracaoSicoob: {
      habilitado: true, webhookHabilitado: true,
      clientId: 'cliente-ficticio', clientSecret: 'segredo-ficticio',
      certPath: '/certificado/ficticio', keyPath: '/chave/ficticia',
      chavePix: 'pix@teste.invalid',
      tokenUrl: 'https://sicoob.mock/token', apiUrl: 'https://sicoob.mock/pix',
      scope: 'cob.write'
    },
    transporteSicoob: async requisicao => {
      sicoob.chamadas.push(requisicao);
      if (requisicao.url.endsWith('/token')) {
        return { status: 200, body: JSON.stringify({ access_token: 'token-ficticio' }) };
      }
      sicoob.txid = requisicao.url.split('/').pop();
      return { status: 201, body: JSON.stringify({
        txid: sicoob.txid,
        location: `pix.teste/${sicoob.txid}`,
        pixCopiaECola: `PIX-FICTICIO-${sicoob.txid}`
      }) };
    }
  });
  require('./rotas-whatsapp')(app, pool);
  require('./rotas-atendimento')(app, pool);
  const servidor = await new Promise((resolve, reject) => {
    const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    instancia.once('error', reject);
  });
  return { app, servidor, url: `http://127.0.0.1:${servidor.address().port}` };
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

async function enviarMensagemIaPendente(connection, atendimentoId, referencia) {
  const [[mensagem]] = await connection.query(
    `SELECT id, texto FROM atendimento_mensagens
      WHERE atendimento_id=? AND direcao='SAIDA' AND autor_tipo='IA'
        AND status_entrega='PENDENTE' ORDER BY id LIMIT 1`, [atendimentoId]
  );
  assert.ok(mensagem, `Mensagem automática pendente esperada em ${referencia}`);
  const resultado = await processarMensagemAtendimento(
    connection, mensagem.id,
    async () => ({ mensagem_externa_id: `wamid.mock.ia.${referencia}` })
  );
  assert.strictEqual(resultado.enviada, true);
  return mensagem.texto;
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
  const sicoob = { chamadas: [], txid: null };
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
       VALUES (?, ?, ?, 'PROVISORIO', 1, 'ANTECIPADO', NULL, 0, 'LIBERADO')`,
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

    const api = await iniciarApi(connection, sicoob);
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
      `SELECT id, protocolo, status, origem_id, fornecedor_id, custo, valor_venda
         FROM pedidos_senha WHERE cliente_id=? ORDER BY id DESC LIMIT 1`,
      [cliente.insertId]
    );
    assert.strictEqual(pedido.status, 'AGUARDANDO_PAGAMENTO');
    assert.strictEqual(pedido.fornecedor_id, null);
    assert.strictEqual(Number(pedido.custo), 0);
    assert.strictEqual(requisicoesJoel.filter(item => item.method === 'GET').length, 1);
    const pedidoFiscalTexto = await enviarMensagemIaPendente(
      connection, atendimento.id, `fiscal.${marcador}`
    );
    assert.match(pedidoFiscalTexto, /A consulta custa R\$/);
    assert.match(pedidoFiscalTexto, /CPF\/CNPJ/);
    const [[semConsultaAntesPagamento]] = await connection.query(
      `SELECT COUNT(*) AS total FROM comunicacoes_outbox
        WHERE pedido_id=? AND finalidade='CONSULTA_FORNECEDOR'`, [pedido.id]
    );
    assert.strictEqual(Number(semConsultaAntesPagamento.total), 0);

    resposta = await webhook(api.url, segredo, {
      telefone: clienteTelefone,
      mensagemId: `wamid.mock.fiscal.${marcador}`,
      texto: 'NOME: Cliente Fiscal Teste | CPF: 52998224725 | ' +
        'EMAIL: fiscal@teste.invalid | CIDADE: Brasília'
    });
    assert.strictEqual(resposta.status, 200);
    const [[fiscal]] = await connection.query(
      `SELECT c.cadastro_status, c.cpf_normalizado, c.email, c.cidade,
              (SELECT COUNT(*) FROM pedido_partes pp WHERE pp.pedido_id=?
                AND pp.documento='52998224725' AND pp.email='fiscal@teste.invalid') AS partes
         FROM clientes c WHERE c.id=?`, [pedido.id, cliente.insertId]
    );
    assert.deepStrictEqual([
      fiscal.cadastro_status, fiscal.cpf_normalizado, fiscal.email,
      fiscal.cidade, Number(fiscal.partes)
    ], ['COMPLETO', '52998224725', 'fiscal@teste.invalid', 'Brasília', 3]);
    const ofertaPixTexto = await enviarMensagemIaPendente(
      connection, atendimento.id, `oferta.pix.${marcador}`
    );
    assert.match(ofertaPixTexto, /Responda PIX/);

    resposta = await webhook(api.url, segredo, {
      telefone: clienteTelefone,
      mensagemId: `wamid.mock.pix.${marcador}`,
      texto: 'PIX'
    });
    assert.strictEqual(resposta.status, 200);
    assert.ok(sicoob.txid, 'A automação deve registrar uma cobrança Pix Sicoob');
    assert.strictEqual(sicoob.chamadas.length, 2);
    const [[referenciaPix]] = await connection.query(
      `SELECT status, valor, pix_copia_cola FROM integracao_referencias_pagamento
        WHERE provedor='SICOOB' AND entidade_id=? ORDER BY id DESC LIMIT 1`, [pedido.id]
    );
    assert.strictEqual(referenciaPix.status, 'REGISTRADA');
    assert.strictEqual(Number(referenciaPix.valor), Number(pedido.valor_venda));
    assert.ok(referenciaPix.pix_copia_cola.startsWith('PIX-FICTICIO-'));
    const codigoPixTexto = await enviarMensagemIaPendente(
      connection, atendimento.id, `codigo.pix.${marcador}`
    );
    assert.match(codigoPixTexto, /PIX-FICTICIO-/);

    const endToEndId = `E${String(Date.now())}ABCDEFGHIJKLMNOPQRSTUV`.slice(0, 32);
    const pagamentoPix = JSON.stringify({ pix: [{
      txid: sicoob.txid,
      endToEndId,
      valor: Number(pedido.valor_venda).toFixed(2),
      horario: '2026-09-26T15:01:00Z'
    }] });
    resposta = await fetchOriginal(`${api.url}/webhooks/sicoob`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-cert-verify': 'SUCCESS' },
      body: pagamentoPix
    });
    assert.strictEqual(resposta.status, 200);
    const pagamentoConfirmado = await resposta.json();
    assert.strictEqual(pagamentoConfirmado.resultados[0].status, 'PROCESSADO');
    assert.strictEqual(pagamentoConfirmado.resultados[0].processamento.status, 'EM_CONSULTA');

    const [[pedidoPago]] = await connection.query(
      `SELECT p.status, p.fornecedor_id, p.custo,
              (SELECT COUNT(*) FROM pagamentos pg
                JOIN lancamentos_financeiros lf ON lf.id=pg.lancamento_id
               WHERE lf.pedido_senha_id=p.id) AS pagamentos,
              (SELECT status FROM integracao_referencias_pagamento r
                WHERE r.entidade_id=p.id AND r.provedor='SICOOB'
                ORDER BY r.id DESC LIMIT 1) AS referencia_status
         FROM pedidos_senha p WHERE p.id=?`, [pedido.id]
    );
    assert.strictEqual(pedidoPago.status, 'EM_CONSULTA');
    assert.strictEqual(Number(pedidoPago.fornecedor_id), fornecedor.insertId);
    assert.strictEqual(Number(pedidoPago.custo), 0.01);
    assert.strictEqual(Number(pedidoPago.pagamentos), 1);
    assert.strictEqual(pedidoPago.referencia_status, 'PAGA');
    assert.strictEqual(requisicoesJoel.filter(item => item.method === 'GET').length, 2);
    const confirmacaoPixTexto = await enviarMensagemIaPendente(
      connection, atendimento.id, `confirmacao.pix.${marcador}`
    );
    assert.match(confirmacaoPixTexto, /Pagamento confirmado/);
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

    resposta = await fetchOriginal(`${api.url}/api/atendimentos/${atendimento.id}`);
    assert.strictEqual(resposta.status, 200);
    const painel = await resposta.json();
    assert.strictEqual(Number(painel.automacao_gm.pedido_id), Number(pedido.id));
    assert.strictEqual(painel.automacao_gm.pagamento_status, 'PAGA');
    assert.strictEqual(painel.automacao_gm.consulta_fornecedor_status, 'ENVIADA');
    assert.strictEqual(painel.automacao_gm.entrega_cliente_status, 'ENVIADA');
    assert.strictEqual(painel.automacao_gm.etapa_automacao, 'CONCLUIDO');

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
       VALUES (?, ?, ?, 'PROVISORIO', 1, 'ANTECIPADO', 'LIBERADO')`,
      [`CLIENTE API DIRETA ${marcador}`, telefoneApi, telefoneApi]
    );
    resposta = await webhook(api.url, segredo, {
      telefone: telefoneApi,
      mensagemId: `wamid.mock.api.direta.${marcador}`,
      texto: `Quero senha GM para o chassi ${chassiApi}`
    });
    assert.strictEqual(resposta.status, 200);
    const [[pedidoApiAguardando]] = await connection.query(
      `SELECT p.id, p.valor_venda, p.status,
              CAST(JSON_UNQUOTE(JSON_EXTRACT(ph.dados, '$.atendimento_id')) AS UNSIGNED)
                AS atendimento_id
         FROM pedidos_senha p JOIN pedido_historico ph ON ph.pedido_id=p.id
          AND ph.tipo='ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO'
        WHERE p.cliente_id=? ORDER BY p.id DESC LIMIT 1`, [clienteApi.insertId]
    );
    assert.strictEqual(pedidoApiAguardando.status, 'AGUARDANDO_PAGAMENTO');
    const chamadasAposPreConsultaApi = requisicoesJoel.length;
    resposta = await webhook(api.url, segredo, {
      telefone: telefoneApi,
      mensagemId: `wamid.mock.api.fiscal.${marcador}`,
      texto: 'NOME: Empresa API Teste | CNPJ: 11222333000181 | ' +
        'EMAIL: api@teste.invalid | CIDADE: Goiânia'
    });
    assert.strictEqual(resposta.status, 200);
    resposta = await webhook(api.url, segredo, {
      telefone: telefoneApi,
      mensagemId: `wamid.mock.api.pix.${marcador}`,
      texto: 'Quero pagar por PIX'
    });
    assert.strictEqual(resposta.status, 200);
    const txidApi = sicoob.txid;
    const e2eApi = `A${String(Date.now())}ABCDEFGHIJKLMNOPQRSTUV`.slice(0, 32);
    resposta = await fetchOriginal(`${api.url}/webhooks/sicoob`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-cert-verify': 'SUCCESS' },
      body: JSON.stringify({ pix: [{
        txid: txidApi, endToEndId: e2eApi,
        valor: Number(pedidoApiAguardando.valor_venda).toFixed(2),
        horario: '2026-09-26T15:02:00Z'
      }] })
    });
    assert.strictEqual(resposta.status, 200);
    assert.strictEqual(requisicoesJoel.length, chamadasAposPreConsultaApi,
      'A consulta após o pagamento deve reutilizar o cache oficial da pré-consulta');
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

    const telefoneFalhaPix = `5566${String(Date.now()).slice(-9)}`;
    const [clienteFalhaPix] = await connection.query(
      `INSERT INTO clientes
         (nome, telefone, telefone_normalizado, cadastro_status, ativo,
          tipo_cobranca, credito_status)
       VALUES (?, ?, ?, 'PROVISORIO', 1, 'ANTECIPADO', 'LIBERADO')`,
      [`CLIENTE FALHA PIX ${marcador}`, telefoneFalhaPix, telefoneFalhaPix]
    );
    resposta = await webhook(api.url, segredo, {
      telefone: telefoneFalhaPix,
      mensagemId: `wamid.mock.falha.pix.inicio.${marcador}`,
      texto: `Preciso de senha GM para 9BGPIX1A0${String(Date.now()).slice(-8)}`
    });
    assert.strictEqual(resposta.status, 200);
    resposta = await webhook(api.url, segredo, {
      telefone: telefoneFalhaPix,
      mensagemId: `wamid.mock.falha.pix.fiscal.${marcador}`,
      texto: 'NOME: Cliente Falha Pix | CPF: 11144477735 | ' +
        'EMAIL: falhapix@teste.invalid | CIDADE: Recife'
    });
    assert.strictEqual(resposta.status, 200);
    const criarPixOriginal = api.app.locals.criarCobrancaSicoobInterna;
    api.app.locals.criarCobrancaSicoobInterna = async () => {
      const falha = new Error('Sicoob indisponível (simulado)');
      falha.codigo = 'SICOOB_INDISPONIVEL';
      throw falha;
    };
    resposta = await webhook(api.url, segredo, {
      telefone: telefoneFalhaPix,
      mensagemId: `wamid.mock.falha.pix.confirmacao.${marcador}`,
      texto: 'PIX'
    });
    api.app.locals.criarCobrancaSicoobInterna = criarPixOriginal;
    assert.strictEqual(resposta.status, 200);
    const [[falhaPix]] = await connection.query(
      `SELECT a.modo, a.status,
              (SELECT COUNT(*) FROM integracao_referencias_pagamento r
                JOIN pedidos_senha p ON p.id=r.entidade_id
               WHERE p.cliente_id=?) AS referencias
         FROM atendimentos a WHERE a.telefone_normalizado=?
         ORDER BY a.id DESC LIMIT 1`, [clienteFalhaPix.insertId, telefoneFalhaPix]
    );
    assert.deepStrictEqual(
      [falhaPix.modo, falhaPix.status, Number(falhaPix.referencias)],
      ['HUMANO', 'FILA', 0]
    );

    const protocoloWorkerInterrompido =
      `STOP${process.pid}${String(Date.now()).slice(-6)}`;
    const [atendimentoWorkerInterrompido] = await connection.query(
      `INSERT INTO atendimentos
         (protocolo, cliente_id, telefone, telefone_normalizado, canal, modo,
          status, prioridade, assunto, ultima_mensagem_em)
       VALUES (?, ?, ?, ?, 'WHATSAPP', 'ELETRONICO', 'AGUARDANDO_FORNECEDOR',
               'NORMAL', 'Senha GM', NOW())`,
      [`ATD-${protocoloWorkerInterrompido}`, cliente.insertId,
        clienteTelefone, clienteTelefone]
    );
    const [pedidoWorkerInterrompido] = await connection.query(
      `INSERT INTO pedidos_senha
         (protocolo, cliente_id, servico_id, chassi, marca, status, valor_venda,
          custo, moeda, fornecedor_id, origem_id)
       VALUES (?, ?, ?, ?, 'GM', 'EM_CONSULTA', 50, 0.01, 'BRL', ?, 2)`,
      [protocoloWorkerInterrompido, cliente.insertId, servico.id,
        `9BGSTOPA0${String(Date.now()).slice(-8)}`, fornecedor.insertId]
    );
    await connection.query(
      `INSERT INTO pedido_historico
         (pedido_id, tipo, descricao, dados)
       VALUES (?, 'ORIGEM_ATENDIMENTO_WHATSAPP_AUTOMATICO', 'Teste', ?)`,
      [pedidoWorkerInterrompido.insertId, JSON.stringify({
        atendimento_id: atendimentoWorkerInterrompido.insertId
      })]
    );
    const [comunicacaoWorkerInterrompido] = await connection.query(
      `INSERT INTO comunicacoes_outbox
         (chave_idempotencia, canal, finalidade, pedido_id, fornecedor_id,
          destinatario, payload, status)
       VALUES (?, 'WHATSAPP', 'CONSULTA_FORNECEDOR', ?, ?, ?, JSON_OBJECT(),
               'PROCESSANDO')`,
      [`TESTE_WORKER_INTERROMPIDO:${pedidoWorkerInterrompido.insertId}`,
        pedidoWorkerInterrompido.insertId, fornecedor.insertId,
        fornecedorTelefone]
    );
    await connection.query(
      `UPDATE comunicacoes_outbox
          SET atualizado_em=DATE_SUB(NOW(), INTERVAL 6 MINUTE)
        WHERE id=?`, [comunicacaoWorkerInterrompido.insertId]
    );
    const reconciliacaoWorker = await processarComunicacoesOutbox(
      poolTransacional(connection), async () => {
        throw new Error('Não deve reenviar processamento interrompido');
      }, { habilitado: true, limite: 10,
        nomeModeloFornecedor: 'consulta_fornecedor_gm_teste' }
    );
    assert.strictEqual(reconciliacaoWorker.interrompidos, 1);
    const [[estadoWorkerInterrompido]] = await connection.query(
      `SELECT a.modo, a.status, o.status AS comunicacao_status,
              o.erro_codigo
         FROM atendimentos a
         JOIN comunicacoes_outbox o ON o.id=?
        WHERE a.id=?`,
      [comunicacaoWorkerInterrompido.insertId,
        atendimentoWorkerInterrompido.insertId]
    );
    assert.deepStrictEqual([
      estadoWorkerInterrompido.modo, estadoWorkerInterrompido.status,
      estadoWorkerInterrompido.comunicacao_status,
      estadoWorkerInterrompido.erro_codigo
    ], ['HUMANO', 'FILA', 'INCERTA', 'PROCESSAMENTO_INTERROMPIDO']);

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
