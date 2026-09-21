CREATE TABLE IF NOT EXISTS integracao_produto_mapeamentos (
  id BIGINT NOT NULL AUTO_INCREMENT,
  provedor ENUM('WBUY','BLING') NOT NULL,
  produto_externo_id VARCHAR(160) DEFAULT NULL,
  sku VARCHAR(120) DEFAULT NULL,
  nome_externo VARCHAR(255) DEFAULT NULL,
  servico_id BIGINT NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_por BIGINT DEFAULT NULL,
  atualizado_por BIGINT DEFAULT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_integracao_produto_id (provedor, produto_externo_id),
  UNIQUE KEY uk_integracao_produto_sku (provedor, sku),
  KEY idx_integracao_produto_servico (servico_id),
  KEY idx_integracao_produto_ativo (provedor, ativo),
  CONSTRAINT fk_integracao_produto_servico
    FOREIGN KEY (servico_id) REFERENCES servicos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
