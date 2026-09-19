'use strict';

async function criarTabelaOutboxTemporaria(connection) {
  await connection.query(
    `CREATE TEMPORARY TABLE comunicacoes_outbox (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       chave_idempotencia VARCHAR(190) NOT NULL UNIQUE,
       canal ENUM('WHATSAPP') NOT NULL,
       finalidade ENUM('CONSULTA_FORNECEDOR','ENTREGA_CLIENTE') NOT NULL,
       pedido_id BIGINT NOT NULL,
       fornecedor_id BIGINT NULL,
       destinatario VARCHAR(25) NULL,
       payload JSON NOT NULL,
       status ENUM('PENDENTE','PROCESSANDO','ENVIADA','FALHOU','INCERTA','CANCELADA')
         NOT NULL DEFAULT 'PENDENTE',
       tentativas INT NOT NULL DEFAULT 0,
       processar_apos DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       mensagem_externa_id VARCHAR(150) NULL,
       erro_codigo VARCHAR(80) NULL,
       erro_detalhe VARCHAR(500) NULL,
       enviado_em DATETIME NULL,
       criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         ON UPDATE CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`
  );
}

module.exports = { criarTabelaOutboxTemporaria };
