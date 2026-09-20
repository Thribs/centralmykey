# Central MyKey — auditoria funcional e roadmap

Auditoria da versão `v0.5.0` (`dfdb7c9`), realizada em 18/09/2026. Este documento avalia o produto completo; a versão `v0.5.0` comprova somente o tratamento dos destinos do fluxo GM depois do pagamento e o reprocessamento automático após indisponibilidade da API Joel Pires.

## Critério de classificação

- **COMPROVADO:** implementação percorrida de ponta a ponta, com rota, persistência, interface e teste funcional quando esses elementos se aplicam.
- **PARCIAL:** há uma parte útil implementada, mas falta um elo do fluxo ou prova funcional.
- **AUSENTE:** não foi encontrada implementação operacional do requisito.
- **BLOQUEADO:** a validação depende de credencial, contrato, ambiente ou decisão externa ainda indisponível.

Existência de tabela, campo, formulário ou função isolada não conta como conclusão.

## Estado verificado antes deste documento

- `main`, `origin/main` e a tag `v0.5.0` apontavam para `dfdb7c92f204d6c50ad076f2e6c6efaaabb09790`.
- A árvore estava limpa: `git status --short --branch` mostrou apenas `## main...origin/main`.
- O diff completo foi inspecionado com `git diff --no-ext-diff --unified=3 v0.4.1..v0.5.0` antes da criação deste arquivo.
- O intervalo contém 8 arquivos, 930 inserções e 1 remoção: `AGENTS.md`, `ATIVAR-REPROCESSAMENTO-GM.md`, `api/.env.example`, `api/package.json`, `api/reprocessar-pedidos-gm.js`, `api/server.js`, `api/teste-fluxo-gm-pos-pagamento.js` e `api/teste-reprocessamento-automatico-gm.js`.
- Esta auditoria foi criada na branch `docs/auditoria-roadmap-v050`. Não houve commit, merge, push, tag, publicação nem alteração nos diretórios publicados.

## Testes realmente executados para a v0.5.0

| Verificação executada | Tipo e isolamento | Resultado | Limite da prova |
|---|---|---|---|
| `node --check` nos arquivos JavaScript da API | Sintaxe; sem banco e sem rede | Passou | Não percorre regras de negócio |
| `npm test` em `api/` | Executa os quatro testes abaixo | Passou | Não testa uma requisição HTTP autenticada de ponta a ponta |
| `teste-consulta-banco.js` | Unitário puro; sem mock e sem banco | Passou | Só normalização/validação de chassi |
| `teste-consulta-api-joelpires.js` | Unitário; `fetch` falso, sem API externa e sem banco | Passou | Mapeamento, headers e consulta simulada |
| `teste-fluxo-gm-pos-pagamento.js` | Funcional de serviço; API mockada e MySQL real dentro de transação com `rollback` no `finally` | Passou | Não chama a rota de pagamento nem a interface; usa cliente/serviço existentes apenas como referência |
| `teste-reprocessamento-automatico-gm.js` | Funcional do worker; API mockada e MySQL real dentro de transação com `rollback` no `finally` | Passou | Não comprova fornecedor externo nem entrega ao cliente |
| `npm run lint` em `web/` | Análise estática | Passou | Não testa comportamento no navegador |
| `npm run build` em `web/` | Compilação Vite | Passou | Não testa integração frontend/backend |
| `systemctl is-active/show central-mykey-api.service` | Verificação operacional | Serviço ativo, execução sem erro | Não monitora dependências externas |
| `GET /health` da API publicada | Smoke test HTTP | HTTP 200 | O endpoint não testa todos os fluxos; `/health/db` não foi usado como teste funcional do produto |

