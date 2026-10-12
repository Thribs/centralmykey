# Homologação das integrações do fluxo GM

## Dependências externas exatas

Esta é a lista completa do que ainda precisa vir de fora do repositório. Os
valores secretos devem ser instalados diretamente no VPS; não devem ser
enviados por conversa nem registrados no Git.

| Origem | O que precisa ser fornecido ou executado | O que isso libera |
|---|---|---|
| SendPulse | Instalar `SENDPULSE_CLIENT_ID`, `SENDPULSE_CLIENT_SECRET` e `SENDPULSE_WHATSAPP_BOT_ID`; a Central gera `SEGREDO_WEBHOOK_SENDPULSE` | Autenticação do transporte de clientes e recepção protegida do webhook |
| Grupos dos fornecedores | Confirmar elegibilidade OBA na Meta, obter os `group_id` compatíveis de Márcio e Emerson e homologar envio/retorno pela Groups API | Consulta automática aos grupos; sem isso o atendimento segue para humano |
| Painel SendPulse | Criar e enviar para aprovação o modelo de entrega ao cliente descrito abaixo | Envio ao cliente fora da janela livre de 24 horas |
| Sicoob | Usar Client ID, chave Pix, certificado cliente `.cer`, chave privada e senha do certificado já instalados; confirmar no portal o contrato de autenticação do webhook no endereço existente | Cobrança Pix em homologação e confirmação segura do pagamento |
| API Joel Pires | Autorizar o `ID_USUARIO_API_JOELPIRES` já configurado a gravar no staging e informar um registro fictício removível ou um meio de limpeza | Ensaio seguro de POST, releitura e liberação da entrega de resultado do fornecedor |

Depois que cada dependência estiver disponível no VPS ou no serviço
correspondente, a equipe técnica pode executar sozinha backup, Certbot, Nginx,
sincronização, testes controlados e diagnóstico de prontidão. A automação
permanece desabilitada até todos os diagnósticos passarem.

## WhatsApp pela SendPulse

Instalar no `.env` publicado, sem registrar valores no Git:

```dotenv
WHATSAPP_PROVEDOR=SENDPULSE
SENDPULSE_CLIENT_ID=
SENDPULSE_CLIENT_SECRET=
SENDPULSE_WHATSAPP_BOT_ID=
SEGREDO_WEBHOOK_SENDPULSE=
AUTOMACAO_GM_WHATSAPP_TELEFONES_TESTE=
```

Na SendPulse, configurar o webhook global como:

```text
https://api-central.aiepires.com.br/webhooks/sendpulse/whatsapp/SEGREDO_GERADO_PELA_CENTRAL
```

Habilitar os eventos **Incoming message**, **Outbound messages** e **Message
delivery failed**. O Nginx deve aplicar a configuração de
`nginx-sendpulse-webhook.conf.example` para não gravar o token do caminho no
log de acesso. Esse segredo é gerado pela Central MyKey porque a SendPulse não
documenta assinatura ou token próprio para webhooks globais.

Antes do ensaio, preencher a lista de telefones apenas com o contato autorizado.
O painel mostra somente a quantidade. Mensagens de outros números continuam na
fila humana e não criam pedidos automáticos.

## Grupos Márcio e Emerson

Márcio e Emerson são grupos de WhatsApp, não destinatários individuais. A API
pública da SendPulse documenta somente envio para contatos por `contact_id` ou
telefone. Ela não comprova envio para grupos.

A Groups API oficial da Meta usa `group_id`, exige conta comercial oficial
(OBA), aceita no máximo oito participantes e opera com grupos criados pela
própria API. Portanto, os grupos atuais não devem ser presumidos compatíveis.
Depois da confirmação no Meta Developers, configurar somente no ambiente:

```dotenv
WHATSAPP_GRUPO_FORNECEDOR_MARCIO_ID=
WHATSAPP_GRUPO_FORNECEDOR_EMERSON_ID=
WHATSAPP_GRUPOS_FORNECEDORES_HOMOLOGADOS=false
WHATSAPP_MODELO_GRUPO_FORNECEDOR_HOMOLOGADO=false
```

Enquanto as duas chaves de homologação estiverem falsas, o sistema não envia
ao grupo e encaminha o atendimento para uma pessoa.

Referências oficiais consultadas em 30/09/2026:

- SendPulse, webhooks globais: `https://sendpulse.com/integrations/api/chatbot/webhooks`;
- SendPulse, contrato da API WhatsApp: `https://api.sendpulse.com/.well-known/openapi/whatsapp.yaml`;
- Meta, Groups API: `https://developers.facebook.com/docs/whatsapp/cloud-api/groups/`;
- Meta, mensagens em grupos: `https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging`.

