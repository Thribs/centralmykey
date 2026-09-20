'use strict';

function horarioValido(valor) {
  return /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(String(valor || ''));
}

async function selecionarFornecedor(
  connection,
  codigoServico,
  opcoes = {}
) {
  const codigo = String(codigoServico || '').trim().toUpperCase();
  if (!codigo) return null;
  const horario = opcoes.horario === undefined || opcoes.horario === null
    ? null
    : String(opcoes.horario).trim();
  if (horario !== null && !horarioValido(horario)) {
    throw new Error('Horário de referência inválido');
  }
  const [fornecedores] = await connection.query(
    `SELECT fs.fornecedor_id, fs.custo, f.nome AS fornecedor,
            f.whatsapp, f.telefone
       FROM fornecedor_servicos fs
       INNER JOIN fornecedores f ON f.id = fs.fornecedor_id
      WHERE fs.codigo_servico = ?
        AND fs.ativo = 1
        AND f.ativo = 1
        AND (
          f.horario_inicio IS NULL OR f.horario_fim IS NULL OR
          (
            f.horario_inicio <= f.horario_fim
            AND COALESCE(?, CURTIME())
              BETWEEN f.horario_inicio AND f.horario_fim
          ) OR (
            f.horario_inicio > f.horario_fim
            AND (
              COALESCE(?, CURTIME()) >= f.horario_inicio OR
              COALESCE(?, CURTIME()) <= f.horario_fim
            )
          )
        )
      ORDER BY fs.custo ASC, fs.fornecedor_id ASC
      LIMIT 1`,
    [codigo, horario, horario, horario]
  );
  return fornecedores[0] || null;
}

module.exports = { horarioValido, selecionarFornecedor };