Os testes integrados criaram registros somente dentro das transações e executaram rollback. A conferência posterior encontrou zero resíduos com os identificadores de teste em `pedidos_senha`, `pedido_resultados`, `pedido_historico`, `banco_senhas`, `lancamentos_financeiros`, `fatura_itens` e `pagamentos`. Nenhum dado real de negócio foi criado ou alterado pelos testes. Como comportamento normal do MySQL, contadores `AUTO_INCREMENT` podem avançar mesmo após rollback; isso não cria registro de negócio.

## Matriz de requisitos

### 1. Fluxo GM completo

| Requisito | Situação | Evidência concreta no código | Teste existente | Lacuna | Próximo passo | Risco operacional |
|---|---|---|---|---|---|---|
| Criação do pedido GM | PARCIAL | `POST /api/pedidos` em `api/rotas-pedidos.js:31`; formulário em `web/src/Pedidos.jsx`; persistência em `pedidos_senha` | Nenhum teste da rota/UI | Não há teste autenticado cobrindo validação, preço e cobrança antecipada/pós-paga | Teste HTTP transacional da criação para os dois tipos de cobrança | Pedido com valor, estado ou cliente incorreto |
| Pagamento e disparo do processamento GM | PARCIAL | `POST /api/pedidos/:id/pagamento/confirmar-manual` em `api/rotas-financeiro.js:239`; chama `processarPedidoPago`; tela `ConfirmarPagamento` em `web/src/Pedidos.jsx:527` | Testa o serviço após estado PAGO, não a rota de pagamento | Rota, lançamento, pagamento, auditoria e resposta à UI não são exercitados juntos | Teste funcional HTTP com rollback, incluindo idempotência | Cobrança duplicada ou pedido pago sem processamento |
| Cache local da API Joel Pires | COMPROVADO | Leitura/gravação em `api/consulta-api-joelpires.js` (`buscarCache`/`salvarCache`); `banco_senhas` guarda `fonte=API_JOELPIRES` | `teste-fluxo-gm-pos-pagamento.js` prova alimentação e remoção por rollback | A prova cobre GM; política de expiração ainda depende de configuração | Manter teste e acrescentar expiração/concorrência | Cache vencido ou conflitante devolver senha errada |
| Consulta à API Joel Pires no GM | COMPROVADO | `buscarSenhaFonteVerdade` em `api/consulta-api-joelpires.js`; configuração externa e timeout; sem `ID_TRANSACAO` | Mock de protocolo e teste funcional GM com todas as classes de resposta | Não há teste controlado contra staging no `npm test`, por decisão de isolamento | Criar smoke opcional, somente leitura, fora da suíte padrão | Mudança de contrato externo não detectada pelos mocks |
| Resultado encontrado | COMPROVADO | `api/processar-pedido-pago.js` conclui, custo 0, origem API, resultado CONFIRMADO e cache | Cenário 200 no teste funcional com MySQL/rollback | Entrega externa ao cliente é requisito separado e ausente | Preservar como regressão ao implementar entrega | Resultado concluído internamente sem chegar ao cliente |
| 404/SenhaNotFoundError | COMPROVADO | Classificação em `consulta-api-joelpires.js`; seleção do fornecedor em `processar-pedido-pago.js` | Cenário 404 comprova `NAO_ENCONTRADO`, Márcio, custo 22 e ausência de indisponibilidade | “Encaminhar” só atualiza banco; envio externo não existe | Implementar outbox/envio idempotente ao fornecedor | Operador interpreta EM_CONSULTA como consulta realmente enviada |
| Dados inválidos 400/417/422 | COMPROVADO | `processar-pedido-pago.js` grava `AGUARDANDO_DADOS`, custo 0 e histórico `DADOS_INVALIDOS_API_JOELPIRES` | Três cenários funcionais com mock e rollback | Não há fluxo de UI testado para corrigir e reenviar dados | Criar ação de correção/reprocessamento e teste da UI | Pedido pode ficar parado sem orientação ao operador |
| Rede, timeout e HTTP 5xx | COMPROVADO | Classificação `INDISPONIVEL`; pedido volta a `ABERTO` sem fornecedor/custo | Rede, AbortError e HTTP 503 no teste funcional | Estado `ABERTO` não comunica sozinho a causa na lista | Exibir estado específico/alerta de retentativa | Reprocessamento silencioso ou diagnóstico ambíguo |
| Reprocessamento automático | COMPROVADO | `api/reprocessar-pedidos-gm.js`; agendamento e trava no `api/server.js`; configuração em `.env.example` | Encontrado, nova indisponibilidade, inelegível, desabilitado; MySQL/rollback | Observabilidade limitada a logs e histórico | Criar métrica/alerta de fila, idade e falhas | Worker pode parar sem alerta operacional |
| Encaminhamento ao fornecedor | PARCIAL | Atualiza `fornecedor_id`, `origem_id`, custo e `EM_CONSULTA` em `processar-pedido-pago.js` | Persistência testada para 404 | Não há envio de mensagem/API, confirmação de entrega ou fila de saída | Implementar outbox e adaptador de envio | Pedido marcado como enviado sem o fornecedor recebê-lo |
| Recebimento do resultado do fornecedor | PARCIAL | `POST /api/pedidos/:id/resultado` em `rotas-pedidos.js:687`; formulário `ResultadoPedido.jsx`; grava resultado e conclui | Nenhum teste funcional | Entrada é manual e não valida vínculo/duplicidade de forma completa | Testar rota e definir canal automático de retorno | Resultado duplicado, atribuído ao pedido errado ou sem rastreio externo |
| Confirmação do resultado e cache | PARCIAL | `POST .../resultado/confirmar` em `rotas-pedidos.js:873`; atualiza/cria `banco_senhas` | Nenhum teste da rota | Não há teste de conflito, repetição e autorização | Testes transacionais de confirmação/incorreto | Cache contaminado por resposta incorreta |
| Entrega ao cliente | AUSENTE | Resultado aparece na consulta interna do pedido; não foi encontrado envio ao cliente vinculado à conclusão | Nenhum | Falta canal, comprovante de entrega, retentativa e estado ENTREGUE | Definir entrega por WhatsApp/portal e criar outbox | Cliente paga e não recebe automaticamente |
| Cancelamento do pedido | AUSENTE | Há bloqueio para resultado quando status já é CANCELADO, mas não há rota que cancele pedido | Nenhum | Falta transição, motivo, permissões e UI | Especificar máquina de estados e rota transacional | Pedidos presos e correções manuais no banco |
| Cancelamento/estorno financeiro | AUSENTE | `lancamentos_financeiros` aceita status CANCELADO, mas não há operação de estorno ligada ao pedido/pagamento | Nenhum | Falta lançamento reverso, conciliação e interface | Implementar estorno auditável após regra de cancelamento | Receita fica reconhecida após cancelamento |

