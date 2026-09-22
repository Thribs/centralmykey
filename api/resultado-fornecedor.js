'use strict';

function objetoResultado(valor) {
  if (valor && typeof valor === 'object') return valor;
  if (typeof valor !== 'string' || !valor.trim()) return {};
  try {
    const convertido = JSON.parse(valor);
    return convertido && typeof convertido === 'object' ? convertido : {};
  } catch {
    return {};
  }
}

function valorResultado(valor) {
  const texto = String(valor ?? '').trim();
  return texto || null;
}

function normalizarDadosResultado(entrada = {}) {
  const resultado = entrada.resultado && typeof entrada.resultado === 'object'
    ? entrada.resultado
    : {};
  return {
    codigo_mecanico: valorResultado(entrada.codigo_mecanico),
    codigo_imobilizador: valorResultado(entrada.codigo_imobilizador),
    codigo_radio: valorResultado(entrada.codigo_radio),
    pin: valorResultado(entrada.pin),
    resultado: {
      ...resultado,
      codigo_alarme: valorResultado(
        entrada.codigo_alarme ?? resultado.codigo_alarme
      )
    }
  };
}

function possuiResultado(dados) {
  return Boolean(
    dados.codigo_mecanico ||
    dados.codigo_imobilizador ||
    dados.codigo_radio ||
    dados.resultado.codigo_alarme ||
    dados.pin
  );
}

function jsonCanonico(valor) {
  if (Array.isArray(valor)) return valor.map(jsonCanonico);
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(
      Object.keys(valor).sort().map(chave => [chave, jsonCanonico(valor[chave])])
    );
  }
  return valor;
}

function mesmoResultadoFornecedor(registro, dados) {
  if (!registro) return false;
  const existente = objetoResultado(registro.resultado);
  return registro.codigo_mecanico === dados.codigo_mecanico &&
    registro.codigo_imobilizador === dados.codigo_imobilizador &&
    registro.codigo_radio === dados.codigo_radio &&
    registro.pin === dados.pin &&
    JSON.stringify(jsonCanonico(existente)) ===
      JSON.stringify(jsonCanonico(dados.resultado));
}

function erroNegocio(codigo, mensagem, statusHttp) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.statusHttp = statusHttp;
  return erro;
}

function respostaResultado(pedido, resultado, dados, idempotente) {
  return {
    idempotente,
    pedido: {
      id: pedido.id,
      protocolo: pedido.protocolo,
      status: 'CONCLUIDO',
      fornecedor_id: pedido.fornecedor_id,
      custo: Number(pedido.custo || 0)
    },
    resultado: {
      id: resultado.id,
      codigo_mecanico: dados.codigo_mecanico,
      codigo_imobilizador: dados.codigo_imobilizador,
      codigo_radio: dados.codigo_radio,
      codigo_alarme: dados.resultado.codigo_alarme,
      pin: dados.pin
    }
  };
}

