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

Um reconciliador executado na inicialização e a cada hora muda para `VENCIDO`
os planos `ATIVO` ou `AGUARDANDO_PAGAMENTO` cujo próximo vencimento já passou.
A operação usa trava, transação e auditoria, preserva vencimentos do dia e não
altera planos suspensos, cancelados ou sem data.

O limite de crédito cadastrado é expresso em **BRL**. Valor nulo significa que o
cliente não possui teto automático; zero bloqueia qualquer novo consumo
pós-pago. Antes de criar um pedido semanal, a mesma transação soma as faturas
`ABERTA`, `FECHADA` e `VENCIDA` em BRL e compara a exposição mais o preço efetivo
do pedido, inclusive preço VIP, com o limite. Faturas `PAGA` e `CANCELADA` não
comprometem crédito. O bloqueio do cliente e o limite usam a trava da própria
linha do cliente, impedindo dois pedidos simultâneos de consumirem o mesmo saldo.

Serviço em USD ou PYG é recusado para cliente semanal com limite configurado,
pois o cadastro atual não possui cotação nem limite por moeda. Isso impede somas
monetárias inválidas; uma futura vertical nessas moedas deverá adicionar uma
política própria antes de ser marcada como operacional.

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
