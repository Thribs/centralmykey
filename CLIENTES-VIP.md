# Clientes e plano VIP

O cadastro de clientes mantém identidade, contato, situação cadastral, cobrança,
crédito e estado ativo. Telefone, CPF e CNPJ são normalizados e não podem se
repetir. Criação, edição, bloqueio, reativação e mudanças no plano VIP geram
registros na auditoria.

O faturamento semanal usa **dia da semana**, de 0 (domingo) a 6 (sábado), e
prazo de pagamento entre 0 e 60 dias. A semana da fatura termina no próximo dia
de fechamento, incluindo o próprio dia quando o pedido é criado nele, começa
seis dias antes e vence após o prazo configurado. No modo antecipado, dia de
fechamento e prazo semanal são removidos.

Pedidos usam `preco_vip` somente quando o plano está `ATIVO` e o próximo
vencimento é nulo ou ainda não passou. Um plano vencido usa `preco_base` mesmo
antes da reconciliação administrativa do estado, e o pedido registra a tabela
de preço aplicada.

O limite de crédito é cadastrado e exibido, mas ainda não bloqueia pedidos. A
política precisa definir quais faturas entram no saldo e como comparar serviços
em BRL, USD e PYG antes dessa automação ser ativada.

Cada cliente pode ter um único plano VIP. Os estados disponíveis são:

- `ATIVO`;
- `AGUARDANDO_PAGAMENTO`;
- `VENCIDO`;
- `SUSPENSO`;
- `CANCELADO`.

A mensalidade precisa ser maior que zero. Ao cancelar, a API registra a data do
cancelamento; uma reativação limpa essa data. O cadastro e as mudanças são
transacionais. A cobrança recorrente e a transição automática por vencimento
ainda dependem da definição do meio de pagamento e serão tratadas no marco de
integrações financeiras.

O teste funcional `api/teste-clientes-vip.js` percorre as rotas HTTP de criação,
validação, duplicidade, busca, detalhe, edição, bloqueio, reativação e ciclo VIP.
Ele usa registros fictícios dentro de uma transação MySQL e confirma o rollback
de clientes, plano VIP e auditoria ao final.
