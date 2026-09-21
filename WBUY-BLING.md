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

A ajuda oficial informa que a integração REST usa usuário e senha gerados em
**Plataforma → APIs e Webhooks**, além da URL da loja. Também confirma webhooks
`order` para criação e `order_status` para mudança de status.

A documentação pública localizada não define o esquema integral desses
payloads nem uma assinatura verificável. Por isso nenhum endpoint público WBuy
foi ativado. O próximo passo requer documentação privada da conta ou uma entrega
controlada de webhook para definir o normalizador sem inferir campos financeiros
ou identidades.

## Bling

O mapeamento de produtos já é compartilhado, mas OAuth, importação de pedidos,
exportação de resultados e autoridade de status ainda não estão implementados.
Durante a transição, cada entidade deverá ter uma fonte de verdade explícita
para evitar atualizações circulares entre WBuy, Bling e Central MyKey.

## Referências oficiais

- [WBuy: integração REST e webhooks com Bling](https://ajuda.wbuy.com.br/personalizador-de-produtos/bling-nativo)
- [WBuy: criação de credenciais REST](https://ajuda.wbuy.com.br/combos-de-produtos/sak)
