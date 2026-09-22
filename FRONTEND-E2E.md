# Testes funcionais do frontend

O frontend usa Playwright com Chromium para percorrer comportamentos reais no
navegador. A maioria dos cenários intercepta a API no contexto do teste e usa
somente dados fictícios. Os cenários integrados sobem uma API local descartável,
usam autenticação JWT, permissões e rotas reais de pedidos, financeiro e
administração, mantendo todas as gravações MySQL em
uma transação externa revertida ao encerrar. Nenhuma requisição chega à API
publicada nem à API Joel Pires.

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
- confirmação de pagamento GM pelo navegador contra API e MySQL transacionais,
  comprovando resultado da API simulada, cache, custo zero, nenhum fornecedor,
  entrega pendente e rollback sem resíduos;
- resposta 404 percorrida nas mesmas camadas reais, com fornecedor fictício
  selecionado, custo persistido e consulta única na outbox;
- resposta 422 persistida como dados inválidos, seguida de correção pela rota
  real, nova consulta, conclusão, cache e entrega sem fornecedor;
- HTTP 503 persistido como indisponibilidade, alerta operacional mesmo após o
  histórico de pagamento, indicador e filtro próprios na fila, e
  reprocessamento posterior sem fornecedor;
- resultado de fornecedor registrado e confirmado pelas rotas reais, com
  consulta cancelada, cache alimentado e entrega preparada;
- fechamento semanal gerado pela tela financeira contra API e MySQL reais,
  com conferência dos itens, aprovação, despesa e pagamento únicos no celular;
- Financeiro, Relatórios, Usuários, Configurações, Auditoria e Monitoramento
  percorridos contra as rotas reais em 390 × 844, 768 × 1024 e 1440 × 1000,
  sem rolagem horizontal da página;
- cliente com faturamento semanal e plano VIP criado e bloqueado pela interface,
  fornecedor criado, vinculado a serviço/custo e bloqueado, com auditoria,
  persistência MySQL e rollback comprovados;
- indicadores e agrupamento por status do relatório reconciliados no navegador
  com a resposta autenticada da API real para o mesmo período e moeda;
- administração de integrações criando e desativando mapeamento WBuy e
  cadastrando, aprovando e ativando modelo WhatsApp fictício, com permissões,
  auditoria e rollback, sem chamadas a provedores externos;
- administrador criando, autorizando e bloqueando usuário pela interface; o
  visualizador também percorre Usuários, Configurações, Integrações, Clientes,
  Fornecedores, Financeiro e Pedidos sem controles de mutação e recebe HTTP 403
  ao tentar forçar escritas; todo o cenário usa JWT real e rollback;
- administração do Banco de Senhas concedida pela permissão `aprovar`, sem
  depender do ID do usuário, com cadastro real, desistência sem mutação,
  bloqueio confirmado, auditoria sem códigos e visualizador impedido na
  interface e por HTTP;
- atendimento móvel assumido da fila, nota interna, resposta WhatsApp mockada,
  mudança de etapa, transferência para outro usuário autenticado e finalização
  confirmada, com persistência real e rollback;
- configuração fictícia alterada após confirmação em tablet, valor omitido da
  auditoria, evento localizado na tela e monitoramento carregado; visualizador
  não recebe o botão nem consegue forçar a alteração pela API;
- estorno real iniciado pelo bloqueio de cancelamento, com lançamento reverso,
  pagamento de devolução e pedido cancelado atomicamente;
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
- retentativa direta após falha confirmada e confirmação obrigatória antes de
  repetir um envio incerto;
- bloqueio de cliente somente depois da confirmação;
- menu móvel e ausência de rolagem horizontal em 390 × 844 pixels;
- criação, pagamento, resultado, correção e validação GM dentro do viewport em
  390 × 844, 768 × 1024 e 1440 × 900, com ações finais alcançáveis;
- nomes acessíveis e `aria-modal` nos modais críticos do pedido GM.

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