### 2. Fornecedores GM

| Requisito | Situação | Evidência concreta no código | Teste existente | Lacuna | Próximo passo | Risco operacional |
|---|---|---|---|---|---|---|
| Márcio, 08h–22h, R$ 22 | PARCIAL | Regra documentada em `AGENTS.md`; seleção lê `fornecedores`/`fornecedor_servicos`; teste encontra Márcio e custo 22 ao fixar 12h | Cenário 404 com rollback | Horários e custo dependem de dados cadastrados; não há teste de fronteiras 08h/22h | Testar configuração e limites de horário | Alteração cadastral muda prioridade sem alerta |
| Emerson, 08h–19h, R$ 25 | PARCIAL | Estrutura suporta horário/custo e regra está em `AGENTS.md` | Nenhum cenário seleciona Emerson | Não há prova de fallback para Emerson nem dos limites 08h/19h | Teste funcional com Márcio indisponível/inativo | Ausência de fallback deixa pedido aberto |
| Prioridade entre fornecedores | PARCIAL | SQL usa `ORDER BY fs.custo ASC LIMIT 1` e disponibilidade por `CURTIME()` | Só prova Márcio ao meio-dia | Empate não tem desempate determinístico; não há prioridade explícita além do custo | Definir prioridade e testar todos os horários/empates | Seleção varia ou escolhe fornecedor indevido |
| Envio da consulta | AUSENTE | Nenhuma chamada WhatsApp/API/outbox parte do fluxo de pedidos | Nenhum | Apenas atribuição no banco | Criar outbox idempotente e recibo de envio | Consulta nunca chega ao fornecedor |
| Retorno do fornecedor | PARCIAL | Rota manual de resultado e interface interna | Nenhum | Sem webhook, identificação externa ou confirmação do fornecedor | Definir protocolo de retorno e deduplicação | Resultado manual sujeito a erro humano |
| Duplicidade | PARCIAL | Pedido concluído rejeita novo resultado com 409 | Nenhum | Duas requisições concorrentes podem criar duplicidade antes da conclusão; falta chave/idempotency key externa | Adicionar restrição/idempotência e teste concorrente | Resultados e custos duplicados |
| Fechamento semanal do fornecedor | AUSENTE | `processar-faturas-semanais.js` fecha faturas de clientes; não há conta/fatura semanal de fornecedor | Nenhum | Falta apuração, aprovação e pagamento dos custos de Márcio/Emerson | Modelar contas a pagar por fornecedor | Custo operacional sem conferência/pagamento rastreável |

