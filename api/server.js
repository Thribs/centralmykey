require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const processarFaturasSemanais = require('./processar-faturas-semanais');
const processarMidiasWhatsapp = require('./processar-midias-whatsapp');
const processarAnexosExpirados = require('./processar-anexos-expirados');
const {
  reprocessarPedidosGm
} = require('./reprocessar-pedidos-gm');
const {
  processarComunicacoesOutbox
} = require('./processar-comunicacoes-outbox');
const {
  processarMensagensAtendimento
} = require('./processar-mensagens-atendimento');
const {
  obterConfiguracaoWhatsapp
} = require('./configuracoes-integracoes');
const {
  reconciliarAlertasOperacionais
} = require('./reconciliar-alertas-operacionais');
const {
  reconciliarVipsVencidos
} = require('./reconciliar-vips-vencidos');
const {
  reconciliarCobrancasSicoobExpiradas
} = require('./expirar-cobrancas-sicoob');
const {
  registrarContextoRequisicao,
  registrarTratamentoFinal
} = require('./middleware-erros');
const { mascararConfiguracao } = require('./seguranca-configuracoes');

const app = express();

function inteiroConfiguradoIntervalo(valor, padrao) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= 10000 && numero <= 86400000
    ? numero
    : padrao;
}

app.use(cors());
registrarContextoRequisicao(app);
app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = buffer;
  }
}));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

require('./rotas-auth')(app, pool);
require('./rotas-health')(app, pool);

const autenticarToken = app.locals.autenticarToken;
const exigirPermissao = app.locals.exigirPermissao;

/* =========================
   CONFIGURAÇÕES
========================= */

