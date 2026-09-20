CREATE TABLE IF NOT EXISTS notificacoes (
  id BIGINT NOT NULL AUTO_INCREMENT,
  chave VARCHAR(190) NOT NULL,
  tipo VARCHAR(60) NOT NULL,
  nivel ENUM('INFO','ATENCAO','CRITICA') NOT NULL DEFAULT 'INFO',
  modulo VARCHAR(60) DEFAULT NULL,
  usuario_destino_id BIGINT DEFAULT NULL,
  titulo VARCHAR(160) NOT NULL,
  mensagem VARCHAR(500) NOT NULL,
  entidade VARCHAR(80) DEFAULT NULL,
  entidade_id VARCHAR(80) DEFAULT NULL,
  dados JSON DEFAULT NULL,
  status ENUM('ATIVA','RESOLVIDA') NOT NULL DEFAULT 'ATIVA',
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  resolvido_em DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_notificacao_chave (chave),
  KEY idx_notificacao_fila (status, nivel, atualizado_em),
  KEY idx_notificacao_modulo (modulo, status),
  KEY idx_notificacao_destino (usuario_destino_id, status),
  CONSTRAINT fk_notificacao_usuario_destino
    FOREIGN KEY (usuario_destino_id) REFERENCES usuarios (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notificacao_leituras (
  notificacao_id BIGINT NOT NULL,
  usuario_id BIGINT NOT NULL,
  lida_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notificacao_id, usuario_id),
  KEY idx_notificacao_leitura_usuario (usuario_id, lida_em),
  CONSTRAINT fk_notificacao_leitura_notificacao
    FOREIGN KEY (notificacao_id) REFERENCES notificacoes (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_notificacao_leitura_usuario
    FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