### 3. Pagamentos

| Requisito | Situação | Evidência concreta no código | Teste existente | Lacuna | Próximo passo | Risco operacional |
|---|---|---|---|---|---|---|
| Confirmação manual | PARCIAL | Rota financeira transacional, lançamento RECEBIDO, `pagamentos`, histórico e auditoria; tela com timeout de 105s | Nenhum teste da rota completa | Falta teste de duplicidade, rollback e reconciliação da resposta incerta | Primeiro próximo marco: teste funcional e idempotência | Duplo pagamento após timeout/repetição |
| Sicoob | AUSENTE | Nome aceito como `meio_pagamento` e indicador de credenciais em `rotas-administracao.js` | Nenhum | Sem cliente API, webhook, conciliação ou validação de assinatura | Obter contrato e implementar integração em sandbox | Pagamento rotulado Sicoob sem confirmação bancária |
| PlugPay | AUSENTE | Nome aceito como meio e indicador de configuração | Nenhum | Sem API/webhook/conciliação | Definir contrato PlugPay e sandbox | Confirmação manual confundida com automática |
| WBuy | AUSENTE | Nome aceito como meio e indicador de configuração | Nenhum | Sem importação/webhook/vínculo com pedido | Mapear eventos e identificadores WBuy | Venda externa não entra ou duplica |
| Cliente, comprador e pagador separados | AUSENTE | Pedido referencia `cliente_id`; não foram encontrados campos/entidades de comprador e pagador | Nenhum | Modelo de dados e telas não distinguem os papéis | Definir identidades e regras fiscais/privacidade | Cobrança e atendimento atribuídos à pessoa errada |
| Estorno e cancelamento | AUSENTE | Sem rota de estorno; apenas status possíveis em tabelas | Nenhum | Falta integração com meios, lançamento reverso e auditoria | Implementar após máquina de estados do pedido | Divergência financeira e chargeback manual |

### 4. Demais consultas

