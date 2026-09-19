CREATE TABLE IF NOT EXISTS fechamentos_fornecedores (
  id BIGINT NOT NULL AUTO_INCREMENT,
  fornecedor_id BIGINT NOT NULL,
  periodo_inicio DATE NOT NULL,
  periodo_fim DATE NOT NULL,
  moeda VARCHAR(3) NOT NULL DEFAULT 'BRL',
  quantidade_itens INT NOT NULL DEFAULT 0,
  valor_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  status ENUM('RASCUNHO','FECHADO','PAGO','CANCELADO')
    NOT NULL DEFAULT 'RASCUNHO',
  lancamento_financeiro_id BIGINT DEFAULT NULL,
  gerado_por BIGINT DEFAULT NULL,
  fechado_por BIGINT DEFAULT NULL,
  pago_por BIGINT DEFAULT NULL,
  fechado_em DATETIME DEFAULT NULL,
  pago_em DATETIME DEFAULT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_fechamento_fornecedor_periodo
    (fornecedor_id, periodo_inicio, periodo_fim, moeda),
  KEY idx_fechamento_fornecedor_status (status, periodo_fim),
  KEY idx_fechamento_fornecedor_lancamento (lancamento_financeiro_id),
  CONSTRAINT fk_fechamento_fornecedor
    FOREIGN KEY (fornecedor_id) REFERENCES fornecedores (id),
  CONSTRAINT fk_fechamento_fornecedor_lancamento
    FOREIGN KEY (lancamento_financeiro_id)
    REFERENCES lancamentos_financeiros (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fechamento_fornecedor_itens (
  id BIGINT NOT NULL AUTO_INCREMENT,
  fechamento_id BIGINT NOT NULL,
  pedido_senha_id BIGINT NOT NULL,
  resultado_id BIGINT NOT NULL,
  custo DECIMAL(12,2) NOT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_fechamento_resultado (resultado_id),
  KEY idx_fechamento_item_fechamento (fechamento_id, id),
  KEY idx_fechamento_item_pedido (pedido_senha_id),
  CONSTRAINT fk_fechamento_item_fechamento
    FOREIGN KEY (fechamento_id) REFERENCES fechamentos_fornecedores (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_fechamento_item_pedido
    FOREIGN KEY (pedido_senha_id) REFERENCES pedidos_senha (id),
  CONSTRAINT fk_fechamento_item_resultado
    FOREIGN KEY (resultado_id) REFERENCES pedido_resultados (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
