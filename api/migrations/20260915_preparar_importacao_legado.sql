-- Migração executada uma única vez.
-- Não reexecutar sem consultar o controle schema_migrations.
CREATE TABLE IF NOT EXISTS montadoras (
  id INT NOT NULL,
  nome VARCHAR(100) NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_montadoras_nome (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO montadoras (id, nome, ativo) VALUES
  (1, 'GM', 1),
  (2, 'KIA e Hyundai', 1),
  (3, 'Peugeot e Citroen', 1),
  (4, 'Fiat', 1),
  (5, 'Nissan', 1),
  (6, 'Chrysler, Dodge e Jeep', 1),
  (7, 'Audi', 1),
  (8, 'BMW', 1),
  (9, 'Chery', 1),
  (10, 'Ford', 1),
  (11, 'Honda', 1),
  (12, 'Hyundai', 1),
  (13, 'JAC Motors', 1),
  (14, 'Kia', 1),
  (15, 'Mitsubishi', 1),
  (16, 'Toyota', 1),
  (17, 'Volkswagen', 1),
  (18, 'Jaguar', 1),
  (19, 'Suzuki', 1),
  (20, 'Ssangyong', 1),
  (21, 'Land Rover', 1),
  (22, 'Chrysler', 1),
  (23, 'Alfa Romeo', 1),
  (24, 'Peugeot', 1),
  (25, 'Citroen', 1),
  (26, 'Infiniti', 1),
  (27, 'Jeep', 1),
  (28, 'Dodge', 1),
  (29, 'Kawasaki Motos', 1),
  (30, 'Honda motos', 1),
  (31, 'Iveco', 1),
  (32, 'Lexus', 1),
  (33, 'Lincoln', 1),
  (34, 'Mazda', 1),
  (36, 'Hummer', 1),
  (39, 'MAN Caminhões', 1),
  (40, 'Porsche', 1),
  (41, 'Seat', 1),
  (42, 'Mercedes Benz', 1),
  (43, 'Mercedes Benz Caminhões', 1),
  (44, 'Renault', 1),
  (45, 'Scania Caminhões', 1),
  (46, 'Volvo', 1),
  (47, 'Volkswagen Caminhões', 1),
  (48, 'Yamaha', 1),
  (49, 'thule', 1)
ON DUPLICATE KEY UPDATE
  nome = VALUES(nome),
  ativo = VALUES(ativo);

ALTER TABLE banco_senhas
  ADD COLUMN montadora_id INT NULL
    AFTER marca,
  ADD COLUMN fonte_importacao VARCHAR(40) NULL
    AFTER dados_extras,
  ADD COLUMN legado_id BIGINT NULL
    AFTER fonte_importacao,
  ADD COLUMN classificacao_importacao VARCHAR(40) NULL
    AFTER legado_id;


ALTER TABLE banco_senhas
  ADD UNIQUE KEY uk_banco_senhas_fonte_legado
    (fonte_importacao, legado_id);

CREATE TABLE IF NOT EXISTS importacoes_banco_senhas (
  id BIGINT NOT NULL AUTO_INCREMENT,
  fonte VARCHAR(40) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDENTE',
  ultimo_id_origem BIGINT NOT NULL DEFAULT 0,
  total_processado BIGINT NOT NULL DEFAULT 0,
  total_importado BIGINT NOT NULL DEFAULT 0,
  total_ativo BIGINT NOT NULL DEFAULT 0,
  total_quarentena BIGINT NOT NULL DEFAULT 0,
  erro TEXT NULL,
  iniciado_em DATETIME NULL,
  finalizado_em DATETIME NULL,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_importacoes_fonte (fonte)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conflitos_banco_senhas_legado (
  id_montadora INT NOT NULL,
  chave_consulta VARCHAR(30) NOT NULL,
  tipo_chave VARCHAR(20) NOT NULL,
  quantidade BIGINT NOT NULL,
  quantidade_assinaturas BIGINT NOT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_montadora, tipo_chave, chave_consulta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO importacoes_banco_senhas (
  fonte,
  status,
  ultimo_id_origem
)
VALUES (
  'SENHAS_CHASSIS',
  'PENDENTE',
  0
)
ON DUPLICATE KEY UPDATE
  fonte = VALUES(fonte);