| Requisito | Situação | Evidência concreta no código | Teste existente | Lacuna | Próximo passo | Risco operacional |
|---|---|---|---|---|---|---|
| Kia/Hyundai até 2016 | PARCIAL | Mapa da API associa Kia/Hyundai à montadora 2 em `consulta-api-joelpires.js` | Só teste de mapa para outras marcas; nenhum fluxo Kia/Hyundai | Sem serviço comprovado, regra de corte por ano, preço, fornecedor, UI e teste | Especificar produto e fluxo até 2016 | Consulta enviada ao processo/preço errado |
| Kia/Hyundai 2017+ | PARCIAL | Mesmo mapa genérico da montadora 2 | Nenhum | Não existe ramificação por ano nem fluxo próprio | Especificar diferenças e teste 2016/2017 | Dois produtos distintos tratados como um |
| Fiat | PARCIAL | Mapa montadora 4 | Nenhum funcional | Falta serviço, regras, preço, fornecedor, UI e teste comprovados | Implementar vertical completo depois do GM | Falsa impressão de suporte por existir apenas o mapa |
| Nissan | PARCIAL | Mapa montadora 5 | Nenhum funcional | Mesma lacuna de vertical completo | Implementar e homologar contrato de resposta | Pedido sem destino operacional |
| Jeep/Chrysler/Dodge | PARCIAL | Mapa montadora 6 | Teste unitário apenas de Jeep→6 | Sem produto, regras e teste funcional | Definir marcas aceitas e vertical | Classificação genérica mascara exceções |
| Peugeot/Citroën | PARCIAL | Mapa montadora 3 | Teste unitário Citroën→3 | Sem produto, regras e teste funcional | Definir vertical e homologar acentos/aliases | Marca pode mapear certo e processo falhar depois |
| Senha de rádio | PARCIAL | Há `codigo_radio` em cache/resultados e formulário de resultado | Somente campo preenchido no mock GM | Não há serviço dedicado, preço, entrada, destino e entrega testados | Especificar produto “senha de rádio” ponta a ponta | Campo técnico confundido com produto comercial |
| Programação online | AUSENTE | Não foi encontrada rota, persistência de agenda/sessão, tela ou teste | Nenhum | Produto inteiro não modelado | Levantar requisitos antes de implementar | Agenda, cobrança e execução ficam fora da Central |

### 5. Integrações

| Requisito | Situação | Evidência concreta no código | Teste existente | Lacuna | Próximo passo | Risco operacional |
|---|---|---|---|---|---|---|
| WhatsApp | PARCIAL | Webhook GET/POST em `rotas-whatsapp.js:207/243`; persistência de atendimentos/mensagens; envio em `rotas-atendimento.js:1366`; UI `Atendimento.jsx` | Nenhum funcional | Depende de credenciais Meta e não está ligado à entrega de pedidos/fornecedores; dashboard diz “Aguardando Meta” | Homologar em ambiente de teste, validar assinatura, deduplicação e status | Mensagem perdida/duplicada ou promessa visual incorreta |
| WBuy | AUSENTE | Apenas indicador de configuração e rótulo de pagamento | Nenhum | Sem implementação de negócio | Especificar sincronização, webhook e reconciliação | Pedidos externos desconectados |
| Bling na transição | AUSENTE | Nenhuma referência no código ativo | Nenhum | Sem importação, exportação ou plano de coexistência | Mapear dados e estratégia de corte/migração | Dupla escrituração e perda de histórico |
| API Joel Pires | PARCIAL | Cliente, cache, classificação e testes do fluxo GM | Mocks unitários/funcionais | Outras montadoras não têm verticais comprovadas; staging real não faz parte da suíte | Contratos por produto e smoke opcional controlado | Mudança externa quebra produtos não testados |
| Notificações internas | AUSENTE | Ícone de sino em `Painel.jsx` não tem ação; notas internas de atendimento não formam um sistema de notificações | Nenhum | Falta entidade, rota, leitura, contador e entrega | Modelar eventos e caixa de notificações | Pendências críticas passam despercebidas |

### 6. Administração

