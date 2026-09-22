# Registro da publicação interna

Este plano registrou a primeira publicação posterior à `v0.4.1`. Ele não ativou
WhatsApp, Sicoob, PlugPay, WBuy ou Bling e não altera o ambiente configurado da
API Joel Pires. A publicação só deve ocorrer depois da apresentação do diff e
da aprovação dos testes.

## Estado comprovado

- O commit `5214833` foi publicado em 22/09/2026, sem merge ou nova tag, com o
  serviço ativo e `/health` e `/health/ready` HTTP 200.
- A publicação criou e verificou o backup integral
  `/opt/centralmykey-backups/20260922T025627Z`. O diagnóstico de prontidão do
  WhatsApp GM ficou disponível na Administração sem habilitar o worker nem
  enviar mensagens.
- A publicação do monitoramento de backup criou e verificou o pacote integral
  `/opt/centralmykey-backups/20260922T030352Z`. A verificação pós-publicação
  classificou o pacote como `OK`, confirmou os hashes e encontrou zero alerta
  de backup ativo.
- A publicação da cópia externa criou e verificou o pacote integral
  `/opt/centralmykey-backups/20260922T031056Z`. Como não existe volume externo
  montado, nenhum arquivo saiu do VPS; o monitoramento registrou uma única
  atenção `NAO_CONFIGURADO`, sem caminho ou credencial na notificação.
- A publicação da matriz de autoridade criou e verificou o backup
  `/opt/centralmykey-backups/20260922T031849Z`, aplicou dez migrações e confirmou
  onze tabelas. A tabela da matriz foi publicada vazia, com zero auditorias:
  nenhuma decisão de Joel foi inferida.
- A instalação publicada usa `qs 6.16.0` e `npm audit --omit=dev` informa zero
  vulnerabilidades conhecidas.
- As onze migrações adicionadas depois da tag estão aplicadas e as doze tabelas
  esperadas foram verificadas.
- `api/validar-migracoes-descartaveis.js` copia somente a estrutura atual para
  uma instância MySQL local sem rede, aplica as onze migrações duas vezes,
  verifica doze tabelas, comprova o backfill das três partes de um pedido
  inteiramente sintético e apaga integralmente a instância.
- A validação descartável não lê linhas de negócio e não grava no banco real.

Ela pode ser repetida isoladamente com `cd api && npm run test:migrations`.

## Migrações da publicação

1. `20260918_comunicacoes_outbox.sql`
2. `20260919_estornos_pagamentos.sql`
3. `20260919_fechamentos_fornecedores.sql`
4. `20260919_notificacoes_internas.sql`
5. `20260920_eventos_integracoes.sql`
6. `20260920_partes_pedido.sql`
7. `20260921_mapeamentos_produtos_externos.sql`
8. `20260921_referencias_pagamento.sql`
9. `20260921_identidade_cache_joelpires.sql`
10. `20260922_autoridades_integracoes.sql`
11. `20260922_status_integracoes.sql`

Todas usam criação idempotente. A migração de partes usa `INSERT IGNORE` no
preenchimento inicial. A dupla aplicação no MySQL descartável comprova que uma
execução interrompida pode ser retomada.

## Procedimento preparado

Sem argumento, o comando abaixo apenas descreve o procedimento e não altera o
servidor:

```bash
cd /opt/centralmykey-source
deploy/publicar-centralmykey.sh
```

Após aprovação explícita do commit e do plano, a execução autorizada será:

```bash
cd /opt/centralmykey-source
deploy/publicar-centralmykey.sh --confirmar-publicacao
```

O script recusa working tree sujo e executa, nesta ordem:

1. suíte completa da API;
2. lint, testes e build do frontend;
3. validação dupla das migrações em MySQL descartável;
4. preparação local da API e do frontend fora dos diretórios publicados;
5. backup integral verificado da API, frontend e banco;
6. parada do serviço;
7. aplicação das onze migrações;
8. cópia local dos artefatos, preservando `.env` e `storage`, e atualização do
   frontend efetivamente servido pelo Nginx em `/var/www/central-mykey-test`;
9. reinício e validação de `/health`, `/health/ready` e dos artefatos públicos.

Qualquer falha depois da parada ou da primeira migração aciona a restauração
automática do backup integral, reinicia o serviço e exige `/health` válido. O
backup é preservado mesmo quando a publicação termina com sucesso.

## Limites desta publicação

- Transportes e webhooks externos continuam desabilitados até homologação.
- Não será criada tag enquanto a publicação e os testes pós-publicação não
  estiverem concluídos.
- O timer de backup foi instalado, habilitado e teve a primeira execução
  observada com sucesso em 21/09/2026.
- A restauração integral já foi ensaiada em uma instância MySQL descartável,
  sem acessar produção; a primeira execução real também produziu e verificou
  quatro artefatos no formato 2.
