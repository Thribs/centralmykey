CREATE TABLE IF NOT EXISTS integracao_oauth_estados (
  id BIGINT NOT NULL AUTO_INCREMENT,
  provedor ENUM('BLING') NOT NULL,
  state_hash CHAR(64) NOT NULL,
  usuario_id BIGINT DEFAULT NULL,
  expira_em DATETIME NOT NULL,
  usado_em DATETIME DEFAULT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_integracao_oauth_state (provedor, state_hash),
  KEY idx_integracao_oauth_estado (provedor, expira_em, usado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS integracao_oauth_tokens (
  provedor ENUM('BLING') NOT NULL,
  access_token_cifrado MEDIUMTEXT NOT NULL,
  refresh_token_cifrado MEDIUMTEXT NOT NULL,
  token_tipo VARCHAR(40) NOT NULL DEFAULT 'Bearer',
  escopos TEXT DEFAULT NULL,
  access_expira_em DATETIME NOT NULL,
  refresh_expira_em DATETIME NOT NULL,
  atualizado_por BIGINT DEFAULT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (provedor),
  KEY idx_integracao_oauth_expiracao (access_expira_em, refresh_expira_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