| Requisito | Situação | Evidência concreta no código | Teste existente | Lacuna | Próximo passo | Risco operacional |
|---|---|---|---|---|---|---|
| Clientes | PARCIAL | CRUD/resumo/status em `server.js` e `rotas-cadastros.js`; UI `Cadastros.jsx` | Nenhum funcional | Sem teste de permissões, duplicidade e concorrência | Testes HTTP transacionais e UI crítica | Cadastro duplicado/bloqueio indevido |
| VIP | PARCIAL | Tabela `cliente_vip`; detalhe e configuração de cobrança usam dados VIP | Nenhum funcional | Fluxo comercial completo, vencimento e renovação não comprovados | Documentar regras e testar ciclo VIP | Preço/cobrança divergente |
| Fornecedores | PARCIAL | CRUD/status e vínculo `fornecedor_servicos`; UI | Apenas seleção indireta de Márcio | Sem gestão testada de serviços/custos e auditoria de mudança | Testar CRUD e vínculo por serviço | Mudança operacional silenciosa |
| Usuários e permissões | PARCIAL | Auth, CRUD, `usuario_permissoes`, middleware `exigirPermissao`; UI `Administracao.jsx` | Nenhum funcional | Sem matriz de testes de autorização/negação | Testar cada módulo e ação com perfis | Acesso indevido ou bloqueio de operação |
| Relatórios | PARCIAL | Rotas em `rotas-relatorios.js`; UI `Relatorios.jsx` | Nenhum funcional | Números não foram reconciliados com cenários conhecidos/exportação | Dataset transacional de referência e testes de totais | Decisão gerencial baseada em total incorreto |
| Financeiro | PARCIAL | Resumo, lançamentos e faturas em `rotas-financeiro.js`/`rotas-relatorios.js`; UI `Financeiro.jsx` | Fluxo GM verifica ausência de resíduos, não o financeiro | Sem estorno, conciliação automática e testes funcionais | Testar confirmação manual e depois conciliações | Saldo inconsistente e duplicidade |
| Auditoria | PARCIAL | Várias rotas gravam em `auditoria` | Nenhum | Não há consulta/interface de trilha encontrada; cobertura de ações é desigual | Criar visualização imutável e testar eventos críticos | Alterações sem investigação possível |
| Backup | PARCIAL | Procedimento operacional exige backup e há backups datados de publicação | Restauração não foi testada nesta auditoria | Sem automação, retenção, monitoramento e ensaio de restore | Definir política e teste periódico de restauração | Backup existente pode não ser restaurável |
| Monitoramento | PARCIAL | `/health`, `/health/db`, systemd e logs do worker | Smoke de serviço e `/health` | Sem métricas, alertas, fila antiga, falha de integração ou SLO | Implantar observabilidade e alertas mínimos | Falha silenciosa prolongada |

### 7. Frontend

| Requisito | Situação | Evidência concreta no código | Teste existente | Lacuna | Próximo passo | Risco operacional |
|---|---|---|---|---|---|---|
| Carregamento e timeout | PARCIAL | Componentes usam estados `carregando`; confirmação de pagamento tem AbortController de 105s em `api.js:768` | Build/lint apenas | Demais chamadas usam `fetch` sem timeout/política comum | Cliente HTTP central com timeout e teste de browser | Tela fica indefinidamente aguardando |
| Mensagens de erro | PARCIAL | `lerResposta` propaga mensagem e telas exibem estados de erro | Build/lint apenas | Sem padronização por código, correlação e teste de recuperação | Contrato de erro e testes de falha | Mensagem genérica induz repetição perigosa |
| Estados intermediários | PARCIAL | UI mostra estados de pedidos/atendimentos e bloqueia botões durante ações | Build/lint apenas | Causa da indisponibilidade/reprocessamento não é explícita nem testada | Modelar estados operacionais e testes E2E | Operador toma ação errada sobre pedido em retentativa |
| Responsividade | PARCIAL | `App.css` tem media queries entre 520px e 1120px | Nenhum teste visual | Não há matriz de dispositivos ou regressão visual | Validar fluxos críticos em celular/tablet/desktop | Ação crítica inacessível em tela pequena |
| Confirmação de ações destrutivas | PARCIAL | Confirmações em cancelamento/finalização de atendimento e bloqueio de cliente/fornecedor | Nenhum funcional | Não há política comum; cancelamento de pedido/estorno nem existem | Mapear ações destrutivas e testar confirmação | Exclusão/bloqueio acidental ou experiência inconsistente |
| Correspondência frontend/backend | PARCIAL | `Painel.jsx` liga módulos reais a componentes e `api.js` chama rotas existentes | Build/lint apenas | Sem teste de contrato/E2E; sino e busca global são visuais sem função; integrações exibem configuração sem operação | Teste de contrato e E2E dos fluxos críticos | Interface promete capacidade inexistente ou quebra após mudança de API |

