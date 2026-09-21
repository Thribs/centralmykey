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

## WBuy e Bling

A camada comum de produtos externos está implementada. A administração permite
associar ID e/ou SKU da WBuy e do Bling a um serviço ativo da Central MyKey,
detectar colisões, atualizar ou desativar o vínculo e auditar cada mudança.

A configuração WBuy agora representa o contrato documentado pela plataforma:
usuário e senha da API REST mais a URL da loja. O antigo token isolado não é
considerado configuração suficiente. A importação continua desativada porque a
documentação pública confirma os eventos `order` e `order_status`, mas não
publica o esquema completo do payload nem um mecanismo verificável de assinatura.

O adaptador Bling e a coexistência durante a transição ainda dependem do fluxo
OAuth e do mapeamento de estados definido para a conta utilizada.

## PlugPay

O nome do produto ainda não identifica inequivocamente o provedor contratado.
A base financeira aceita eventos normalizados `PLUGPAY`, mas nenhum endpoint
externo será aberto antes de confirmar o fornecedor e seu contrato de assinatura.

## Eventos financeiros externos

A tabela `integracao_eventos` é a caixa de entrada auditável dos conectores de
pagamento. O serviço normalizado valida provedor, pedido, valor e moeda, impede
colisão de identificadores, deduplica reentregas pela referência externa e só
então cria o lançamento, o pagamento e executa o fluxo pós-pagamento. O payload
bruto fica restrito ao banco; a rota administrativa expõe apenas metadados.

Nenhum endpoint público de provedor é ativado antes da validação de assinatura
ou do mecanismo de autenticação definido no contrato oficial correspondente.
