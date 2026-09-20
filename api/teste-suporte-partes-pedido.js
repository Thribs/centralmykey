'use strict';

async function criarTabelaPartesPedidoTemporaria(connection) {
  await connection.query(`
    CREATE TEMPORARY TABLE pedido_partes (
      id BIGINT NOT NULL AUTO_INCREMENT,
      pedido_id BIGINT NOT NULL,
      papel ENUM('CLIENTE','COMPRADOR','PAGADOR') NOT NULL,
      cliente_id BIGINT DEFAULT NULL,
      nome VARCHAR(180) NOT NULL,
      documento VARCHAR(30) DEFAULT NULL,
      telefone VARCHAR(25) DEFAULT NULL,
      email VARCHAR(180) DEFAULT NULL,
      criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_pedido_parte_papel (pedido_id, papel)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

module.exports = { criarTabelaPartesPedidoTemporaria };
