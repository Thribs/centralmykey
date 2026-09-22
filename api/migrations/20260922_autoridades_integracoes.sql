CREATE TABLE IF NOT EXISTS integracao_autoridades (
  dominio ENUM(
    'PEDIDO',
    'PAGAMENTO',
    'CLIENTE',
    'COMPRADOR',
    'PAGADOR',
    'FISCAL',
    'ESTOQUE'
  ) NOT NULL,
  autoridade ENUM('CENTRAL','WBUY','BLING','MANUAL') NOT NULL,
  atualizado_por BIGINT DEFAULT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (dominio),
  KEY idx_integracao_autoridade (autoridade)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
