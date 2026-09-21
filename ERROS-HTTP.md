# Contrato de erros HTTP

Toda requisição recebe um identificador em `X-Request-ID`. Um identificador
recebido do proxy é preservado somente quando contém de 8 a 80 caracteres
alfanuméricos, ponto, hífen ou sublinhado; caso contrário, a API gera um UUID.

Respostas JSON com status 4xx ou 5xx incluem o mesmo valor em `request_id` sem
alterar `error` ou o `codigo` de negócio já definido pela rota. Quando a rota
não informa um código, o middleware acrescenta um código estável derivado do
status, como `REQUISICAO_INVALIDA`, `RECURSO_NAO_ENCONTRADO`, `CONFLITO` ou
`SERVICO_INDISPONIVEL`. O frontend
preserva status, código e identificador no objeto de erro e acrescenta a
referência à mensagem exibida. Assim, o operador pode relacionar a falha ao
registro do servidor sem receber stack trace, SQL ou detalhe interno.

Falhas não tratadas retornam HTTP 500 com `codigo=ERRO_INTERNO`. Rotas
inexistentes sob `/api` retornam HTTP 404 com
`codigo=ROTA_NAO_ENCONTRADA`. JSON malformado e corpo acima do limite retornam,
respectivamente, `JSON_INVALIDO` e `CORPO_MUITO_GRANDE`, sem serem classificados
como erro interno. Respostas bem-sucedidas possuem o cabeçalho de
correlação, mas não recebem campos extras no corpo.

`api/teste-erros-http.js` comprova geração e preservação do identificador,
códigos existentes, 404 e sanitização de falha inesperada. `web/teste-api.js`
comprova que a interface preserva o código e mostra a referência, inclusive
quando ela vem apenas no cabeçalho.
