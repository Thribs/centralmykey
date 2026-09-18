# Central MyKey — regras permanentes de desenvolvimento e operação

## Escopo e ambientes

- Repositório e fonte versionada: `/opt/centralmykey-source`.
- API publicada: `/opt/central-mykey-api`.
- Frontend publicado: `/opt/central-mykey-web`.
- Serviço da API: `central-mykey-api.service`.
- Repositório remoto: `Thribs/centralmykey`.
- Autor Git: `thribs-rodolfo <thribs-rodolfo@users.noreply.github.com>`.
- Baseline validada em 2026-09-18: `main` no commit `065ea3e`, tag `v0.4.1`.

O repositório é a fonte das alterações. Nunca desenvolver diretamente nos diretórios publicados. Antes de iniciar trabalho, inspecionar o estado do Git, preservar modificações existentes e criar uma branch. Nunca usar `git reset --hard`.

## Segurança e configuração

- Nunca exibir, registrar, copiar para documentação ou versionar valores de `.env`, chaves, senhas ou tokens.
- O ambiente atual da API Joel Pires é staging (`teste` na configuração existente).
- `ID_USUARIO_API_JOELPIRES` deve vir exclusivamente do `.env`.
- O dispositivo da integração é `centralmykey`.
- Nunca enviar nem criar `ID_TRANSACAO`; a API Joel Pires gera a transação.
- Não usar dados reais para testes e não alterar registros reais para preparar cenários.

## Fonte de verdade e fluxo GM

A API Joel Pires é a fonte de verdade das senhas. O banco local armazena somente cache de respostas dessa API; entradas de outras origens não substituem a consulta à fonte de verdade.

O fluxo GM obrigatório é:

1. Consultar o cache local da API Joel Pires.
2. Se não houver entrada válida, consultar a API Joel Pires.
3. Quando houver resultado, concluir automaticamente o pedido e alimentar ou atualizar o cache local.
4. Tratar HTTP 404 com `SenhaNotFoundError` como `NAO_ENCONTRADO` e então encaminhar ao fornecedor GM disponível.
5. Tratar HTTP 400, 417 e 422 como `DADOS_INVALIDOS`: manter o pedido em `AGUARDANDO_DADOS` e não acionar fornecedor.
6. Em indisponibilidade real da API, manter o pedido aguardando reprocessamento e não acionar fornecedor.
7. Selecionar o fornecedor ativo e disponível de menor custo: Márcio das 08h às 22h, custo R$ 22; Emerson das 08h às 19h, custo R$ 25.

Qualquer mudança nesse fluxo deve manter as transições, o histórico e os lançamentos financeiros consistentes e idempotentes.

## Testes e banco de dados

- Testes nunca podem deixar pedidos, resultados, históricos, cache temporário ou lançamentos financeiros persistidos.
- Todo teste que acessar banco deve abrir transação e executar rollback em bloco `finally`, inclusive quando houver falha.
- Preferir mocks para classificação de respostas da API, seleção de fluxo e erros de comunicação.
- Nunca executar scripts de integração contra dados reais sem antes confirmar que todas as escritas estão contidas na mesma transação reversível.

## Validação e publicação

Antes de publicar:

1. Revisar o diff e confirmar que nenhuma alteração existente foi sobrescrita.
2. Validar sintaxe da API, testes, lint e build do frontend.
3. Validar qualquer migração em transação ou ambiente descartável.
4. Obter aprovação dos testes e do plano de publicação.
5. Criar backup datado dos artefatos publicados que serão substituídos.

Na publicação, executar passos grandes diretamente no VPS e evitar transferências por SCP. Publicar apenas os artefatos aprovados. Depois, validar o estado do systemd e o endpoint `/health`. Se cópia, build, reinício, systemd ou health falhar, restaurar automaticamente o backup e validar novamente serviço e health.

Commits e tags só podem ser criados depois de todas as validações aplicáveis passarem. Não criar tag para estado não publicado ou parcialmente validado.

Ao concluir, relatar objetivamente: branch e arquivos alterados, validações executadas, resultado da publicação, versão/commit efetivos e qualquer risco ou lacuna encontrada.
