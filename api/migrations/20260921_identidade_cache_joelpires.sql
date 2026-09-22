SET @centralmykey_schema = DATABASE();

SET @centralmykey_sql = IF(
  EXISTS(
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = @centralmykey_schema
       AND table_name = 'banco_senhas'
       AND column_name = 'cache_fonte'
  ),
  'SELECT 1',
  'ALTER TABLE banco_senhas ADD COLUMN cache_fonte VARCHAR(40) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(dados_extras, ''$.fonte''))) STORED'
);
PREPARE centralmykey_stmt FROM @centralmykey_sql;
EXECUTE centralmykey_stmt;
DEALLOCATE PREPARE centralmykey_stmt;

SET @centralmykey_sql = IF(
  EXISTS(
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = @centralmykey_schema
       AND table_name = 'banco_senhas'
       AND column_name = 'cache_api_senha_id'
  ),
  'SELECT 1',
  'ALTER TABLE banco_senhas ADD COLUMN cache_api_senha_id VARCHAR(160) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(dados_extras, ''$.api_senha_id''))) STORED'
);
PREPARE centralmykey_stmt FROM @centralmykey_sql;
EXECUTE centralmykey_stmt;
DEALLOCATE PREPARE centralmykey_stmt;

SET @centralmykey_sql = IF(
  EXISTS(
    SELECT 1
      FROM information_schema.statistics
     WHERE table_schema = @centralmykey_schema
       AND table_name = 'banco_senhas'
       AND index_name = 'uk_banco_senhas_cache_api'
  ),
  'SELECT 1',
  'ALTER TABLE banco_senhas ADD UNIQUE KEY uk_banco_senhas_cache_api (cache_fonte, cache_api_senha_id)'
);
PREPARE centralmykey_stmt FROM @centralmykey_sql;
EXECUTE centralmykey_stmt;
DEALLOCATE PREPARE centralmykey_stmt;
