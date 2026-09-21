# Integrações externas

A tela de integrações distingue credenciais cadastradas de conectores realmente
implementados. Os estados exibidos são:

- `CONFIGURADO`: conector implementado, requisitos preenchidos e habilitado;
- `CONFIGURADO_DESABILITADO`: conector implementado e configurado, com o worker
  operacional desligado;
- `PARCIAL`: somente parte dos requisitos foi preenchida;
- `CREDENCIAIS_SEM_CONECTOR`: há credenciais, mas ainda não existe integração;
- `PENDENTE`: não há configuração suficiente.

Valores do ambiente têm precedência sobre a tabela `configuracoes`. A API usa a
mesma resolução para o painel, envio de mensagens, verificação do webhook,
processamento da outbox, download e limpeza de mídia. O resumo administrativo
retorna apenas estados booleanos; nunca retorna tokens, segredos ou chaves.

## WhatsApp

O código cobre envio de texto e modelos, assinatura do webhook da Meta,
mensagens recebidas, estados de entrega, mídia privada e outbox idempotente para
fornecedores e clientes. O worker só envia quando
`COMUNICACOES_OUTBOX_HABILITADO` está ativo. A ativação em ambiente real exige
modelos aprovados, contatos revisados e homologação controlada conforme
`ATIVAR-COMUNICACOES-FORNECEDORES.md`.

## API Joel Pires

O conector está implementado para o fluxo GM, com cache local, classificação de
erros e reprocessamento. A ampliação para outros produtos depende dos contratos
de cada consulta.

## Sicoob, PlugPay, WBuy e Bling

Esses conectores ainda não estão implementados. Cadastrar credenciais não muda
esse estado e não confirma pagamentos ou importa pedidos. Antes de desenvolver
cada adaptador, é necessário identificar o produto/conta exato, obter a
documentação oficial e mapear identificadores externos para pedidos, clientes,
faturas, pagamentos e estornos da Central MyKey.
