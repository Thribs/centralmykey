'use strict';

async function criarTabelasNotificacoesTemporarias(connection) {
  await connection.query(
    `CREATE TEMPORARY TABLE notificacoes (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       chave VARCHAR(190) NOT NULL UNIQUE,
       tipo VARCHAR(60) NOT NULL,
       nivel ENUM('INFO','ATENCAO','CRITICA') NOT NULL DEFAULT 'INFO',
       modulo VARCHAR(60) NULL,
       usuario_destino_id BIGINT NULL,
       titulo VARCHAR(160) NOT NULL,
       mensagem VARCHAR(500) NOT NULL,
       entidade VARCHAR(80) NULL,
       entidade_id VARCHAR(80) NULL,
       dados JSON NULL,
       status ENUM('ATIVA','RESOLVIDA') NOT NULL DEFAULT 'ATIVA',
       criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ON UPDATE CURRENT_TIMESTAMP,
       resolvido_em DATETIME NULL
     ) ENGINE=InnoDB`
  );
  await connection.query(
    `CREATE TEMPORARY TABLE notificacao_leituras (
       notificacao_id BIGINT NOT NULL,
       usuario_id BIGINT NOT NULL,
       lida_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (notificacao_id, usuario_id)
     ) ENGINE=InnoDB`
  );
}

module.exports = { criarTabelasNotificacoesTemporarias };
