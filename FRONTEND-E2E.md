# Testes funcionais do frontend

O frontend usa Playwright com Chromium para percorrer comportamentos reais no
navegador. A API é interceptada dentro do contexto do teste e responde somente
com dados fictícios; nenhuma requisição chega à API publicada, à API Joel Pires
ou ao banco de dados.

A suíte cobre inicialmente:

- sessão autenticada e carregamento do painel;
- busca global de pedido, seleção do resultado e aplicação do filtro no módulo;
- exibição do código e da referência de uma falha HTTP;
- recuperação da fila após uma atualização bem-sucedida;
- cancelamento de pedido com motivo, desistência sem requisição, confirmação,
  estado intermediário e uma única mutação;
- confirmação manual de pagamento com identificação do pagador, bloqueio do
  formulário durante o processamento, uma única mutação e atualização do
  pedido concluído;
- estorno seguido de cancelamento com desistência sem mutação financeira,
  confirmação explícita da devolução, estado intermediário e uma única
  requisição de estorno;
- recebimento do resultado de fornecedor, validação humana, bloqueio durante
  as duas mutações e preparação de uma única entrega ao cliente;
- rejeição de resultado incorreto, validação do motivo, mutação única e nova
  consulta ao próximo fornecedor com custo atualizado;
- correção de dados GM rejeitados, reprocessamento único, conclusão pela API
  simulada e ausência de encaminhamento ao fornecedor;
- indisponibilidade da API explicada ao operador, custo e fornecedor zerados,
  reprocessamento único e conclusão posterior;
- bloqueio de cliente somente depois da confirmação;
- menu móvel e ausência de rolagem horizontal em 390 × 844 pixels.

Instalação do navegador e das bibliotecas necessárias no ambiente de teste:

```bash
cd /opt/centralmykey-source/web
npx playwright install --with-deps chromium
```

Execução isolada:

```bash
npm run test:e2e
```

`npm test` também executa os testes E2E depois dos testes unitários do cliente
HTTP. Evidências de falha ficam em `test-results/`, que não é versionado.