async function registrarResultadoFornecedor(connection, {
  pedidoId,
  dados: entrada,
  usuarioId = null,
  fornecedorEsperadoId = null,
  canalRetorno = 'MANUAL',
  referenciaExterna = null
}) {
  const dados = normalizarDadosResultado(entrada);
  if (!possuiResultado(dados)) {
    throw erroNegocio(
      'RESULTADO_DADOS_INVALIDOS',
      'Informe pelo menos um resultado técnico',
      400
    );
  }

  const [pedidos] = await connection.query(
    `SELECT id, protocolo, status, origem_id, fornecedor_id, custo
       FROM pedidos_senha
      WHERE id = ?
      LIMIT 1
      FOR UPDATE`,
    [pedidoId]
  );
  if (!pedidos.length) {
    throw erroNegocio('PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado', 404);
  }

  const pedido = pedidos[0];
  if (
    fornecedorEsperadoId &&
    Number(pedido.fornecedor_id) !== Number(fornecedorEsperadoId)
  ) {
    throw erroNegocio(
      'FORNECEDOR_DIVERGENTE',
      'O fornecedor da resposta não corresponde ao pedido',
      409
    );
  }

  if (referenciaExterna) {
    const [[historicoExterno]] = await connection.query(
      `SELECT dados
         FROM pedido_historico
        WHERE pedido_id = ?
          AND tipo = 'RESULTADO_RECEBIDO'
          AND JSON_UNQUOTE(JSON_EXTRACT(dados, '$.referencia_externa')) = ?
        ORDER BY id DESC
        LIMIT 1`,
      [pedido.id, referenciaExterna]
    );
    if (historicoExterno) {
      const metadados = objetoResultado(historicoExterno.dados);
      const [[existente]] = await connection.query(
        `SELECT id, fornecedor_id, codigo_mecanico,
                codigo_imobilizador, codigo_radio, pin, resultado
           FROM pedido_resultados
          WHERE id = ? AND pedido_id = ?
          LIMIT 1`,
        [metadados.resultado_id, pedido.id]
      );
      if (existente) {
        return respostaResultado(
          pedido,
          existente,
          normalizarDadosResultado({
            ...existente,
            resultado: objetoResultado(existente.resultado)
          }),
          true
        );
      }
    }
  }

  if (pedido.status === 'CONCLUIDO' && pedido.fornecedor_id) {
    const [[resultadoExistente]] = await connection.query(
      `SELECT id, fornecedor_id, codigo_mecanico,
              codigo_imobilizador, codigo_radio, pin, resultado
         FROM pedido_resultados
        WHERE pedido_id = ?
          AND fornecedor_id = ?
          AND status IN ('ENCONTRADO', 'CONFIRMADO')
        ORDER BY id DESC
        LIMIT 1`,
      [pedido.id, pedido.fornecedor_id]
    );
    if (mesmoResultadoFornecedor(resultadoExistente, dados)) {
      return respostaResultado(pedido, resultadoExistente, dados, true);
    }
  }

  if (pedido.status !== 'EM_CONSULTA' || !pedido.fornecedor_id) {
    throw erroNegocio(
      'RESULTADO_ESTADO_INVALIDO',
      `Pedido no status ${pedido.status} não pode receber resultado de fornecedor`,
      409
    );
  }

  const [registro] = await connection.query(
    `INSERT INTO pedido_resultados (
       pedido_id, banco_senha_id, origem_id, fornecedor_id,
       codigo_mecanico, codigo_imobilizador, codigo_radio, pin,
       resultado, custo, status
     ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'ENCONTRADO')`,
    [
      pedido.id,
      pedido.origem_id || 2,
      pedido.fornecedor_id,
      dados.codigo_mecanico,
      dados.codigo_imobilizador,
      dados.codigo_radio,
      dados.pin,
      JSON.stringify(dados.resultado),
      Number(pedido.custo || 0)
    ]
  );

  await connection.query(
    `UPDATE pedidos_senha
        SET status = 'CONCLUIDO', concluido_em = NOW()
      WHERE id = ?`,
    [pedido.id]
  );
  await connection.query(
    `UPDATE comunicacoes_outbox
        SET status = 'CANCELADA',
            erro_codigo = 'RESULTADO_RECEBIDO',
            erro_detalhe = 'Envio cancelado porque o resultado já foi recebido'
      WHERE pedido_id = ?
        AND finalidade = 'CONSULTA_FORNECEDOR'
        AND status IN ('PENDENTE', 'FALHOU')`,
    [pedido.id]
  );

  const canal = String(canalRetorno || 'MANUAL').toUpperCase();
  await connection.query(
    `INSERT INTO pedido_historico
       (pedido_id, usuario_id, tipo, descricao, dados)
     VALUES (?, ?, 'RESULTADO_RECEBIDO', ?, ?)`,
    [
      pedido.id,
      usuarioId,
      canal === 'WHATSAPP'
        ? 'Resultado do fornecedor recebido automaticamente pelo WhatsApp'
        : 'Resultado do fornecedor registrado e pedido concluído',
      JSON.stringify({
        resultado_id: registro.insertId,
        fornecedor_id: pedido.fornecedor_id,
        status_anterior: pedido.status,
        status_novo: 'CONCLUIDO',
        canal_retorno: canal,
        referencia_externa: referenciaExterna || undefined
      })
    ]
  );

  return respostaResultado(
    pedido,
    { id: registro.insertId },
    dados,
    false
  );
}

module.exports = {
  normalizarDadosResultado,
  possuiResultado,
  registrarResultadoFornecedor
};