app.get('/api/configuracoes', autenticarToken, exigirPermissao('CONFIGURACOES', 'visualizar'), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        chave,
        valor,
        descricao
      FROM configuracoes
      ORDER BY chave
    `);

    res.json({
      ok: true,
      total: rows.length,
      dados: rows.map(mascararConfiguracao)
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: 'Erro ao consultar configurações'
    });
  }
});

require('./rotas-clientes')(app, pool);
require('./rotas-busca-global')(app, pool);
require('./rotas-financeiro')(app, pool);
require('./rotas-fechamentos-fornecedores')(app, pool);
require('./rotas-estornos')(app, pool);
require('./rotas-notificacoes')(app, pool);
require('./rotas-auditoria')(app, pool);
require('./rotas-pedidos')(app, pool);
require('./rotas-whatsapp')(app, pool);
require('./rotas-whatsapp-admin')(app, pool);
require('./rotas-atendimento')(app, pool);
require('./rotas-administracao')(app, pool);
require('./rotas-integracoes')(app, pool);
require('./rotas-mapeamentos-integracoes')(app, pool);
require('./rotas-relatorios')(app, pool);
require('./rotas-cadastros')(app, pool);
require('./rotas-operacionais')(app, pool);

/* =========================
   START
========================= */

const port = Number(process.env.PORT || 3000);

let fechamentoFaturasEmAndamento = false;

async function executarFechamentoAutomatico() {
  if (fechamentoFaturasEmAndamento) return;

  fechamentoFaturasEmAndamento = true;

  try {
    const resultado = await processarFaturasSemanais(pool);

    if (resultado.analisadas > 0) {
      console.log('Fechamento automático de faturas:', resultado);
    }

  } catch (error) {
    console.error(
      'Erro no fechamento automático de faturas:',
      error
    );

  } finally {
    fechamentoFaturasEmAndamento = false;
  }
}

let processamentoMidiasEmAndamento = false;

async function executarProcessamentoMidias() {
  if (processamentoMidiasEmAndamento) return;

  processamentoMidiasEmAndamento = true;

  try {
    const resultado = await processarMidiasWhatsapp(pool);

    if (
      resultado.executado &&
      (resultado.encontrados > 0 || resultado.falhas > 0)
    ) {
      console.log(
        'Processamento de mídias do WhatsApp:',
        resultado
      );
    }
  } catch (error) {
    console.error(
      'Erro no processamento de mídias do WhatsApp:',
      error
    );
  } finally {
    processamentoMidiasEmAndamento = false;
  }
}

let limpezaAnexosEmAndamento = false;

async function executarLimpezaAnexos() {
  if (limpezaAnexosEmAndamento) return;

  limpezaAnexosEmAndamento = true;

  try {
    const resultado = await processarAnexosExpirados(pool);

    if (
      resultado.executado &&
      (resultado.encontrados > 0 || resultado.falhas > 0)
    ) {
      console.log(
        'Limpeza de anexos expirados:',
        resultado
      );
    }
  } catch (error) {
    console.error(
      'Erro na limpeza de anexos expirados:',
      error
    );
  } finally {
    limpezaAnexosEmAndamento = false;
  }
}

let reprocessamentoGmEmAndamento = false;

async function executarReprocessamentoGm() {
  if (reprocessamentoGmEmAndamento) return;
  reprocessamentoGmEmAndamento = true;

  try {
    const resultado = await reprocessarPedidosGm(pool);
    if (
      resultado.executado &&
      (resultado.encontrados > 0 || resultado.falhas > 0)
    ) {
      console.log('Reprocessamento automático GM:', resultado);
    }
  } catch (error) {
    console.error('Erro no reprocessamento automático GM:', error);
  } finally {
    reprocessamentoGmEmAndamento = false;
  }
}

let comunicacoesOutboxEmAndamento = false;

async function executarComunicacoesOutbox() {
  if (comunicacoesOutboxEmAndamento) return;
  comunicacoesOutboxEmAndamento = true;

  try {
    const whatsapp = await obterConfiguracaoWhatsapp(pool);
    const resultado = await processarComunicacoesOutbox(
      pool,
      app.locals.enviarModeloWhatsapp,
      {
        habilitado: whatsapp.outboxHabilitada,
        nomeModeloFornecedor: whatsapp.modeloFornecedor,
        nomeModeloEntrega: whatsapp.modeloEntrega,
        idiomaModeloFornecedor: whatsapp.idiomaModeloFornecedor,
        idiomaModeloEntrega: whatsapp.idiomaModeloEntrega,
        automacaoGmHabilitada: whatsapp.automacaoGmHabilitada
      }
    );
    if (
      resultado.executado &&
      (resultado.encontrados > 0 || resultado.falhas > 0)
    ) {
      console.log('Processamento da outbox de comunicações:', resultado);
    }
  } catch (error) {
    console.error('Erro no processamento da outbox:', error);
  } finally {
    comunicacoesOutboxEmAndamento = false;
  }
}

let mensagensAtendimentoEmAndamento = false;

async function executarMensagensAtendimento() {
  if (mensagensAtendimentoEmAndamento) return;
  mensagensAtendimentoEmAndamento = true;
  try {
    const whatsapp = await obterConfiguracaoWhatsapp(pool);
    const resultado = await processarMensagensAtendimento(
      pool,
      app.locals.enviarMensagemWhatsapp,
      { habilitado: whatsapp.outboxHabilitada,
        automacaoGmHabilitada: whatsapp.automacaoGmHabilitada }
    );
    if (resultado.executado && (resultado.encontrados > 0 || resultado.falhas > 0)) {
      console.log('Processamento das mensagens de atendimento:', resultado);
    }
  } catch (error) {
    console.error('Erro no processamento das mensagens de atendimento:', error);
  } finally {
    mensagensAtendimentoEmAndamento = false;
  }
}

let alertasOperacionaisEmAndamento = false;

async function executarAlertasOperacionais() {
  if (alertasOperacionaisEmAndamento) return;
  alertasOperacionaisEmAndamento = true;
  try {
    const resultado = await reconciliarAlertasOperacionais(pool);
    if (resultado.executado && resultado.alertas.some(item => item.alterada)) {
      console.log('Alertas operacionais reconciliados:', resultado.totais);
    }
  } catch (error) {
    console.error('Erro ao reconciliar alertas operacionais:', error.message);
  } finally {
    alertasOperacionaisEmAndamento = false;
  }
}

let reconciliacaoVipsEmAndamento = false;

async function executarReconciliacaoVips() {
  if (reconciliacaoVipsEmAndamento) return;
  reconciliacaoVipsEmAndamento = true;
  try {
    const resultado = await reconciliarVipsVencidos(pool);
    if (resultado.executado && resultado.atualizados > 0) {
      console.log('Planos VIP vencidos reconciliados:', resultado.atualizados);
    }
  } catch (error) {
    console.error('Erro ao reconciliar planos VIP:', error.message);
  } finally {
    reconciliacaoVipsEmAndamento = false;
  }
}

let reconciliacaoSicoobEmAndamento = false;

async function executarReconciliacaoSicoob() {
  if (reconciliacaoSicoobEmAndamento) return;
  reconciliacaoSicoobEmAndamento = true;
  try {
    const resultado = await reconciliarCobrancasSicoobExpiradas(pool);
    if (resultado.executado && resultado.atualizadas > 0) {
      console.log('Cobranças Sicoob expiradas reconciliadas:', resultado.atualizadas);
    }
  } catch (error) {
    console.error('Erro ao reconciliar cobranças Sicoob:', error.message);
  } finally {
    reconciliacaoSicoobEmAndamento = false;
  }
}

require('./rotas-openai')(app, pool);
registrarTratamentoFinal(app);

app.listen(port, '127.0.0.1', () => {
  console.log(`Central MyKey API ativa na porta ${port}`);

  executarFechamentoAutomatico();

  const intervaloFaturas = setInterval(
    executarFechamentoAutomatico,
    60 * 60 * 1000
  );

  intervaloFaturas.unref();

  executarProcessamentoMidias();

  const intervaloMidias = setInterval(
    executarProcessamentoMidias,
    30 * 1000
  );

  intervaloMidias.unref();

  executarLimpezaAnexos();

  const intervaloLimpezaAnexos = setInterval(
    executarLimpezaAnexos,
    60 * 60 * 1000
  );

  intervaloLimpezaAnexos.unref();

  executarReprocessamentoGm();

  const intervaloReprocessamentoGm = setInterval(
    executarReprocessamentoGm,
    inteiroConfiguradoIntervalo(
      process.env.REPROCESSAMENTO_GM_INTERVALO_MS,
      5 * 60 * 1000
    )
  );

  intervaloReprocessamentoGm.unref();

  executarComunicacoesOutbox();

  const intervaloComunicacoes = setInterval(
    executarComunicacoesOutbox,
    inteiroConfiguradoIntervalo(
      process.env.COMUNICACOES_OUTBOX_INTERVALO_MS,
      30 * 1000
    )
  );

  intervaloComunicacoes.unref();

  executarMensagensAtendimento();

  const intervaloMensagensAtendimento = setInterval(
    executarMensagensAtendimento,
    inteiroConfiguradoIntervalo(
      process.env.MENSAGENS_ATENDIMENTO_INTERVALO_MS,
      15 * 1000
    )
  );

  intervaloMensagensAtendimento.unref();

  executarAlertasOperacionais();

  const intervaloAlertasOperacionais = setInterval(
    executarAlertasOperacionais,
    inteiroConfiguradoIntervalo(
      process.env.ALERTAS_OPERACIONAIS_INTERVALO_MS,
      60 * 1000
    )
  );

  intervaloAlertasOperacionais.unref();

  executarReconciliacaoVips();

  const intervaloReconciliacaoVips = setInterval(
    executarReconciliacaoVips,
    inteiroConfiguradoIntervalo(
      process.env.VIP_RECONCILIACAO_INTERVALO_MS,
      60 * 60 * 1000
    )
  );

  intervaloReconciliacaoVips.unref();

  executarReconciliacaoSicoob();

  const intervaloReconciliacaoSicoob = setInterval(
    executarReconciliacaoSicoob,
    inteiroConfiguradoIntervalo(
      process.env.SICOOB_RECONCILIACAO_INTERVALO_MS,
      5 * 60 * 1000
    )
  );

  intervaloReconciliacaoSicoob.unref();
});
