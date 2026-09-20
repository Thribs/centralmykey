'use strict';

async function criarTabelaEstornosTemporaria(connection) {
  await connection.query(
    `CREATE TEMPORARY TABLE estornos_pagamentos (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       pagamento_id BIGINT NOT NULL UNIQUE,
       pedido_senha_id BIGINT NOT NULL,
       lancamento_original_id BIGINT NOT NULL,
       lancamento_estorno_id BIGINT NOT NULL UNIQUE,
       pagamento_estorno_id BIGINT NOT NULL UNIQUE,
       valor DECIMAL(12,2) NOT NULL,
       moeda ENUM('BRL','USD','PYG') NOT NULL,
       meio_estorno ENUM(
         'PIX','SICOOB','PLUGPAY','WBUY','CARTAO',
         'DINHEIRO','TRANSFERENCIA','OUTRO'
       ) NOT NULL,
       referencia_externa VARCHAR(120) NULL,
       comprovante_url TEXT NULL,
       motivo VARCHAR(500) NOT NULL,
       status ENUM('CONFIRMADO','CANCELADO') NOT NULL DEFAULT 'CONFIRMADO',
       registrado_por BIGINT NULL,
       criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`
  );
}

module.exports = { criarTabelaEstornosTemporaria };
