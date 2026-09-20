# Seleção dos fornecedores GM

Depois que a API Joel Pires responde `SenhaNotFoundError`/HTTP 404, a Central
seleciona entre os fornecedores ativos vinculados ao serviço `GM_SENHA`.

A ordem é:

1. fornecedor e vínculo com o serviço precisam estar ativos;
2. o horário atual precisa estar dentro do expediente, incluindo os dois limites;
3. vence o menor custo;
4. em empate, vence o menor identificador de fornecedor, garantindo resultado
   determinístico.

A consulta também suporta expedientes que atravessam a meia-noite e fornecedores
sem restrição de horário. No cadastro operacional validado:

- Márcio: 08h–22h, R$ 22;
- Emerson: 08h–19h, R$ 25.

Assim, Márcio é escolhido quando ambos estão disponíveis. Emerson assume quando
Márcio está inativo ou indisponível e o horário ainda está dentro do expediente
dele. Fora dos dois expedientes, o pedido permanece aberto aguardando fornecedor.

O teste `api/teste-selecao-fornecedores-gm.js` primeiro confere, em modo somente
leitura, se esses dois cadastros vivos mantêm horários, custos e status esperados.
Depois usa tabelas MySQL temporárias para testar 07:59:59, 08:00:00, 19:00:00,
19:00:01, 22:00:00 e 22:00:01, além de inativação, mudança de custo e empate. A
execução ocorre em transação e termina com rollback.
