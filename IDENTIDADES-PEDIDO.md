# Cliente, comprador e pagador

Cada pedido registra três papéis independentes:

- **cliente**: titular do cadastro e da regra comercial;
- **comprador**: pessoa que solicitou ou comprou o serviço;
- **pagador**: pessoa que realizou ou realizará o pagamento.

Os três papéis são gravados em `pedido_partes` como snapshots. Nome, documento,
telefone e e-mail permanecem vinculados à operação mesmo que o cadastro do
cliente seja alterado depois. Quando não há diferença, comprador e pagador
herdam os dados do cliente; nenhuma informação precisa ser digitada novamente.

O formulário de novo pedido permite desmarcar **O comprador é o próprio
cliente** e **O pagador é o próprio comprador** para identificar pessoas
distintas. O detalhe do pedido apresenta os três nomes separadamente.

A migração `api/migrations/20260920_partes_pedido.sql` cria a tabela e preenche
pedidos anteriores assumindo os três papéis como o cliente existente. Ela deve
ser aplicada no mesmo procedimento controlado das demais migrações antes da
publicação do código.

O teste funcional `api/teste-criacao-pedido-pospago.js` cria uma tabela MySQL
temporária, valida rejeição de e-mail inválido, cria comprador e pagador
distintos pela rota HTTP e consulta os snapshots no detalhe. Ele também comprova
que um pedido antecipado herda os três papéis quando nenhuma diferença é
informada e encerra com rollback de todos os dados de negócio.
