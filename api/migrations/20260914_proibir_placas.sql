UPDATE banco_senhas SET placa = NULL WHERE placa IS NOT NULL;
UPDATE pedidos_senha SET placa = NULL WHERE placa IS NOT NULL;

DROP TRIGGER IF EXISTS trg_banco_senhas_sem_placa_insert;
CREATE TRIGGER trg_banco_senhas_sem_placa_insert
BEFORE INSERT ON banco_senhas FOR EACH ROW SET NEW.placa = NULL;

DROP TRIGGER IF EXISTS trg_banco_senhas_sem_placa_update;
CREATE TRIGGER trg_banco_senhas_sem_placa_update
BEFORE UPDATE ON banco_senhas FOR EACH ROW SET NEW.placa = NULL;

DROP TRIGGER IF EXISTS trg_pedidos_senha_sem_placa_insert;
CREATE TRIGGER trg_pedidos_senha_sem_placa_insert
BEFORE INSERT ON pedidos_senha FOR EACH ROW SET NEW.placa = NULL;

DROP TRIGGER IF EXISTS trg_pedidos_senha_sem_placa_update;
CREATE TRIGGER trg_pedidos_senha_sem_placa_update
BEFORE UPDATE ON pedidos_senha FOR EACH ROW SET NEW.placa = NULL;
