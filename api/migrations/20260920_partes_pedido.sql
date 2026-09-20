CREATE TABLE IF NOT EXISTS pedido_partes (
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
  UNIQUE KEY uk_pedido_parte_papel (pedido_id, papel),
  KEY idx_pedido_parte_cliente (cliente_id),
  CONSTRAINT fk_pedido_parte_pedido
    FOREIGN KEY (pedido_id) REFERENCES pedidos_senha (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pedido_parte_cliente
    FOREIGN KEY (cliente_id) REFERENCES clientes (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO pedido_partes
  (pedido_id, papel, cliente_id, nome, documento, telefone, email)
SELECT
  p.id,
  papeis.papel,
  c.id,
  c.nome,
  COALESCE(c.cpf, c.cnpj),
  COALESCE(c.telefone_normalizado, c.telefone),
  c.email
FROM pedidos_senha p
INNER JOIN clientes c ON c.id = p.cliente_id
CROSS JOIN (
  SELECT 'CLIENTE' AS papel
  UNION ALL SELECT 'COMPRADOR'
  UNION ALL SELECT 'PAGADOR'
) papeis;