O modelo de entrega ao cliente deve estar aprovado e ativo no bot WhatsApp
indicado por `SENDPULSE_WHATSAPP_BOT_ID`. A especificação atual da API SendPulse
permite listar modelos, mas não publica uma operação para criar e enviá-los à
aprovação. No painel, entrar em **Chatbots > MyKey Soluções LTDA > Modelos >
Adicionar modelo** e preencher:

```text
Nome: centralmykey_entrega_gm_cliente
Anexo: nenhum
Texto:
Central MyKey informa: o pedido {{pedido}} foi concluído.
Código mecânico: {{codigo_mecanico}}
Código do imobilizador: {{codigo_imobilizador}}
Código do rádio: {{codigo_radio}}
Código do alarme: {{codigo_alarme}}
Guarde estas informações com segurança.
Assinatura: MyKey Soluções
Idioma: Português (Brasil)
Categoria: Utilidade
```

O modelo foi aprovado como Utilidade depois da análise solicitada à Meta. Em
12/10/2026, a sincronização da SendPulse confirmou `APPROVED`, o cadastro local
foi ativado e a ordem das cinco variáveis foi validada no código e no teste
funcional. O modelo não possui PIN.

O modelo de consulta ao fornecedor não pertence à SendPulse, pois Márcio e
Emerson são grupos. Ele somente será criado no WhatsApp Manager da Meta depois
da confirmação de elegibilidade para a Groups API. O texto previsto é:

```text
centralmykey_consulta_gm_fornecedor
Central MyKey | Consulta GM {{1}}
Chassi: {{2}}
Marca: {{3}}
Modelo: {{4}}
Ano: {{5}}
Responda iniciando com MYKEY {{1}} e informe os códigos encontrados.

```

Depois do cadastro local, definir os nomes no `.env`:

```dotenv
WHATSAPP_MODELO_CONSULTA_FORNECEDOR=centralmykey_consulta_gm_fornecedor
WHATSAPP_MODELO_ENTREGA_RESULTADO=centralmykey_entrega_gm_cliente
```

A falta do número de teste da Meta não bloqueia o conector da Central quando o
bot SendPulse já possui um número operacional conectado.

## Sicoob Pix

Instalar no `.env` os identificadores e caminhos abaixo:

```dotenv
SICOOB_CLIENT_ID=
SICOOB_CERT_PATH=/root/centralmykey-secrets/sicoob/certificado.cer
SICOOB_KEY_PATH=/root/centralmykey-secrets/sicoob/chave_privada.pem
SICOOB_CERTIFICADO_SENHA=
SICOOB_CHAVE_PIX=
SICOOB_AMBIENTE=producao
SICOOB_WEBHOOK_URL=https://api-central.aiepires.com.br/webhooks/sicoob
SICOOB_CONSULTA_HABILITADA=false
```

O arquivo `.cer` instalado é um certificado X.509 válido e está em codificação
aceita pelo OpenSSL; ele não precisa ser renomeado para `.pem`. A chave privada
instalada corresponde a esse certificado e é aberta com
`SICOOB_CERTIFICADO_SENHA`. O `client_secret` não faz parte da configuração
adotada. `SICOOB_CA_PATH` também não é necessário enquanto o servidor do Sicoob
usar uma autoridade certificadora reconhecida pelo sistema operacional.

Não será criado outro DNS. O primeiro teste pode confirmar o pagamento pela
consulta autenticada da cobrança, sem trocar o webhook atual. A Central consulta
somente `txid` que ela mesma registrou, valida o retorno e reutiliza o
processamento idempotente já aplicado ao webhook.

O endpoint antigo de homologação foi retirado pelo Sicoob. A autenticação
mTLS no endpoint vigente foi validada sem criar cobrança. O webhook bancário
continua apontando para o n8n e não deve ser alterado antes da homologação da
rota da Central. O valor `producao` acima identifica a API real; as chaves de
habilitação abaixo continuam sendo a barreira operacional.

```dotenv
SICOOB_COBRANCA_HABILITADA=true
SICOOB_CONSULTA_HABILITADA=true
SICOOB_WEBHOOK_HABILITADO=false
```

Depois que o webhook da Central for homologado, o canal poderá ser trocado sem
alterar o processamento financeiro:

```dotenv
SICOOB_WEBHOOK_MTLS_CONFIGURADO=true
SICOOB_WEBHOOK_CADASTRADO=true
SICOOB_COBRANCA_HABILITADA=true
SICOOB_CONSULTA_HABILITADA=false
SICOOB_WEBHOOK_HABILITADO=true
```

## API Joel Pires

A leitura já usa staging. A gravação de resultado de fornecedor permanece
bloqueada por `APIJOELPIRES_GRAVACAO_HOMOLOGADA=false` até um ensaio com dados
fictícios confirmar POST e releitura no staging. Depois desse ensaio, a chave
pode ser ativada para o teste completo.
