# Homologação das integrações do fluxo GM

## WhatsApp pela SendPulse

Instalar no `.env` publicado, sem registrar valores no Git:

```dotenv
WHATSAPP_PROVEDOR=SENDPULSE
SENDPULSE_CLIENT_ID=
SENDPULSE_CLIENT_SECRET=
SENDPULSE_WHATSAPP_BOT_ID=
SENDPULSE_WEBHOOK_TOKEN=
WHATSAPP_FORNECEDOR_MARCIO=
WHATSAPP_FORNECEDOR_EMERSON=
```

Os dois telefones devem estar no formato internacional, somente com dígitos.
Na SendPulse, configurar o webhook global como:

```text
https://api-central.aiepires.com.br/webhooks/sendpulse/whatsapp/VALOR_DO_SENDPULSE_WEBHOOK_TOKEN
```

Habilitar os eventos **Incoming message**, **Outbound messages** e **Message
delivery failed**. O Nginx deve aplicar a configuração de
`nginx-sendpulse-webhook.conf.example` para não gravar o token do caminho no
log de acesso.

Os modelos definidos por `WHATSAPP_MODELO_CONSULTA_FORNECEDOR` e
`WHATSAPP_MODELO_ENTREGA_RESULTADO` devem estar aprovados e ativos no bot
WhatsApp indicado por `SENDPULSE_WHATSAPP_BOT_ID`. A especificação atual da API
SendPulse permite listar os modelos, mas não publica uma operação para enviar
um novo modelo à aprovação. A criação deve ser feita no painel SendPulse. Em
seguida, usar **Sincronizar SendPulse** na administração da Central para
confirmar o status real; aprovação digitada somente no banco não libera o
fluxo.

Modelos sugeridos, ambos na categoria Utilidade e idioma `pt_BR`:

```text
centralmykey_consulta_gm_fornecedor
Central MyKey | Consulta GM {{1}}
Chassi: {{2}}
Marca: {{3}}
Modelo: {{4}}
Ano: {{5}}
Responda iniciando com MYKEY {{1}} e informe os códigos encontrados.

centralmykey_entrega_gm_cliente
Central MyKey | Pedido {{1}}
Código mecânico: {{2}}
Imobilizador: {{3}}
Rádio: {{4}}
Alarme: {{5}}
PIN: {{6}}
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
SICOOB_CLIENT_SECRET=
SICOOB_CERT_PATH=
SICOOB_KEY_PATH=
SICOOB_CA_PATH=
SICOOB_WEBHOOK_CA_PATH=
SICOOB_CHAVE_PIX=
SICOOB_AMBIENTE=homologacao
SICOOB_WEBHOOK_URL=https://pix-central.aiepires.com.br/webhooks/sicoob
```

`SICOOB_CERT_PATH` e `SICOOB_KEY_PATH` autenticam a Central nas chamadas ao
banco. `SICOOB_WEBHOOK_CA_PATH` contém a cadeia de CA fornecida pelo Sicoob e
permite ao Nginx autenticar o banco nas chamadas recebidas. O certificado do
Certbot para `pix-central.aiepires.com.br` autentica o servidor público e não
substitui essa CA.

Antes de habilitar cobranças: criar o registro DNS do subdomínio para este VPS,
emitir o certificado com Certbot, aplicar
`nginx-sicoob-mtls.conf.example`, cadastrar a URL no Sicoob e então definir:

```dotenv
SICOOB_WEBHOOK_MTLS_CONFIGURADO=true
SICOOB_WEBHOOK_CADASTRADO=true
SICOOB_COBRANCA_HABILITADA=true
SICOOB_WEBHOOK_HABILITADO=true
```

## API Joel Pires

A leitura já usa staging. A gravação de resultado de fornecedor permanece
bloqueada por `APIJOELPIRES_GRAVACAO_HOMOLOGADA=false` até um ensaio com dados
fictícios confirmar POST e releitura no staging. Depois desse ensaio, a chave
pode ser ativada para o teste completo.
