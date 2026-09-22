'use strict';

async function criarTabelaReferenciasPagamentoTemporaria(connection) {
  await connection.query(`CREATE TEMPORARY TABLE integracao_referencias_pagamento (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, provedor VARCHAR(40) NOT NULL,
    entidade VARCHAR(40) NOT NULL, entidade_id BIGINT NOT NULL,
    referencia_provedor VARCHAR(120) NOT NULL, valor DECIMAL(12,2) NOT NULL,
    moeda CHAR(3) NOT NULL DEFAULT 'BRL', expiracao_segundos INT UNSIGNED,
    solicitacao_pagador VARCHAR(140),
    status ENUM('PREPARADA','REGISTRADA','PAGA','CANCELADA','EXPIRADA','FALHOU')
      DEFAULT 'PREPARADA',
    identificador_pagamento VARCHAR(160), location VARCHAR(500), pix_copia_cola TEXT,
    erro_codigo VARCHAR(80), erro_detalhe VARCHAR(500),
    criada_em DATETIME DEFAULT CURRENT_TIMESTAMP, registrada_em DATETIME, paga_em DATETIME,
    atualizada_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ref (provedor, referencia_provedor)
  ) ENGINE=InnoDB`);
}

module.exports = { criarTabelaReferenciasPagamentoTemporaria };
