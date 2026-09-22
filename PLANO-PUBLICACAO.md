# Plano de publicação interna

Este plano prepara a primeira publicação posterior à `v0.4.1`. Ele não ativa
WhatsApp, Sicoob, PlugPay, WBuy ou Bling e não altera o ambiente configurado da
API Joel Pires. A publicação só deve ocorrer depois da apresentação do diff e
da aprovação dos testes.

## Estado comprovado

- A produção permanece na `v0.4.1`, com o serviço ativo e `/health` HTTP 200.
- As nove migrações adicionadas depois da tag ainda não estão aplicadas no
  banco publicado.
- `api/validar-migracoes-descartaveis.js` copia somente a estrutura atual para
  uma instância MySQL local sem rede, aplica as nove migrações duas vezes,
  verifica dez tabelas, comprova o backfill das três partes de um pedido
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
7. aplicação das nove migrações;
8. cópia local dos artefatos, preservando `.env` e `storage`;
9. reinício e validação de `/health` e `/health/ready`.

Qualquer falha depois da parada ou da primeira migração aciona a restauração
automática do backup integral, reinicia o serviço e exige `/health` válido. O
backup é preservado mesmo quando a publicação termina com sucesso.

## Limites desta publicação

- Transportes e webhooks externos continuam desabilitados até homologação.
- Não será criada tag enquanto a publicação e os testes pós-publicação não
  estiverem concluídos.
- O timer de backup não será instalado nesta publicação sem aprovação própria.
- A restauração integral já foi ensaiada em uma instância MySQL descartável,
  sem acessar produção; o timer ainda exige instalação e observação separadas.
