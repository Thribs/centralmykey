# Integrações externas

A tela de integrações distingue credenciais cadastradas de conectores realmente
implementados. Os estados exibidos são:

- `CONFIGURADO`: conector implementado, requisitos preenchidos e habilitado;
- `CONFIGURADO_DESABILITADO`: conector implementado e configurado, com o worker
  operacional desligado;
- `PARCIAL`: somente parte dos requisitos foi preenchida;
- `CREDENCIAIS_SEM_CONECTOR`: há credenciais, mas ainda não existe integração;
- `PENDENTE`: não há configuração suficiente.

Valores do ambiente têm precedência sobre a tabela `configuracoes`. A API usa a
mesma resolução para o painel, envio de mensagens, verificação do webhook,
processamento da outbox, download e limpeza de mídia. O resumo administrativo
retorna apenas estados booleanos; nunca retorna tokens, segredos ou chaves.

## WhatsApp

O código cobre envio de texto e modelos, assinatura do webhook da Meta,
mensagens recebidas, estados de entrega, mídia privada e outbox idempotente para
fornecedores e clientes. O worker só envia quando
`COMUNICACOES_OUTBOX_HABILITADO` está ativo. A ativação em ambiente real exige
modelos aprovados, contatos revisados e homologação controlada conforme
`ATIVAR-COMUNICACOES-FORNECEDORES.md`.

## API Joel Pires

O conector está implementado para o fluxo GM, com cache local, classificação de
erros e reprocessamento. A ampliação para outros produtos depende dos contratos
de cada consulta.

## Sicoob

A branch de desenvolvimento contém o cliente OAuth2/mTLS para criar cobranças,
a correlação local entre `txid` e pedido, o parser do webhook Pix, deduplicação
pelo `endToEndId`, validação exata de valor e registro de `txid` desconhecido sem
gerar efeito financeiro. A rota autenticada de cobrança está implementada, mas
permanece bloqueada até a entrada segura do webhook. A rota administrativa
lista somente metadados da referência.

O endpoint público permanece desativado. O contrato oficial do Sicoob exige
mTLS na entrega do webhook, e o proxy atual deste VPS não valida certificado de
cliente. A ativação depende da cadeia de certificados, configuração do Nginx,
credenciais e certificados de homologação. A criação remota por
`PUT /cob/{txid}` está implementada com transporte simulado nos testes, mas
ainda não foi homologada contra o Sicoob.

## PlugPay, WBuy e Bling

Esses conectores ainda não estão implementados. Cadastrar credenciais não
confirma pagamentos nem importa pedidos. Cada adaptador precisa do contrato
oficial e do mapeamento de identificadores externos para pedidos, clientes,
faturas, pagamentos e estornos da Central MyKey.

## Eventos financeiros externos

A tabela `integracao_eventos` é a caixa de entrada auditável dos conectores de
pagamento. O serviço normalizado valida provedor, pedido, valor e moeda, impede
colisão de identificadores, deduplica reentregas pela referência externa e só
então cria o lançamento, o pagamento e executa o fluxo pós-pagamento. O payload
bruto fica restrito ao banco; a rota administrativa expõe apenas metadados.

Nenhum endpoint público de provedor é ativado antes da validação de assinatura
ou do mecanismo de autenticação definido no contrato oficial correspondente.
