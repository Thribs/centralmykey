# Integração da Central com a API Joel Pires

## Decisão de arquitetura

- A API Joel Pires é a fonte de verdade das senhas.
- `banco_senhas` é somente cache e histórico operacional.
- A Central consulta apenas entradas de cache marcadas com `API_JOELPIRES`.
- Registros antigos do banco local não decidem mais o atendimento automático.
- Fornecedor externo somente pode ser escolhido quando a API responder que não encontrou.
- Falha de comunicação não pode provocar compra externa nem reutilizar cache
  vencido; o pedido deve aguardar reprocessamento.

## Fluxo

1. Procura cache válido.
2. Se não houver, chama `GET /senhas/busca/`.
3. Para GM, envia somente os oito caracteres finais do chassi.
4. Se encontrar, atualiza o cache e conclui o pedido sem custo.
5. Se a lista vier vazia, segue para a seleção de fornecedor.
6. Se a API falhar, mantém o pedido aberto para reprocessamento.

## Configuração

As credenciais reais ficam apenas em `/opt/central-mykey-api/.env`.

```dotenv
AMBIENTE_API_JOELPIRES=teste
URL_API_JOELPIRES_TESTE=https://staging.api.joelpires.com.br
URL_API_JOELPIRES_PUBLICO=https://api.joelpires.com.br
CHAVE_API_JOELPIRES=
ID_USUARIO_API_JOELPIRES=
APIJOELPIRES_ID_DISPOSITIVO=centralmykey
APIJOELPIRES_VERSAO_APP=2.7.2%2Bcentralmykey
APIJOELPIRES_TIMEOUT_MS=90000
CACHE_SENHAS_JOELPIRES_TTL_SEGUNDOS=3600
```

`MAPA_MONTADORAS_API_JOELPIRES` é opcional e aceita um objeto JSON para substituir o mapa padrão.

## Validação

```bash
cd /opt/centralmykey-source/api
npm test
node --check rotas-pedidos.js
node --check processar-pedido-pago.js
node --check consulta-api-joelpires.js
```

O smoke opcional abaixo chama exclusivamente o ambiente de staging, ignora o
cache na leitura, grava qualquer atualização local dentro de uma transação e
sempre executa rollback. Ele não integra o `npm test`, não imprime chassi nem
valores retornados e recusa execução quando a configuração aponta para o
ambiente público.

```bash
cd /opt/centralmykey-source/api
CENTRALMYKEY_ENV_PATH=/opt/central-mykey-api/.env npm run test:joelpires:staging
```

Em 21/09/2026, esse smoke foi executado contra staging e confirmou resposta
`ENCONTRADO` com origem `API_JOELPIRES` e códigos utilizáveis. O rollback local
foi confirmado e nenhum valor de senha, chassi ou credencial foi exibido.
