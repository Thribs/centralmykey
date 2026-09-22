# Integração Sicoob Pix

## Estado desta branch

O núcleo local está implementado sem tráfego externo e sem alteração da
produção:

- o cliente usa OAuth2, mTLS e `PUT /cob/{txid}` para registrar a cobrança;
- uma referência Pix associa um `txid` único ao pedido e ao valor esperado;
- uma referência cujo prazo terminou passa atomicamente a `EXPIRADA`, recebe
  histórico e auditoria e deixa uma nova cobrança gerar outro `txid`;
- o webhook padrão `{ "pix": [...] }` é validado antes do processamento;
- o `endToEndId` identifica o evento e o pagamento para reentrega idempotente;
- valor e moeda precisam coincidir exatamente com o pedido;
- `txid` desconhecido gera evento `FALHOU`, sem pagamento ou lançamento;
- pagamento válido executa o mesmo fluxo pós-pagamento do pedido;
- a interface do pedido gera a cobrança, exibe o Pix copia e cola e permite
  copiá-lo somente quando o usuário possui permissão financeira e o conector
  informa disponibilidade;
- a administração consulta metadados, sem receber o payload do webhook;
- a rota `POST /webhooks/sicoob` permanece desabilitada por padrão e só aceita
  chamadas locais encaminhadas pelo proxy com validação mTLS positiva.

As chaves `SICOOB_COBRANCA_HABILITADA` e
`SICOOB_WEBHOOK_HABILITADO` começam como `false`. A cobrança só fica disponível
quando as credenciais exigidas estão configuradas e ambas as chaves estão
habilitadas; assim, a Central não cria um Pix que ainda não possa ser conciliado
por um webhook autenticado.

A preparação local não afirma que uma cobrança existe no Sicoob. A referência
só muda de `PREPARADA` para `REGISTRADA` quando o cliente da API confirma o
`PUT /cob/{txid}`. Em falha incerta, a mesma referência é preservada para uma
nova chamada idempotente.

## Barreira para ativação

O manual oficial do Sicoob define OAuth2 com credenciais do cliente e mTLS para
a API Pix, além de mTLS no envio do webhook ao recebedor. O Nginx atualmente
publicado encaminha HTTPS para a API, mas não exige nem valida certificado de
cliente. A branch registra a rota interna desabilitada e fornece
`deploy/nginx-sicoob-mtls.conf.example` para um host exclusivo; nada foi
instalado ou exposto no Nginx ativo.

Antes da ativação serão necessários:

1. credenciais e certificados do ambiente de homologação;
2. homologação do cliente OAuth2/mTLS que cria cobranças;
3. validação de certificado de cliente no Nginx apenas no endpoint Sicoob;
4. encaminhamento à aplicação somente após validação positiva no proxy;
5. teste de homologação de cobrança, pagamento, reentrega e evento inválido;
6. habilitar as duas chaves somente depois dos testes de homologação;
7. backup e plano de rollback antes da publicação.

Nenhum segredo deve ser gravado em documentação, logs, payload administrativo
ou repositório.

## Referências oficiais

- [Manual da API Pix do Sicoob](https://www.sicoob.com.br/documents/61112012/64877374/Sicoob%2BPix%2B%E2%80%93%2BManual%2Bpara%2Butiliza%C3%A7%C3%A3o%2Bda%2BAPI%2BPix.pdf/994711e9-bdf4-a479-f9f1-33266d83d58c?download=true&t=1627932447480)
- [Especificação OpenAPI Pix do Banco Central](https://github.com/bacen/pix-api/blob/master/openapi.yaml)
