# Notificações internas

## Objetivo

O sino da Central mostra pendências operacionais persistentes. As notificações
são filtradas pelo usuário destinatário e pela permissão de visualização do
módulo, de modo que um usuário não recebe atalho para uma área à qual não tem
acesso.

Cada evento possui uma chave idempotente. Repetir o mesmo evento atualiza e
reativa a notificação existente, removendo as leituras anteriores para que a
nova ocorrência volte a chamar atenção. Quando a pendência é resolvida, a
notificação deixa a lista ativa sem apagar o histórico.

## Primeiro evento conectado

Falhas e resultados incertos da outbox de WhatsApp criam notificações no módulo
`PEDIDOS_SENHAS`:

- `ATENCAO` para falha determinada;
- `CRITICA` quando rede, timeout ou HTTP 5xx deixam o resultado do envio incerto.

Um reenvio confirmado como bem-sucedido resolve a notificação. O erro técnico é
registrado como código estruturado; valores de configuração e credenciais não
são incluídos.

## Interface e API

O sino consulta o contador ao entrar e a cada 60 segundos. A caixa lista até 30
pendências, permite leitura individual ou coletiva e abre o módulo relacionado.
Falha ao carregar o sino não interrompe os demais módulos da Central.

Rotas autenticadas:

- `GET /api/notificacoes/resumo`;
- `GET /api/notificacoes`;
- `PATCH /api/notificacoes/:id/ler`;
- `POST /api/notificacoes/ler-todas`.

## Implantação e teste

A funcionalidade depende da migração
`api/migrations/20260919_notificacoes_internas.sql`. O teste funcional
`api/teste-notificacoes-internas.js` usa tabelas temporárias, transação MySQL e
rollback. Ele comprova visibilidade, leitura, reativação idempotente e resolução.
O teste da outbox também comprova a criação de alerta crítico e sua resolução
após envio bem-sucedido.

Ainda precisam ser conectados outros eventos, como falha repetida do worker GM,
fatura vencida, fechamento de fornecedor pendente e erro de integração externa.