## Divergências entre regra documentada e código atual

1. A regra diz “encaminhar ao fornecedor”; o código apenas atribui fornecedor/custo/status. Não envia a consulta.
2. Márcio e Emerson, horários e custos estão documentados e dependem de cadastro vivo. Só Márcio/custo 22 foi exercitado; Emerson e fronteiras de horário não foram provados.
3. A API Joel Pires é descrita como fonte de verdade das senhas, mas somente a vertical GM está coberta funcionalmente. O mapa de outras montadoras não constitui fluxo completo.
4. A tela e a API aceitam Sicoob, PlugPay e WBuy como nomes de meio de pagamento, embora não exista confirmação automática dessas integrações.
5. O dashboard afirma que o backend WhatsApp está preparado e validado, mas não há teste funcional executado e a própria tela informa que aguarda a Meta.
6. A conclusão do pedido não entrega o resultado ao cliente nem registra comprovante de entrega.
7. O sistema reconhece o estado CANCELADO em leituras/validações, mas não oferece cancelamento completo de pedido com reversão financeira.
8. O fechamento semanal implementado é de faturas de clientes. Não existe fechamento semanal dos custos de fornecedores.

## O que está realmente pronto

- Classificação do resultado da API Joel Pires para GM: encontrado, não encontrado, dados inválidos e indisponibilidade.
- Persistência transacional dos destinos internos desses quatro casos depois do pagamento.
- Cache local da API para GM e conclusão automática quando há senha.
- Retentativa automática, com trava MySQL, para pedidos GM parados por indisponibilidade.
- Proteção dos testes GM com API mockada, transação MySQL e rollback confirmado.
- Serviço publicado ativo e endpoint `/health` respondendo 200 na validação da v0.5.0.

## O que está parcialmente implementado

- O fluxo comercial GM anterior e posterior ao núcleo testado: criação, pagamento via rota, envio real ao fornecedor, retorno, entrega, cancelamento e financeiro completo.
- Cadastro e seleção dos fornecedores, especialmente fallback para Emerson, duplicidade e fechamento semanal.
- Administração, relatórios, financeiro, WhatsApp e frontend: existem estruturas úteis, porém faltam provas funcionais e elos operacionais.
- Demais montadoras: existe mapeamento técnico na API, sem verticais de produto comprovadas.
- Pagamentos externos: existem rótulos e campos de configuração, sem integração e conciliação.

## Próximos 10 marcos em ordem de dependência

1. **Fechar o contrato e a máquina de estados do pedido GM**, incluindo correção de dados, enviado, recebido, entregue, cancelado e regras financeiras.
2. **Tornar a confirmação manual de pagamento idempotente e testá-la pela rota**, cobrindo lançamento, pagamento, processamento, timeout e repetição com rollback.
3. **Criar uma outbox transacional para comunicações**, base comum para fornecedor, cliente e notificações, com idempotência e retentativa.
4. **Enviar a consulta GM ao fornecedor selecionado**, registrar recibo/falha e só então representar corretamente o estado operacional.
5. **Receber e deduplicar o retorno do fornecedor**, por protocolo externo e com teste concorrente.
6. **Entregar o resultado ao cliente e registrar o comprovante**, inicialmente pelo canal definido para WhatsApp, com retentativa.
7. **Implementar cancelamento e estorno ponta a ponta**, preservando histórico, lançamentos reversos e conciliação.
8. **Fechar a operação financeira dos fornecedores**, com apuração semanal de custos, conferência e pagamento.
9. **Homologar WhatsApp e implementar notificações/monitoramento**, incluindo filas antigas, falhas do worker e erros de integração.
10. **Construir cada nova vertical de consulta como fluxo completo**, começando pela prioridade comercial definida: serviço, preço, dados, fonte, fornecedor, pagamento, entrega, UI e teste funcional; depois integrar WBuy/Sicoob/PlugPay/Bling conforme contratos.

