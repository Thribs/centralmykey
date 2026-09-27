'use strict';

const {
  registrarResultadoFornecedor
} = require('./resultado-fornecedor');
const { destinatarioFornecedor } = require('./agendar-consulta-fornecedor');

function semAcentos(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function chaveCampo(valor) {
  return semAcentos(valor)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

const CAMPOS = new Map([
  ['MECANICO', 'codigo_mecanico'],
  ['CODIGO_MECANICO', 'codigo_mecanico'],
  ['IMOBILIZADOR', 'codigo_imobilizador'],
  ['CODIGO_IMOBILIZADOR', 'codigo_imobilizador'],
  ['RADIO', 'codigo_radio'],
  ['CODIGO_RADIO', 'codigo_radio'],
  ['ALARME', 'codigo_alarme'],
  ['CODIGO_ALARME', 'codigo_alarme'],
  ['PIN', 'pin']
]);

function interpretarRespostaFornecedor(texto) {
  const conteudo = String(texto || '').trim();
  if (!/^MYKEY\s+/i.test(conteudo)) return null;
  if (conteudo.length > 1200) {
    return { formatoReconhecido: true, valido: false, erro: 'RESPOSTA_MUITO_LONGA' };
  }

  const linhas = conteudo.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const cabecalho = linhas.shift()?.match(/^MYKEY\s+([A-Z0-9-]{4,80})$/i);
  if (!cabecalho) {
    return { formatoReconhecido: true, valido: false, erro: 'PROTOCOLO_INVALIDO' };
  }

  const dados = {};
  for (const linha of linhas) {
    const partes = linha.match(/^([^:]{2,40}):\s*(.+)$/);
    if (!partes) {
      return { formatoReconhecido: true, valido: false, erro: 'LINHA_INVALIDA' };
    }
    const campo = CAMPOS.get(chaveCampo(partes[1]));
    const valor = partes[2].trim();
    if (!campo || dados[campo] || !valor || valor.length > 100) {
      return { formatoReconhecido: true, valido: false, erro: 'CAMPO_INVALIDO' };
    }
    dados[campo] = valor;
  }

  if (!Object.keys(dados).length) {
    return { formatoReconhecido: true, valido: false, erro: 'RESULTADO_AUSENTE' };
  }

  return {
    formatoReconhecido: true,
    valido: true,
    protocolo: cabecalho[1].toUpperCase(),
    dados
  };
}

async function processarRespostaFornecedorWhatsapp(connection, {
  telefone,
  texto,
  mensagemExternaId
}) {
  const interpretada = interpretarRespostaFornecedor(texto);
  if (!interpretada?.valido) {
    return {
      processada: false,
      reconhecida: Boolean(interpretada?.formatoReconhecido),
      erro: interpretada?.erro || null
    };
  }

  const numero = String(telefone || '').replace(/\D/g, '');
  const referencia = String(mensagemExternaId || '').trim().slice(0, 150);
  if (numero.length < 10 || numero.length > 15 || !referencia) {
    return { processada: false, reconhecida: true, erro: 'REMETENTE_INVALIDO' };
  }

  const [pedidos] = await connection.query(
    `SELECT p.id, p.fornecedor_id, f.nome AS fornecedor,
            f.whatsapp, f.telefone
       FROM pedidos_senha p
       INNER JOIN fornecedores f ON f.id = p.fornecedor_id AND f.ativo = 1
      WHERE UPPER(p.protocolo) = ?
        AND EXISTS (
          SELECT 1
            FROM comunicacoes_outbox co
           WHERE co.pedido_id = p.id
             AND co.fornecedor_id = p.fornecedor_id
             AND co.finalidade = 'CONSULTA_FORNECEDOR'
             AND co.status IN ('ENVIADA', 'ENTREGUE', 'LIDA', 'INCERTA')
        )
      ORDER BY p.id DESC
      LIMIT 1`,
    [interpretada.protocolo]
  );
  const destinatarioEsperado = pedidos[0]
    ? destinatarioFornecedor(pedidos[0])
    : '';
  const remetenteValido = destinatarioEsperado && (
    destinatarioEsperado === numero ||
    destinatarioEsperado.slice(-11) === numero.slice(-11)
  );
  if (!pedidos.length || !remetenteValido) {
    return { processada: false, reconhecida: true, erro: 'VINCULO_NAO_ENCONTRADO' };
  }

  try {
    const registrado = await registrarResultadoFornecedor(connection, {
      pedidoId: pedidos[0].id,
      fornecedorEsperadoId: pedidos[0].fornecedor_id,
      dados: interpretada.dados,
      canalRetorno: 'WHATSAPP',
      referenciaExterna: referencia
    });
    return {
      processada: true,
      reconhecida: true,
      idempotente: registrado.idempotente,
      pedidoId: registrado.pedido.id,
      resultadoId: registrado.resultado.id
    };
  } catch (erro) {
    if (erro.statusHttp && erro.statusHttp < 500) {
      return { processada: false, reconhecida: true, erro: erro.codigo };
    }
    throw erro;
  }
}

module.exports = {
  interpretarRespostaFornecedor,
  processarRespostaFornecedorWhatsapp
};
