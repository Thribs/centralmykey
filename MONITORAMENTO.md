# Monitoramento da API

A API oferece quatro níveis de verificação:

- `GET /health`: confirma que o processo HTTP está respondendo;
- `GET /health/ready`: confirma também que o MySQL aceita consultas;
- `GET /health/db`: diagnóstico autenticado para usuários com permissão de
  configurações;
- `GET /api/monitoramento/resumo`: diagnóstico operacional autenticado de
  pedidos atrasados, reprocessamento GM, comunicações, eventos externos e
  notificações internas.

O endpoint de prontidão retorna HTTP 200 quando API e banco estão disponíveis e
HTTP 503 quando o processo está ativo, mas o banco não responde. A resposta
pública informa somente `ready` ou `unavailable`; nomes de banco, versões,
endereços e mensagens internas não são expostos.

O teste `api/teste-health.js` executa as rotas HTTP com dependência saudável e
indisponível, confirma os códigos 200/503 e verifica que o erro interno simulado
não aparece na resposta.

O resumo operacional usa limites configuráveis por
`MONITORAMENTO_PEDIDO_ATRASO_MINUTOS`,
`MONITORAMENTO_OUTBOX_ATRASO_MINUTOS` e
`MONITORAMENTO_EVENTO_ATRASO_MINUTOS`. A resposta contém apenas contagens,
datas agregadas e severidade; não inclui payloads, destinatários ou dados de
clientes. A interface administrativa atualiza essa visão a cada minuto.

O teste `api/teste-monitoramento.js` injeta atrasos e falhas em tabelas
temporárias, compara os deltas com o estado anterior, valida permissão e
confirma rollback sem resíduos.

Após uma publicação, o monitor deve usar `/health/ready` para prontidão. O
`/health` continua adequado como verificação simples do processo e permanece
compatível com a configuração atual.
