# Integrações externas

Os estados abaixo descrevem configuração técnica. Eles não autorizam chamar uma
integração de operacional. A prova operacional exige homologação ponta a ponta e
execução real persistida; a Central MyKey só estará pronta quando houver clientes
usando o fluxo completo.

A tela de integrações distingue credenciais cadastradas de conectores realmente
implementados. Os estados exibidos são:

- `CONFIGURADO`: conector implementado, requisitos preenchidos e habilitado;
- `CONFIGURADO_DESABILITADO`: conector implementado e configurado, com o worker
  operacional desligado;
- `PARCIAL`: somente parte dos requisitos foi preenchida;
- `CREDENCIAIS_SEM_CONECTOR`: há credenciais, mas ainda não existe integração;
- `CONTRATO_NAO_IDENTIFICADO`: o nome comercial não determina de forma segura
  qual API, autenticação e assinatura devem ser implementadas;
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

Em 20/10/2026, a autenticação de leitura da conta SendPulse e a presença do modelo
foram verificadas, mas não havia mensagem real registrada no fluxo. Portanto,
WhatsApp continua parcial e não operacional.

## API Joel Pires

A API já existe fora da Central MyKey. O conector apenas consome
`staging.api.joelpires.com.br` no ambiente de teste e `api.joelpires.com.br` no
ambiente público; a Central não implementa nem hospeda esse serviço. O fluxo GM
usa essa API como fonte de verdade, com cache local, classificação de erros e
reprocessamento. A ampliação para outros produtos depende dos contratos de cada
consulta.

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

A configuração WBuy segue o contrato REST oficial: usuário e senha próprios da
API, enviados como Bearer em Base64 para o endpoint oficial. A URL da loja não é
credencial nem requisito do conector, e o antigo token isolado não é considerado
configuração suficiente.

A administração pode sincronizar um pedido específico pelo ID. A Central busca
o registro canônico em `GET /api/v1/order/{id}` e guarda um snapshot idempotente
em `integracao_eventos`; uma repetição igual incrementa as tentativas e uma
alteração cria novo snapshot. O payload completo permanece restrito ao banco e a
auditoria contém apenas IDs, estado e quantidade de produtos. Essa etapa ainda
não cria pedido na Central, pois a regra que relaciona pagamento, comprador,
cliente, produto e serviço precisa ser definida antes de produzir efeitos.

Cada evento `ORDER.SNAPSHOT` possui uma prévia autenticada de somente leitura.
Ela reprocessa localmente o snapshot com os produtos, estados e autoridades
vigentes, sem nova chamada externa e sem mutação de negócio. A prévia não retorna
o objeto de cliente nem qualquer nome, documento, telefone ou e-mail contido no
payload e mantém a conversão desabilitada enquanto houver decisões pendentes.

Moeda e reconciliação de identidades possuem política persistida por provedor.
Para cliente, comprador e pagador, a Administração registra se o dado virá da
origem externa, de um cadastro já existente na Central ou de resolução manual.
Essas decisões são auditadas e reaplicadas às prévias, sem criar ou alterar
qualquer entidade comercial.

O webhook continua desativado. A documentação pública confirma os eventos
`order` e `order_status`, mas não publica mecanismo verificável de assinatura.

O Bling possui receptor HMAC e base OAuth Authorization Code. O início exige
permissão administrativa, o callback consome um `state` aleatório uma única vez
e a troca/renovação solicita JWT no servidor. Tokens são cifrados por chave
dedicada do ambiente e nunca aparecem nas respostas ou na auditoria. A conexão
permanece desabilitada até cadastrar o aplicativo e o callback; leitura e
efeitos comerciais continuam bloqueados pela matriz e pelo mapa de estados.
A administração também pode consultar um pedido Bling específico depois da
conexão. A leitura usa `GET /pedidos/vendas/{id}`, renova o JWT se necessário e
guarda um snapshot idempotente; nenhum cliente, pedido, pagamento ou lançamento
é criado, e dados pessoais do payload não retornam à interface.

Em 20/10/2026, não havia `client_id`, segredo, callback ou OAuth habilitado no
ambiente. Não existe integração Bling operacional.

## PlugPay

O manual interno recebido identifica o provedor contratado como PlugPay da SVM
Group e documenta o credenciamento administrativo de parceiro,
estabelecimento, usuário externo, taxas e banco recebedor. O painel possui
ambientes separados de sandbox e produção; o banco recebedor existe somente em
produção. As credenciais mostradas no manual são material sensível e não devem
ser copiadas para o repositório.

O guia transacional v2.3, de 14/10/2026, define sandbox em
`https://apisandbox.plugpayapi.com`, produção em `https://api.plugpayapi.com`,
autenticação em `POST /v1/partners/auth/token`, criação Pix em
`POST /v1/partners/transactionPix/create` e consulta em
`GET /v1/partners/transactionPix/status/{referenciaInterna}`. A Central possui
conector para criar e consultar Pix, valida referência, valor e moeda, e aplica
a confirmação pela base financeira idempotente. Timeout de criação fica como
estado incerto e bloqueia uma segunda cobrança automática.

As credenciais existem somente no ambiente: `PLUGPAY_CLIENT_ID`,
`PLUGPAY_PASSWORD` e `PLUGPAY_DOCUMENT_MERCHANT`. Cobrança e consulta exigem
habilitação separada. O webhook permanece desabilitado porque o guia manda
validar um token/header configurado, mas não informa o nome exato desse header.

Em 20/10/2026, essas credenciais e habilitações não estavam configuradas. Os testes
do conector usam mocks; não houve cobrança nem consulta homologada no sandbox.
Até esse contrato ser confirmado, a consulta periódica é o canal de confirmação.
O fluxo GM usa `PAGAMENTO_PIX_PROVEDOR=SICOOB` por padrão e pode ser direcionado
para `PLUGPAY` no ambiente de teste sem alterar o código ou o ambiente público.

## Eventos financeiros externos

A tabela `integracao_eventos` é a caixa de entrada auditável dos conectores de
pagamento. O serviço normalizado valida provedor, pedido, valor e moeda, impede
colisão de identificadores, deduplica reentregas pela referência externa e só
então cria o lançamento, o pagamento e executa o fluxo pós-pagamento. O payload
bruto fica restrito ao banco; a rota administrativa expõe apenas metadados.

Se o provedor confirmar um pagamento depois do cancelamento, a Central registra
a entrada sem reabrir nem processar o pedido. A fila mostra a ação **Registrar
devolução**, com valor e moeda obtidos do pagamento persistido, apenas para quem
possui aprovação financeira. Depois que o operador confirma uma devolução já
realizada, a mesma transação cria o estorno e resolve o evento pendente.

Nenhum endpoint público de provedor é ativado antes da validação de assinatura
ou do mecanismo de autenticação definido no contrato oficial correspondente.
