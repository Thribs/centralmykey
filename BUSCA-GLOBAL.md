# Busca global

A busca do cabeçalho consulta `GET /api/busca-global?termo=...` e exige uma
sessão autenticada. O termo deve possuir de 2 a 100 caracteres.

Os resultados são limitados a cinco itens por categoria e incluem pedidos,
clientes e fornecedores. A API consulta primeiro a matriz de permissões do
usuário e não pesquisa nem devolve categorias cujo módulo não tenha permissão
de visualização.

Ao selecionar um resultado, o frontend abre o módulo correspondente com o
filtro preenchido. A resposta contém apenas os campos necessários para
identificar o registro; documentos de clientes e conteúdo de senhas não são
devolvidos.

O teste `api/teste-busca-global.js` percorre a rota HTTP, comprova autenticação,
validação do termo, isolamento por permissão, navegação retornada para as três
categorias e ausência de resíduos após o rollback da transação MySQL.
