UPDATE banco_senhas
SET placa = NULL
WHERE placa IS NOT NULL;

UPDATE pedidos_senha
SET placa = NULL
WHERE placa IS NOT NULL;

ALTER TABLE banco_senhas
  ADD CONSTRAINT chk_banco_senhas_placa_nula
  CHECK (placa IS NULL);

ALTER TABLE pedidos_senha
  ADD CONSTRAINT chk_pedidos_senha_placa_nula
  CHECK (placa IS NULL);
