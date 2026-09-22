CREATE TABLE IF NOT EXISTS integracao_status_mapeamentos (
  id BIGINT NOT NULL AUTO_INCREMENT,
  provedor ENUM('WBUY','BLING') NOT NULL,
  dominio ENUM('PEDIDO','PAGAMENTO') NOT NULL,
  status_externo_id VARCHAR(80) NOT NULL,
  status_externo_nome VARCHAR(160) DEFAULT NULL,
  situacao ENUM('PENDENTE','CONFIRMADO','CANCELADO','IGNORADO') NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_por BIGINT DEFAULT NULL,
  atualizado_por BIGINT DEFAULT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_integracao_status (provedor, dominio, status_externo_id),
  KEY idx_integracao_status_situacao (provedor, dominio, situacao, ativo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
