# Fechamento semanal de fornecedores

## Regra operacional

O período semanal começa na segunda-feira e termina no domingo. A interface gera
sempre a última semana já concluída. Um fechamento pode ser preparado como
rascunho antes do fim do período, mas só pode ser aprovado a partir da
segunda-feira seguinte.

Entram no fechamento somente resultados:

- confirmados pelo operador;
- vinculados ao fornecedor do fechamento;
- com custo maior que zero;
- recebidos dentro do período, pela data de criação do resultado;
- pertencentes a pedidos não cancelados e na mesma moeda do fechamento.

Cada resultado pode pertencer a um único fechamento. Enquanto o fechamento está
em `RASCUNHO`, uma nova geração recalcula os itens e o total. Depois da aprovação,
o conteúdo fica imutável.

## Estados e financeiro

1. `RASCUNHO`: apuração disponível para conferência.
2. `FECHADO`: aprovação concluída e uma despesa `PENDENTE` criada no financeiro.
3. `PAGO`: pagamento manual registrado, despesa marcada como paga e auditoria
   gravada.
4. `CANCELADO`: reservado no modelo; ainda não há operação de cancelamento do
   fechamento.

A aprovação e o pagamento são idempotentes. Repetir a mesma confirmação de
pagamento não cria outro registro. Uma confirmação divergente é rejeitada.

O registro de pagamento apenas documenta uma transferência já realizada. Esta
etapa não executa PIX nem movimenta conta bancária automaticamente.

## Implantação

A funcionalidade depende da migração
`api/migrations/20260919_fechamentos_fornecedores.sql`. A migração e os arquivos
da aplicação devem ser publicados juntos, seguindo backup, validação, reinício e
health check previstos no `AGENTS.md`.

O teste `api/teste-fechamento-fornecedor.js` usa MySQL real dentro de uma
transação externa e sempre executa rollback. Ele cobre apuração, listagem,
detalhamento, aprovação, pagamento, repetição idempotente, bloqueio de período
aberto e ausência de resíduos permanentes.
