ALTER TABLE comunicacoes_outbox
  MODIFY COLUMN destinatario VARCHAR(255) DEFAULT NULL;
