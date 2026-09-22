# Integração WBuy e transição Bling

## Estado implementado

A Central MyKey precisa saber qual serviço interno corresponde a cada produto
vendido externamente. A tabela `integracao_produto_mapeamentos` mantém vínculos
por provedor, ID externo e/ou SKU. As rotas administrativas permitem listar,
criar, atualizar, ativar e desativar vínculos, sempre com auditoria. A interface
fica em **Administração → Integrações**.

O mesmo catálogo atende WBuy e Bling durante a transição e impede que cada
adaptador mantenha uma classificação diferente para o mesmo produto.

## WBuy

A integração REST usa usuário e senha gerados em **Plataforma → APIs e
Webhooks**. A URL da loja não participa da autenticação. A Central consulta um
pedido específico no endpoint oficial, guarda snapshots idempotentes por ID e
conteúdo e mostra a operação na fila administrativa sem expor o payload.

Cada sincronização também produz uma análise sem efeitos comerciais: conserva o
status e o valor como dados externos brutos, resolve produto/SKU contra
`integracao_produto_mapeamentos` e informa vínculos ausentes ou conflitantes. A
análise nunca declara o pedido pronto para conversão enquanto faltarem a fonte
de autoridade, o mapeamento de status de pagamento, a moeda e a correspondência
entre cliente, comprador e pagador.

A documentação pública confirma webhooks `order` e `order_status`, mas não
define uma assinatura verificável. Por isso nenhum endpoint público WBuy foi
ativado. A entrada atual é uma ação administrativa autenticada que consulta o
registro canônico pela API REST.

## Bling

O mapeamento de produtos já é compartilhado e o receptor de webhooks valida a
assinatura HMAC oficial e guarda eventos `order.*` idempotentes. OAuth, leitura
detalhada, exportação de resultados e autoridade de status ainda não estão
implementados.
Durante a transição, cada entidade deverá ter uma fonte de verdade explícita
para evitar atualizações circulares entre WBuy, Bling e Central MyKey.

## Referências oficiais

- [WBuy: integração REST e webhooks com Bling](https://ajuda.wbuy.com.br/personalizador-de-produtos/bling-nativo)
- [WBuy: criação de credenciais REST](https://ajuda.wbuy.com.br/combos-de-produtos/sak)
