# Correção de dados GM

Pedidos GM classificados como `DADOS_INVALIDOS` ficam em
`AGUARDANDO_DADOS`. O detalhe do pedido oferece a ação **Corrigir dados**, com
chassi, marca, modelo e ano preenchidos para revisão do operador.

Ao salvar, a API valida os dados, bloqueia o pedido e exige que ele ainda seja
do serviço `GM_SENHA` e esteja em `AGUARDANDO_DADOS`. A correção e o novo
processamento ocorrem na mesma transação MySQL. Se qualquer etapa falhar, todas
as alterações são revertidas.

A operação:

- atualiza os dados do veículo;
- remove fornecedor, origem e custo anteriores incompatíveis com a nova consulta;
- registra `DADOS_PEDIDO_CORRIGIDOS` no histórico;
- registra `CORRIGIR_DADOS` na auditoria;
- executa novamente cache, API Joel Pires e o destino correspondente à resposta.

Rota: `POST /api/pedidos/:id/corrigir-dados`, protegida pela permissão de edição
de pedidos de senha.

O teste `api/teste-correcao-dados-gm.js` usa a rota HTTP, simula a API Joel
Pires, comprova validação de estado e chassi, conclusão, resultado, auditoria e
agendamento da entrega ao cliente. Todos os dados são criados em uma transação e
removidos por rollback; a API externa não é acessada.
