'use strict';

const NOME_BLOQUEIO = 'central_mykey_cobrancas_sicoob_expiradas';

function validarAgora(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const agora = String(valor);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(agora)) {
    throw new Error('Data de reconciliação Sicoob inválida');
  }
  return agora;
}

async function expirarCobrancasPedidoSicoob(connection, pedidoId, opcoes = {}) {
  const agora = validarAgora(opcoes.agora);
  const [referencias] = await connection.query(
    `SELECT id, status
       FROM integracao_referencias_pagamento
      WHERE provedor='SICOOB' AND entidade='PEDIDO' AND entidade_id=?
        AND status IN ('PREPARADA','REGISTRADA')
        AND TIMESTAMPADD(
              SECOND, COALESCE(expiracao_segundos, 3600), criada_em
            ) <= COALESCE(?, NOW())
      ORDER BY id
      FOR UPDATE`,
    [pedidoId, agora]
  );
  if (referencias.length === 0) return 0;

  const ids = referencias.map(item => item.id);
  const [resultado] = await connection.query(
    `UPDATE integracao_referencias_pagamento
        SET status='EXPIRADA', erro_codigo='COBRANCA_EXPIRADA',
            erro_detalhe='Prazo da cobrança Pix encerrado'
      WHERE id IN (?) AND status IN ('PREPARADA','REGISTRADA')`,
    [ids]
  );
  const quantidade = Number(resultado.affectedRows || 0);
  if (quantidade === 0) return 0;

  const statusAnteriores = [...new Set(referencias.map(item => item.status))];
  const dadosMudanca = {
    quantidade,
    status_anterior: statusAnteriores,
    status: 'EXPIRADA'
  };
  await connection.query(
    `INSERT INTO pedido_historico
       (pedido_id, usuario_id, tipo, descricao, dados)
     VALUES (?, ?, 'COBRANCA_SICOOB_EXPIRADA', ?, ?)`,
    [pedidoId, opcoes.usuarioId || null,
      opcoes.descricao || 'Prazo da cobrança Pix Sicoob encerrado',
      JSON.stringify(dadosMudanca)]
  );
  await connection.query(
    `INSERT INTO auditoria
       (usuario_id, modulo, acao, entidade, entidade_id, descricao,
        dados_antes, dados_depois, ip)
     VALUES (?, 'INTEGRACOES', 'EXPIRAR_COBRANCA_SICOOB',
             'pedidos_senha', ?, ?, ?, ?, ?)`,
    [opcoes.usuarioId || null, String(pedidoId),
      `Cobrança Sicoob do pedido ${pedidoId} expirada`,
      JSON.stringify({ quantidade, status: statusAnteriores }),
      JSON.stringify({ quantidade, status: 'EXPIRADA' }),
      opcoes.ip || null]
  );
  return quantidade;
}

async function reconciliarCobrancasSicoobExpiradas(pool, opcoes = {}) {
  const agora = validarAgora(opcoes.agora);
  const limite = Math.min(Math.max(Number(opcoes.limite) || 200, 1), 1000);
  const connection = await pool.getConnection();
  let bloqueio = false;

  try {
    const [[resultadoBloqueio]] = await connection.query(
      'SELECT GET_LOCK(?, 0) AS adquirido',
      [NOME_BLOQUEIO]
    );
    bloqueio = Number(resultadoBloqueio?.adquirido) === 1;
    if (!bloqueio) return { executado: false, motivo: 'EM_EXECUCAO' };

    await connection.beginTransaction();
    const [referencias] = await connection.query(
      `SELECT id, entidade_id
         FROM integracao_referencias_pagamento
        WHERE provedor='SICOOB' AND entidade='PEDIDO'
          AND status IN ('PREPARADA','REGISTRADA')
          AND TIMESTAMPADD(
                SECOND, COALESCE(expiracao_segundos, 3600), criada_em
              ) <= COALESCE(?, NOW())
        ORDER BY id
        LIMIT ?
        FOR UPDATE`,
      [agora, limite]
    );

    const pedidos = [...new Set(referencias.map(item => Number(item.entidade_id)))];
    let atualizadas = 0;
    for (const pedidoId of pedidos) {
      atualizadas += await expirarCobrancasPedidoSicoob(connection, pedidoId, {
        agora,
        descricao: 'Prazo da cobrança Pix Sicoob encerrado automaticamente'
      });
    }

    await connection.commit();
    return {
      executado: true,
      analisadas: referencias.length,
      pedidos: pedidos.length,
      atualizadas
    };
  } catch (erro) {
    await connection.rollback();
    throw erro;
  } finally {
    if (bloqueio) {
      await connection.query('SELECT RELEASE_LOCK(?)', [NOME_BLOQUEIO])
        .catch(() => {});
    }
    connection.release();
  }
}

module.exports = {
  NOME_BLOQUEIO,
  expirarCobrancasPedidoSicoob,
  reconciliarCobrancasSicoobExpiradas
};
