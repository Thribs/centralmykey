# Catálogo de serviços

O catálogo define os produtos operacionais que podem originar pedidos na
Central MyKey. Ele é independente das regras de fornecedores: primeiro o
serviço é cadastrado; depois cada fornecedor pode receber uma regra de custo,
prazo, marca, modelo e período para esse serviço.

A administração fica em **Fornecedores → Catálogo de serviços** e usa a
permissão `FORNECEDORES`. O cadastro informa código, nome, categoria, marca,
preço base, preço VIP, moeda e se placa, chassi ou documento são obrigatórios.
Criação exige a permissão `criar`; edição e alteração de status exigem `editar`.
Todas as mutações usam transação e geram auditoria.

O código é imutável depois da criação porque integra pedidos, regras de
fornecedores e sistemas externos. Um serviço desativado permanece no histórico
e no catálogo administrativo, mas deixa de aparecer na criação de novos
pedidos e na lista de novos vínculos de fornecedor.

Cadastrar ou ativar um item no catálogo não o torna disponível para pedidos. O
serviço também precisa de um processador registrado em
`api/servicos-implementados.js`; atualmente apenas `GM_SENHA` possui fluxo
comprovado. A rota de criação rejeita IDs sem processador mesmo que sejam
enviados diretamente, impedindo que outro produto caia por engano no fluxo GM.

Cada produto novo ainda precisa de regra comercial, fonte de consulta ou
fornecedor, fluxo de pagamento, entrega, interface e teste funcional próprio.
Quando o processador é registrado, o formulário usa os indicadores do catálogo
para exigir placa, chassi e documento do comprador. Placa é transitória e não é
persistida.
