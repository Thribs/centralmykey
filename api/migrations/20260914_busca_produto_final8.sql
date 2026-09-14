START TRANSACTION;

UPDATE banco_senhas
SET tipo = 'GM_SENHA'
WHERE tipo = 'SENHA'
  AND UPPER(TRIM(marca)) = 'GM';

UPDATE banco_senhas
SET placa = NULL
WHERE placa IS NOT NULL;

UPDATE pedidos_senha
SET placa = NULL
WHERE placa IS NOT NULL;

ALTER TABLE banco_senhas
  ADD INDEX idx_banco_tipo_chassi_invertido_ativo
    (tipo, chassi_invertido, ativo);

COMMIT;
