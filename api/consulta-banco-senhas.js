'use strict';

function normalizarChassi(valor) {
  const chassi = String(valor || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (!chassi) return null;
  if (chassi.length < 8 || chassi.length > 30) {
    throw new Error('Chassi deve possuir entre 8 e 30 caracteres alfanumericos');
  }
  return chassi;
}

function assinatura(senha) {
  return [
    senha.codigo_mecanico_alterado || senha.codigo_mecanico || '',
    senha.codigo_imobilizador_alterado || senha.codigo_imobilizador || '',
    senha.codigo_radio_alterado || senha.codigo_radio || '',
    senha.codigo_alarme_alterado || senha.codigo_alarme || '',
    senha.pin_alterado || senha.pin || ''
  ].map(valor => String(valor).trim().toUpperCase()).join('|');
}

async function buscarSenhaNoBanco(connection, { chassi, codigoServico }) {
  const chassiNormalizado = normalizarChassi(chassi);
  const tipo = String(codigoServico || '').trim().toUpperCase();
  if (!chassiNormalizado || !tipo) return { status: 'NAO_ENCONTRADO' };

  const final8 = chassiNormalizado.slice(-8);
  const prefixoInvertido = final8.split('').reverse().join('');
  const [senhas] = await connection.query(
    `SELECT
       bs.id, bs.tipo, bs.marca, bs.chassi, bs.origem_id,
       bs.fornecedor_id, bs.confiabilidade,
       bs.codigo_mecanico, bs.codigo_mecanico_alterado,
       bs.codigo_imobilizador, bs.codigo_imobilizador_alterado,
       bs.codigo_radio, bs.codigo_radio_alterado,
       bs.codigo_alarme, bs.codigo_alarme_alterado,
       bs.pin, bs.pin_alterado
     FROM banco_senhas bs
     WHERE bs.tipo = ?
       AND bs.ativo = 1
       AND bs.chassi_invertido LIKE CONCAT(?, '%')
     ORDER BY
       CASE bs.confiabilidade
         WHEN 'CONFIRMADA' THEN 1 WHEN 'ALTA' THEN 2
         WHEN 'MEDIA' THEN 3 WHEN 'BAIXA' THEN 4 ELSE 5
       END,
       bs.id DESC
     LIMIT 25
     FOR UPDATE`,
    [tipo, prefixoInvertido]
  );

  if (!senhas.length) return { status: 'NAO_ENCONTRADO', final8 };

  const assinaturas = new Set(senhas.map(assinatura));
  if (assinaturas.size > 1) {
    return {
      status: 'CONFLITO', final8,
      banco_senha_ids: senhas.map(item => item.id)
    };
  }

  const senha = senhas[0];
  if (chassiNormalizado.length > 8 && String(senha.chassi).length === 8) {
    await connection.query(
      `UPDATE banco_senhas SET chassi = ? WHERE id = ? AND CHAR_LENGTH(chassi) = 8`,
      [chassiNormalizado, senha.id]
    );
    senha.chassi = chassiNormalizado;
  }

  return {
    status: 'ENCONTRADO', final8,
    senha: {
      ...senha,
      codigo_mecanico: senha.codigo_mecanico_alterado || senha.codigo_mecanico,
      codigo_imobilizador: senha.codigo_imobilizador_alterado || senha.codigo_imobilizador,
      codigo_radio: senha.codigo_radio_alterado || senha.codigo_radio,
      codigo_alarme: senha.codigo_alarme_alterado || senha.codigo_alarme,
      pin: senha.pin_alterado || senha.pin
    }
  };
}

module.exports = { buscarSenhaNoBanco, normalizarChassi };
