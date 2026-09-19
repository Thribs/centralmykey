CREATE TABLE IF NOT EXISTS comunicacoes_outbox (
  id BIGINT NOT NULL AUTO_INCREMENT,
  chave_idempotencia VARCHAR(190) NOT NULL,
  canal ENUM('WHATSAPP') NOT NULL,
  finalidade ENUM('CONSULTA_FORNECEDOR','ENTREGA_CLIENTE') NOT NULL,
  pedido_id BIGINT NOT NULL,
  resultado_id BIGINT DEFAULT NULL,
  fornecedor_id BIGINT DEFAULT NULL,
  destinatario VARCHAR(25) DEFAULT NULL,
  payload JSON NOT NULL,
  status ENUM(
    'PENDENTE',
    'PROCESSANDO',
    'ENVIADA',
    'ENTREGUE',
    'LIDA',
    'FALHOU',
    'INCERTA',
    'CANCELADA'
  ) NOT NULL DEFAULT 'PENDENTE',
  tentativas INT NOT NULL DEFAULT 0,
  processar_apos DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  mensagem_externa_id VARCHAR(150) DEFAULT NULL,
  erro_codigo VARCHAR(80) DEFAULT NULL,
  erro_detalhe VARCHAR(500) DEFAULT NULL,
  enviado_em DATETIME DEFAULT NULL,
  entregue_em DATETIME DEFAULT NULL,
  lida_em DATETIME DEFAULT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_comunicacao_idempotencia (chave_idempotencia),
  KEY idx_comunicacao_fila (status, processar_apos, id),
  KEY idx_comunicacao_pedido (pedido_id, id),
  KEY idx_comunicacao_resultado (resultado_id, id),
  KEY idx_comunicacao_fornecedor (fornecedor_id, id),
  CONSTRAINT fk_comunicacao_pedido
    FOREIGN KEY (pedido_id) REFERENCES pedidos_senha (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_comunicacao_resultado
    FOREIGN KEY (resultado_id) REFERENCES pedido_resultados (id)
    ON DELETE SET NULL,
  CONSTRAINT fk_comunicacao_fornecedor
    FOREIGN KEY (fornecedor_id) REFERENCES fornecedores (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
