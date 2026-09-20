# Timeout e erros de conexão do frontend

Todas as chamadas HTTP do frontend passam por `web/src/http.js`. O cliente
interrompe requisições comuns após 30 segundos e apresenta uma mensagem clara
para timeout ou falha de rede.

A confirmação manual de pagamento mantém seu limite específico de 105 segundos.
Ela fornece o próprio `AbortSignal`, portanto o cliente comum não substitui esse
prazo nem a orientação de conferir o pedido antes de repetir a operação.

Códigos disponíveis para a interface:

- `TEMPO_ESGOTADO`: o servidor não respondeu dentro do prazo;
- `REDE_INDISPONIVEL`: o navegador não conseguiu alcançar a API.

Respostas HTTP continuam sendo tratadas por `lerResposta`, preservando o status,
o código e a mensagem enviados pelo backend. O teste `web/teste-http.js` cobre
sucesso, falha de rede, timeout padrão e preservação de cancelamento externo.
