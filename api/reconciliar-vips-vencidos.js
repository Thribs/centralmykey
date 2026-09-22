'use strict';

const NOME_BLOQUEIO = 'central_mykey_vips_vencidos';

function validarData(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const data = String(valor);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    throw new Error('Data de reconciliação VIP inválida');
  }
  return data;
}

async function reconciliarVipsVencidos(pool, opcoes = {}) {
  const hoje = validarData(opcoes.hoje);
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
    const [vencidos] = await connection.query(
      `SELECT cliente_id, status,
              DATE_FORMAT(proximo_vencimento, '%Y-%m-%d') AS proximo_vencimento
         FROM cliente_vip
        WHERE status IN ('ATIVO', 'AGUARDANDO_PAGAMENTO')
          AND proximo_vencimento IS NOT NULL
          AND proximo_vencimento < COALESCE(?, CURDATE())
        ORDER BY cliente_id
        FOR UPDATE`,
      [hoje]
    );

    let atualizados = 0;
    for (const vip of vencidos) {
      const [resultado] = await connection.query(
        `UPDATE cliente_vip
            SET status = 'VENCIDO'
          WHERE cliente_id = ?
            AND status = ?`,
        [vip.cliente_id, vip.status]
      );
      if (Number(resultado.affectedRows) !== 1) continue;

      await connection.query(
        `INSERT INTO auditoria
           (usuario_id, modulo, acao, entidade, entidade_id, descricao,
            dados_antes, dados_depois, ip)
         VALUES
           (NULL, 'CLIENTES', 'VENCER_VIP_AUTOMATICO', 'clientes', ?, ?, ?, ?, NULL)`,
        [
          String(vip.cliente_id),
          'Plano VIP vencido automaticamente',
          JSON.stringify({
            status: vip.status,
            proximo_vencimento: vip.proximo_vencimento
          }),
          JSON.stringify({
            status: 'VENCIDO',
            proximo_vencimento: vip.proximo_vencimento
          })
        ]
      );
      atualizados += 1;
    }

    await connection.commit();
    return {
      executado: true,
      analisados: vencidos.length,
      atualizados
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

module.exports = { NOME_BLOQUEIO, reconciliarVipsVencidos };
