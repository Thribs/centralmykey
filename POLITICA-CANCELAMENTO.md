# Cancelamento de pedidos

O código posterior à `v0.5.0` permite cancelar apenas pedidos sem obrigação externa pendente. A operação é transacional, exige motivo, registra histórico e auditoria e pode ser repetida sem duplicar efeitos.

## Cancelamento permitido

- pedido ainda não concluído;
- nenhum pagamento ou lançamento liquidado sem estorno confirmado ligado ao pedido;
- nenhuma consulta ao fornecedor enviada, em processamento ou com resultado incerto;
- item de faturamento semanal, quando existente, ainda pertence a uma fatura `ABERTA`.

Ao cancelar, a Central também muda referências de pagamento `PREPARADA` ou
`REGISTRADA` para `CANCELADA`. Isso encerra a cobrança no estado local e grava a
quantidade no histórico e na auditoria do pedido. O cancelamento remoto no
provedor continua dependendo do contrato homologado; se um pagamento externo
for confirmado depois do cancelamento, o evento fica `FALHOU` com
`PEDIDO_NAO_AGUARDA_PAGAMENTO`, sem criar receita, pagamento ou reabrir o pedido.

Nesses casos, o sistema cancela comunicações pendentes, remove o item da fatura aberta, recalcula o total a partir dos itens restantes, cancela a fatura que ficar vazia e zera fornecedor, origem e custo do pedido. O valor armazenado anteriormente na fatura não é usado como base da reconciliação.

## Pagamento manual já recebido

Quando o operador já devolveu integralmente o valor ao cliente, a interface pode
registrar o estorno e cancelar o pedido em uma única transação. O registro exige
meio, motivo e referência ou comprovante, exceto para dinheiro. O sistema:

1. mantém a receita original para preservar o histórico de entrada;
2. cria uma despesa paga de mesmo valor com origem `ESTORNO_MANUAL`;
3. vincula o pagamento original, a saída e o pedido em `estornos_pagamentos`;
4. registra histórico e auditoria;
5. executa o cancelamento somente se todas as demais regras permitirem.

Se o fornecedor já pode ter recebido a consulta, se a fatura exige ajuste ou se
qualquer outra regra bloquear o cancelamento, o estorno criado na tentativa é
revertido junto com toda a transação. Repetir a mesma confirmação é idempotente;
uma confirmação divergente é recusada.

Essa operação documenta uma devolução já realizada. Ela não envia PIX, não faz
estorno automático em adquirente e não movimenta uma conta bancária.

## Bloqueios deliberados

- `ESTORNO_FINANCEIRO_NECESSARIO`: há pagamento sem estorno confirmado;
- `CUSTO_FORNECEDOR_REQUER_DECISAO`: o fornecedor pode ter recebido a consulta e o custo precisa ser resolvido;
- `FATURA_REQUER_AJUSTE`: a fatura já foi fechada ou paga;
- `PEDIDO_JA_CONCLUIDO`: o resultado já foi concluído e exige fluxo de devolução.

Esses bloqueios evitam zerar receita ou custo sem comprovação. Ainda falta definir com Joel a automação do estorno em cada meio de pagamento, quem absorve o custo do fornecedor e como tratar devolução após entrega. Até essas regras existirem, não deve haver alteração manual direta no banco.
