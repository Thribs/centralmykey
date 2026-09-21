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
  obterConfiguracaoWhatsapp
} = require('./configuracoes-integracoes');

const app = express();

function inteiroConfiguradoIntervalo(valor, padrao) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= 10000 && numero <= 86400000
    ? numero
    : padrao;
}

app.use(cors());
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
      dados: rows
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
require('./rotas-financeiro')(app, pool);
require('./rotas-fechamentos-fornecedores')(app, pool);
require('./rotas-estornos')(app, pool);
require('./rotas-notificacoes')(app, pool);
require('./rotas-auditoria')(app, pool);
require('./rotas-whatsapp')(app, pool);
require('./rotas-whatsapp-admin')(app, pool);
require('./rotas-atendimento')(app, pool);
require('./rotas-administracao')(app, pool);
require('./rotas-integracoes')(app, pool);
require('./rotas-mapeamentos-integracoes')(app, pool);
require('./rotas-relatorios')(app, pool);
require('./rotas-cadastros')(app, pool);
require('./rotas-operacionais')(app, pool);
require('./rotas-pedidos')(app, pool);

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
        idiomaModeloEntrega: whatsapp.idiomaModeloEntrega
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

require('./rotas-openai')(app, pool);

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
});
