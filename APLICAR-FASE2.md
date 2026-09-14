# Fase 2 — fluxo completo do banco de senhas

## Conteúdo

- Pedido faturado consulta produto + final 8 antes do fornecedor.
- Conflitos ficam em `AGUARDANDO_DADOS`.
- Pedido encaminhado ao fornecedor fica em `EM_CONSULTA`.
- Resultado externo confirmado preserva sua origem e fornecedor históricos.
- Resultado sem código técnico não pode ser cadastrado como encontrado.
- Placas somem da interface e gatilhos do banco impedem persistência por rotas legadas.

## Ordem

1. Extrair sobre `/opt/centralmykey-source` na branch `feature/fluxo-banco-completo`.
2. Validar backend, lint e build.
3. Commit e push da branch.
4. Copiar os arquivos versionados para produção.
5. Executar `api/migrations/20260914_proibir_placas.sql` com `multipleStatements`.
6. Reiniciar API, publicar frontend e executar testes transacionais.

## Rollback

Use a tag `baseline-20260914` para restaurar código. Os gatilhos podem ser removidos com `DROP TRIGGER IF EXISTS` para cada nome presente na migração. As placas anteriores já estavam zeradas e permanecem protegidas pelo backup do banco.
