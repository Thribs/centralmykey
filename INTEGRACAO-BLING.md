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

O webhook não cria cliente, pedido, pagamento ou lançamento financeiro. Essa
decisão é intencional enquanto não estiver definido, por entidade e estado, se
WBuy, Bling ou Central MyKey é a autoridade durante a transição.

## Ativação futura

1. Cadastrar o aplicativo Bling com apenas os escopos necessários.
2. Configurar `BLING_CLIENT_ID` e `BLING_CLIENT_SECRET` sem registrar valores em
   documentação ou logs.
3. Cadastrar o endpoint HTTPS e selecionar somente o recurso Pedido de Venda.
4. Manter o processamento dos eventos desativado até aprovar a matriz de
   autoridade e o mapeamento de estados.
5. Enviar eventos controlados e conferir assinatura, idempotência e fila antes
   de permitir qualquer efeito de negócio.
