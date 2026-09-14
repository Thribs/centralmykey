module.exports = async function processarFaturasSemanais(pool) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [faturas] = await connection.query(
      `SELECT
         f.id,
         f.valor_total AS valor_anterior,
         COUNT(fi.id) AS quantidade_itens,
         COALESCE(SUM(fi.valor), 0) AS valor_calculado
       FROM faturas_clientes f
       LEFT JOIN fatura_itens fi
         ON fi.fatura_id = f.id
       WHERE f.status = 'ABERTA'
         AND f.periodo_fim < CURDATE()
       GROUP BY f.id, f.valor_total
       FOR UPDATE`
    );

    let fechadas = 0;
    let ignoradas = 0;

    for (const fatura of faturas) {
      const quantidadeItens = Number(fatura.quantidade_itens);
      const valorCalculado = Number(fatura.valor_calculado);

      if (quantidadeItens <= 0 || valorCalculado <= 0) {
        ignoradas++;
        continue;
      }

      await connection.query(
        `UPDATE faturas_clientes
         SET
           valor_total = ?,
           status = 'FECHADA',
           fechado_em = NOW()
         WHERE id = ?
           AND status = 'ABERTA'`,
        [valorCalculado, fatura.id]
      );

      await connection.query(
        `INSERT INTO auditoria (
           usuario_id,
           modulo,
           acao,
           entidade,
           entidade_id,
           descricao,
           dados_antes,
           dados_depois,
           ip
         )
         VALUES (
           NULL,
           'FINANCEIRO',
           'FECHAR_FATURA_AUTOMATICO',
           'faturas_clientes',
           ?,
           ?,
           ?,
           ?,
           NULL
         )`,
        [
          String(fatura.id),
          `Fatura semanal ${fatura.id} fechada automaticamente`,
          JSON.stringify({
            status: 'ABERTA',
            valor_total: Number(fatura.valor_anterior)
          }),
          JSON.stringify({
            status: 'FECHADA',
            valor_total: valorCalculado,
            quantidade_itens: quantidadeItens
          })
        ]
      );

      fechadas++;
    }

    await connection.commit();

    return {
      analisadas: faturas.length,
      fechadas,
      ignoradas
    };

  } catch (error) {
    await connection.rollback();
    throw error;

  } finally {
    connection.release();
  }
};
