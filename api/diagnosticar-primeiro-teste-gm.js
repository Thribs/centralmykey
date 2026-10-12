'use strict';

const path = require('path');
require('dotenv').config({
  path: process.env.CENTRALMYKEY_ENV_PATH || path.join(__dirname, '.env'),
  quiet: true
});

const mysql = require('mysql2/promise');
const {
  carregarConfiguracoesIntegracoes,
  diagnosticarProntidaoPrimeiroCenarioGm,
  diagnosticarProntidaoSicoob,
  diagnosticarProntidaoWhatsapp
} = require('./configuracoes-integracoes');

async function diagnosticar() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
    queueLimit: 0
  });

  try {
    const configuracoes = await carregarConfiguracoesIntegracoes(pool);
    const whatsapp = await diagnosticarProntidaoWhatsapp(pool, configuracoes);
    const sicoob = diagnosticarProntidaoSicoob(configuracoes);
    const primeiroTeste = diagnosticarProntidaoPrimeiroCenarioGm(
      configuracoes,
      whatsapp,
      sicoob
    );
    const [[operacao]] = await pool.query(`SELECT
      (SELECT COUNT(*) FROM comunicacoes_outbox
        WHERE status IN ('PENDENTE','PROCESSANDO','INCERTA')) AS outbox_aberta,
      (SELECT COUNT(*) FROM atendimento_mensagens
        WHERE status_entrega='PENDENTE' AND autor_tipo='IA') AS mensagens_ia_pendentes,
      (SELECT COUNT(*) FROM pedidos_senha
        WHERE status IN ('AGUARDANDO_PAGAMENTO','EM_CONSULTA')) AS pedidos_em_andamento,
      EXISTS(SELECT 1 FROM servicos
        WHERE codigo='GM_SENHA' AND ativo=1 AND preco_base > 0) AS servico_gm_pronto`);
    const contagens = {
      outbox_aberta: Number(operacao.outbox_aberta || 0),
      mensagens_ia_pendentes: Number(operacao.mensagens_ia_pendentes || 0),
      pedidos_em_andamento: Number(operacao.pedidos_em_andamento || 0),
      servico_gm_pronto: Number(operacao.servico_gm_pronto || 0)
    };
    const filaVazia = contagens.outbox_aberta === 0 &&
      contagens.mensagens_ia_pendentes === 0 &&
      contagens.pedidos_em_andamento === 0;
    const servicoGmPronto = contagens.servico_gm_pronto === 1;

    return {
      pronto_para_teste: primeiroTeste.pronto_para_teste && filaVazia && servicoGmPronto,
      componentes: primeiroTeste.componentes,
      bloqueios: [
        ...primeiroTeste.bloqueios,
        ...(filaVazia ? [] : ['OPERACAO:FILA_NAO_VAZIA']),
        ...(servicoGmPronto ? [] : ['OPERACAO:SERVICO_GM_SEM_PRECO'])
      ],
      operacao: contagens
    };
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  diagnosticar().then(resultado => {
    process.stdout.write(`${JSON.stringify(resultado, null, 2)}\n`);
    if (process.argv.includes('--exigir-pronto') && !resultado.pronto_para_teste) {
      process.exitCode = 1;
    }
    if (process.argv.includes('--exigir-fila-vazia') &&
        (resultado.operacao.outbox_aberta !== 0 ||
         resultado.operacao.mensagens_ia_pendentes !== 0 ||
         resultado.operacao.pedidos_em_andamento !== 0)) {
      process.exitCode = 1;
    }
  }).catch(erro => {
    console.error(JSON.stringify({
      pronto_para_teste: false,
      bloqueios: [`DIAGNOSTICO:${erro.code || 'ERRO_INTERNO'}`]
    }));
    process.exitCode = 1;
  });
}

module.exports = { diagnosticar };
