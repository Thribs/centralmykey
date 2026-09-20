# Consulta da auditoria

A trilha de auditoria possui uma tela somente para administradores. Ela permite
filtrar por texto, módulo, usuário e período, com paginação por cursor para não
carregar toda a tabela de uma vez.

A API retorna apenas os metadados necessários para investigação:

- data e hora;
- usuário e login;
- módulo e ação;
- entidade e identificador;
- descrição.

Os campos JSON `dados_antes` e `dados_depois` e o endereço IP não são enviados à
interface. Essa restrição reduz o risco de expor credenciais ou conteúdo pessoal
que possa existir em eventos históricos. A consulta também não grava um novo
evento de auditoria, evitando recursão e crescimento artificial da trilha.

Rotas:

- `GET /api/auditoria`;
- `GET /api/auditoria/filtros`.

Ambas exigem autenticação e `perfil_id = 1`. O teste
`api/teste-auditoria.js` comprova a negação para não administradores, validação de
período, filtros, paginação, omissão dos campos sensíveis e rollback de todos os
dados fictícios.