## Próximo marco recomendado

O próximo marco deve ser **o contrato da máquina de estados GM junto com o teste funcional e a idempotência da confirmação manual de pagamento**. Pagamento é a entrada do fluxo já testado e hoje apresenta o maior risco imediato: o frontend admite que um timeout pode levar o operador a repetir a confirmação, enquanto a rota não possui uma chave de idempotência comprovada. Fechar esse ponto cria uma base segura para a outbox, o envio ao fornecedor, a entrega e os cancelamentos seguintes.

## Progresso posterior à auditoria da v0.5.0

Na branch `feature/pagamento-manual-idempotente`, ainda não publicada:

- a confirmação manual foi tornada idempotente por pedido, meio e referência/comprovante;
- foi adicionado teste funcional da rota HTTP com MySQL e rollback;
- foi criada uma outbox transacional para consultas a fornecedores;
- o transporte WhatsApp usa modelo da Meta e permanece desabilitado por padrão;
- timeout, rede e HTTP 5xx de envio são classificados como `INCERTA` e não repetem automaticamente;
- a interface diferencia consulta atribuída, pendente, enviada, falha e incerta;
- o retorno manual do fornecedor só é aceito em pedido `EM_CONSULTA` com fornecedor atribuído, e a repetição do mesmo resultado é idempotente;
- a rota de retorno possui teste HTTP com MySQL e rollback, incluindo estado inválido, cancelamento da comunicação pendente e tentativa divergente;
- resultados confirmados são preparados uma única vez para entrega ao cliente pela outbox, tanto na resposta automática da API quanto após confirmação do fornecedor;
- a interface separa consulta ao fornecedor de entrega ao cliente e mostra pendências e falhas de cada finalidade;
- o webhook assinado da Meta registra `ENTREGUE` e `LIDA` sem permitir regressão, com teste funcional e rollback;
- o cancelamento seguro possui rota, interface, histórico, auditoria e teste HTTP com rollback; pedidos sem obrigação externa cancelam comunicações e ajustam fatura aberta;
- pagamentos existentes, consulta já enviada, fatura fechada e pedido concluído são bloqueados com códigos explícitos até existir política de estorno e custo aprovada;
- o fechamento semanal de fornecedores apura somente resultados confirmados, impede duplicidade, cria uma despesa após aprovação e registra o pagamento manual de forma idempotente;
- a interface financeira permite gerar a última semana concluída, conferir os itens, aprovar e registrar o pagamento; períodos ainda abertos não podem ser aprovados;
- o teste funcional do fechamento percorre rotas, persistência e financeiro usando MySQL com rollback e confirma que não deixa resíduos;
- o estorno manual integral registra uma despesa vinculada ao pagamento original e pode cancelar o pedido na mesma transação, com idempotência, histórico, auditoria e teste de rollback;
- tentativas de estornar e cancelar após possível envio ao fornecedor são revertidas integralmente; a movimentação bancária continua manual e exige referência ou comprovante;
- a ativação continua bloqueada até homologar os dois modelos da Meta e confirmar contatos válidos de fornecedores e clientes.

Esses itens continuam **PARCIAIS** até as migrações serem validadas para publicação, os modelos serem homologados, o fluxo ser publicado com backup e um envio controlado ser comprovado sem dados reais. O fechamento de fornecedores também depende da aprovação da política operacional de período e pagamento; ele registra pagamentos realizados, mas não movimenta a conta bancária.
