# Integração Bling durante a transição

Este documento descreve somente o contrato já implementado. Ele não define o
Bling ou a Central MyKey como autoridade dos pedidos durante a transição.

## Base oficial consultada

- Webhooks: <https://developer.bling.com.br/webhooks>
- API e autenticação: <https://developer.bling.com.br/bling-api>
- Aplicativos e OAuth: <https://developer.bling.com.br/aplicativos>

A documentação oficial informa que os webhooks usam o cabeçalho
`X-Bling-Signature-256`, calculado por HMAC-SHA256 sobre o corpo JSON em UTF-8
com o client secret. O envelope contém `eventId`, `date`, `version`, `event`,
`companyId` e `data`. Eventos podem chegar repetidos e fora de ordem, e o
receptor deve responder em até cinco segundos.

## Comportamento implementado

- Endpoint: `POST /webhooks/bling`.
- A assinatura é comparada em tempo constante com o corpo bruto recebido.
- `eventId` é a chave de idempotência dentro do provedor `BLING`.
- Reentrega com o mesmo corpo incrementa o contador e recebe HTTP 200.
- O mesmo `eventId` com outro conteúdo recebe HTTP 409 e não altera o evento.
- `order.created`, `order.updated` e `order.deleted`, versão `v1`, ficam como
  `RECEBIDO` em `integracao_eventos`.
- Outros recursos ou versões autenticados ficam como `IGNORADO` e recebem 2xx.
- A consulta administrativa omite o payload armazenado.
- O fluxo OAuth Authorization Code possui início autenticado, `state` aleatório
  armazenado apenas como SHA-256, callback de uso único e troca server-side.
- A troca e a renovação solicitam tokens JWT com `enable-jwt: 1` e enviam o
  client secret somente por Basic ao endpoint oficial de tokens.
- Access e refresh tokens ficam cifrados com AES-256-GCM por uma chave dedicada
  que só pode vir do ambiente do processo; a API e a auditoria retornam apenas
  estado e datas de expiração.
- O fluxo OAuth permanece desabilitado por padrão; a leitura só é liberada
  depois da conexão autorizada e nenhuma escrita no Bling foi implementada.
- A rota administrativa autenticada consulta um pedido por ID em
  `GET /pedidos/vendas/{id}`, renova o JWT quando necessário e guarda snapshots
  idempotentes por ID e hash do conteúdo. A resposta e a auditoria omitem
  contato, documento, e-mail e tokens; o payload completo fica restrito ao
  banco. Essa leitura nunca cria nem atualiza pedido na Central ou no Bling.
- Cada snapshot pode ser reanalisado localmente pela Administração. A prévia
  cruza produtos, status de pagamento e matriz de autoridade, expõe apenas
  metadados e bloqueios e mantém `pronto_para_converter=false`. A reanálise não
  chama o Bling e não cria cliente, pedido, pagamento ou lançamento financeiro.
- A moeda e a origem de cliente, comprador e pagador podem ser registradas como
  política auditada do provedor. Os valores ficam vazios por padrão e apenas
  refinam a prévia; não liberam conversão automática.

O webhook não cria cliente, pedido, pagamento ou lançamento financeiro. Essa
decisão é intencional enquanto não estiver definido, por entidade e estado, se
WBuy, Bling ou Central MyKey é a autoridade durante a transição.

## Ativação futura

1. Cadastrar o aplicativo Bling com apenas os escopos necessários.
2. Configurar `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET`, `BLING_REDIRECT_URI` e
   uma chave exclusiva de 32 bytes, em Base64 ou hexadecimal, em
   `BLING_TOKEN_ENCRYPTION_KEY`, sem registrar valores em documentação ou logs.
3. Cadastrar o callback HTTPS e selecionar somente o recurso Pedido de Venda.
4. Habilitar `BLING_OAUTH_HABILITADO`, concluir a autorização controlada e
   conferir as datas na Administração.
5. Manter o processamento dos eventos desativado até aprovar a matriz de
   autoridade e o mapeamento de estados.
6. Enviar eventos controlados e conferir assinatura, idempotência e fila antes
   de permitir qualquer efeito de negócio.
