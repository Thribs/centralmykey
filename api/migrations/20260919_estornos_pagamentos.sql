CREATE TABLE IF NOT EXISTS estornos_pagamentos (
  id BIGINT NOT NULL AUTO_INCREMENT,
  pagamento_id BIGINT NOT NULL,
  pedido_senha_id BIGINT NOT NULL,
  lancamento_original_id BIGINT NOT NULL,
  lancamento_estorno_id BIGINT NOT NULL,
  pagamento_estorno_id BIGINT NOT NULL,
  valor DECIMAL(12,2) NOT NULL,
  moeda ENUM('BRL','USD','PYG') NOT NULL,
  meio_estorno ENUM(
    'PIX','SICOOB','PLUGPAY','WBUY','CARTAO',
    'DINHEIRO','TRANSFERENCIA','OUTRO'
  ) NOT NULL,
  referencia_externa VARCHAR(120) DEFAULT NULL,
  comprovante_url TEXT DEFAULT NULL,
  motivo VARCHAR(500) NOT NULL,
  status ENUM('CONFIRMADO','CANCELADO') NOT NULL DEFAULT 'CONFIRMADO',
  registrado_por BIGINT DEFAULT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_estorno_pagamento (pagamento_id),
  UNIQUE KEY uk_estorno_lancamento (lancamento_estorno_id),
  UNIQUE KEY uk_estorno_pagamento_saida (pagamento_estorno_id),
  KEY idx_estorno_pedido (pedido_senha_id, status),
  KEY idx_estorno_referencia (referencia_externa),
  CONSTRAINT fk_estorno_pagamento_original
    FOREIGN KEY (pagamento_id) REFERENCES pagamentos (id),
  CONSTRAINT fk_estorno_pedido
    FOREIGN KEY (pedido_senha_id) REFERENCES pedidos_senha (id),
  CONSTRAINT fk_estorno_lancamento_original
    FOREIGN KEY (lancamento_original_id) REFERENCES lancamentos_financeiros (id),
  CONSTRAINT fk_estorno_lancamento_saida
    FOREIGN KEY (lancamento_estorno_id) REFERENCES lancamentos_financeiros (id),
  CONSTRAINT fk_estorno_pagamento_saida
    FOREIGN KEY (pagamento_estorno_id) REFERENCES pagamentos (id),
  CONSTRAINT fk_estorno_usuario
    FOREIGN KEY (registrado_por) REFERENCES usuarios (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
