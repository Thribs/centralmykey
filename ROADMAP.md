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
| Márcio, 08h–22h, R$ 22 | COMPROVADO | Seleção por disponibilidade/custo em `selecionar-fornecedor.js` | `teste-selecao-fornecedores-gm.js` cobre 08h, 22h, indisponibilidade e custo R$ 22 com rollback | Cadastro operacional ainda pode ser alterado por administrador | Auditar mudanças de serviço/custo | Alteração cadastral indevida muda a seleção |
| Emerson, 08h–19h, R$ 25 | COMPROVADO | Fallback por disponibilidade/custo em `selecionar-fornecedor.js` | `teste-selecao-fornecedores-gm.js` cobre 08h, 19h, fallback e custo R$ 25 com rollback | Cadastro operacional ainda pode ser alterado por administrador | Auditar mudanças de serviço/custo | Alteração cadastral indevida muda a seleção |
| Prioridade entre fornecedores | COMPROVADO | Menor custo disponível, com desempate determinístico, em `selecionar-fornecedor.js` | `teste-selecao-fornecedores-gm.js` cobre prioridade e fallback | Nenhuma lacuna funcional conhecida na regra atual | Manter regressão ao alterar fornecedores | Configuração cadastral incorreta muda o resultado |
| Envio da consulta | PARCIAL | Outbox idempotente, worker e estados de entrega em `processar-comunicacoes-outbox.js`; fila visível no pedido | `teste-envio-fornecedor-gm.js` cobre agenda, envio único, falha incerta e reprocessamento com rollback | Falta homologação com Meta e contatos reais | Homologar modelos e destinatários controlados | Código pronto, mas envio real permanece desabilitado |
| Retorno do fornecedor | PARCIAL | Rota transacional de resultado, confirmação e entrega em `rotas-pedidos.js` | `teste-resultado-fornecedor.js` cobre estado, idempotência e rollback | Retorno externo do fornecedor ainda depende de operação interna | Definir resposta estruturada pelo canal homologado | Digitação manual pode introduzir erro |
| Duplicidade | COMPROVADO | Chaves de idempotência na outbox e bloqueios transacionais em resultado/entrega | Testes de envio, resultado e entrega repetem operações e confirmam um único efeito | Nenhuma lacuna conhecida nos caminhos testados | Manter testes em mudanças concorrentes | Novo canal sem chave própria pode reintroduzir duplicidade |
| Fechamento semanal do fornecedor | COMPROVADO | Tabelas, apuração, aprovação e pagamento idempotente em `rotas-fechamentos-fornecedores.js` | `teste-fechamento-fornecedor.js` com rollback | Exportação bancária não faz parte do fluxo atual | Manter reconciliação ao integrar pagamentos | Operador ainda registra a referência do pagamento |

### 3. Pagamentos

| Requisito | Situação | Evidência concreta no código | Teste existente | Lacuna | Próximo passo | Risco operacional |
|---|---|---|---|---|---|---|
| Confirmação manual | COMPROVADO | Rota transacional, lançamento, pagamento, histórico, auditoria e tela com timeout específico | `teste-pagamento-manual-idempotente.js` cobre repetição, divergência e rollback | Nenhuma lacuna funcional conhecida na confirmação manual | Manter regressão com conectores automáticos | Referência informada incorretamente continua sendo risco operacional |
| Sicoob | PARCIAL | Cliente OAuth2/mTLS de cobrança, base idempotente de eventos, referência `txid` → pedido, parser Pix e consulta administrativa em `cliente-sicoob-pix.js`, `sicoob-pix.js` e `rotas-integracoes.js` | `teste-eventos-pagamento-integracao.js` e `teste-sicoob-pix.js` cobrem criação simulada da cobrança, correlação, conclusão GM, reentrega, `txid` desconhecido, consulta HTTP e rollback | Falta instalar mTLS no proxy e homologar cobrança/webhook com o Sicoob | Obter certificados de homologação e preparar configuração Nginx revisável antes de abrir o webhook | Ativar endpoint sem mTLS permitiria eventos de pagamento não autenticados; por isso a rota pública segue ausente |
| PlugPay | PARCIAL | Base comum aceita provedor PLUGPAY e separa credencial de conector | Testes da base idempotente com provedor simulado | Produto/contrato PlugPay ainda não identificado | Confirmar fornecedor e implementar adaptador assinado | Sem contrato, pagamento continua manual |
| WBuy | PARCIAL | Credenciais corrigidas para usuário/senha/URL; tabela, rotas e interface associam produto/SKU externo a serviço MyKey | `teste-mapeamentos-integracoes.js` cobre criação, atualização, colisão, status, auditoria HTTP e rollback | Esquema/autenticação do webhook e importação de pedidos ainda não comprovados | Obter payload real controlado ou documentação privada da conta e implementar normalizador | Ativar webhook sem autenticação permitiria pedidos falsos; por isso a entrada segue ausente |
| Cliente, comprador e pagador separados | COMPROVADO | Snapshots em `pedido_partes`, API de criação/detalhe e interface exibem os três papéis | `teste-criacao-pedido-pospago.js` valida herança e separação com rollback | Nenhuma lacuna conhecida no modelo atual | Integrar os papéis aos sistemas externos | Mapeamento externo incorreto pode trocar o pagador |
| Estorno e cancelamento | PARCIAL | Cancelamento seguro, lançamento reverso, estorno manual, auditoria e interface | `teste-cancelamento-pedido.js` e `teste-estorno-cancelamento.js` cobrem atomicidade/idempotência com rollback | Estorno automático nos provedores externos ainda não existe | Ligar adaptadores após pagamentos automáticos | Central pode registrar estorno antes da confirmação do provedor |

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
| WhatsApp | PARCIAL | Transporte, webhook assinado, mensagens, mídia, outbox e configuração unificada em `api/rotas-whatsapp.js` e `api/configuracoes-integracoes.js` | Testes funcionais de envio, status e configuração com mocks; testes de banco usam rollback | Homologação com conta/modelos Meta e contatos reais ainda não executada | Configurar credenciais/modelos e homologar com destinatários controlados | Código pronto, mas mensagens reais continuam desabilitadas até homologação |
| WBuy | PARCIAL | Mapeamento persistente e auditado de produtos/SKUs para serviços; credenciais REST modeladas conforme ajuda oficial; tela administrativa | `teste-mapeamentos-integracoes.js` usa HTTP e banco com rollback | Falta normalizador do payload, autenticação do webhook e criação dos pedidos | Validar payload `order`/`order_status` da conta antes de abrir endpoint | Payload não autenticado ou interpretado por suposição pode criar pedidos falsos/incorretos |
| Bling na transição | PARCIAL | Compartilha o mapeamento produto/SKU → serviço e a tela administrativa | Mesmo teste comprova vínculos BLING/WBUY na estrutura comum, embora o cenário funcional use WBUY | Sem OAuth, importação/exportação ou máquina de coexistência | Implementar OAuth e leitura controlada antes de sincronizar estados | Dupla escrituração e perda de histórico continuam possíveis até definir autoridade por entidade |
| API Joel Pires | PARCIAL | Cliente, cache, classificação e testes do fluxo GM | Mocks unitários/funcionais | Outras montadoras não têm verticais comprovadas; staging real não faz parte da suíte | Contratos por produto e smoke opcional controlado | Mudança externa quebra produtos não testados |
| Notificações internas | COMPROVADO | Entidades, rotas, contador, caixa no frontend e resolução por chave | `teste-notificacoes-internas.js` cobre acesso, leitura, reativação e resolução com rollback | Nenhuma lacuna funcional conhecida no escopo interno | Ampliar eventos conforme novos conectores | Evento novo sem notificação pode ficar silencioso |

### 6. Administração

| Requisito | Situação | Evidência concreta no código | Teste existente | Lacuna | Próximo passo | Risco operacional |
|---|---|---|---|---|---|---|
| Clientes | COMPROVADO | CRUD, resumo, busca, bloqueio e auditoria em `api/rotas-clientes.js`; interface em `web/src/Cadastros.jsx` | `api/teste-clientes-vip.js` percorre as rotas HTTP e confirma rollback | Nenhuma lacuna funcional conhecida no cadastro básico | Manter regressão ao integrar canais externos | Baixo; unicidade e alterações críticas são transacionais e auditadas |
| VIP | PARCIAL | Ciclo dos cinco estados, mensalidade, vencimento, cancelamento e reativação em `api/rotas-clientes.js`; interface de criação/edição | `api/teste-clientes-vip.js` cobre criação, suspensão, cancelamento e reativação com rollback | Cobrança recorrente e transição automática por vencimento dependem da integração de pagamentos | Definir cobrança VIP junto de Sicoob/PlugPay | Plano pode exigir acompanhamento manual até a automação financeira |
| Fornecedores | COMPROVADO | CRUD/status; regras de serviço, marca, modelo, ano, custo, moeda e prazo; interface em `Cadastros.jsx`; todas as mutações são transacionais e auditadas | `teste-cadastro-fornecedores.js` percorre criação, edição, bloqueio, vínculo, duplicidade, permissões, cinco auditorias e rollback | Nenhuma lacuna funcional conhecida nas operações testadas | Manter regressão e reconciliar novos tipos de serviço | Configuração incorreta autorizada pode mudar custo ou seleção operacional |
| Usuários e permissões | COMPROVADO | Auth, CRUD, perfis, status, matriz por módulo/ação, auditoria transacional e interface administrativa | `teste-autorizacao.js` cobre autenticação; `teste-administracao-usuarios.js` percorre JWT real, criação, duplicidade, edição, bloqueio, autobloqueio, matriz, validação, quatro auditorias e rollback | Nenhuma lacuna funcional conhecida nos caminhos testados | Manter regressão ao criar novos módulos e permissões | Concessão administrativa incorreta ainda exige controle humano |
| Relatórios | COMPROVADO | Relatório operacional por período, moeda, status, fornecedor, origem e dia em `rotas-relatorios.js`; UI `Relatorios.jsx` | `teste-relatorios.js` reconcilia totais conhecidos, separa BRL/USD, valida datas, período, agrupamentos e rollback | Exportação não integra o escopo operacional atualmente implementado | Manter dataset de regressão ao criar novos indicadores | Indicador novo sem separação monetária pode produzir soma inválida |
| Financeiro | COMPROVADO | Resumo, lançamentos, faturas, pagamentos, estornos e fechamentos de fornecedores; interface com filtro monetário | `teste-financeiro-resumo.js` reconcilia moedas, realizados, pendências, vencidos, filtros e recebido hoje; testes de pagamento, estorno e fechamento cobrem mutações com rollback | Conciliação bancária externa permanece no requisito específico do Sicoob | Manter reconciliação interna ao homologar conectores bancários | Evento externo incorreto pode divergir da posição interna se o conector for ativado sem homologação |
| Auditoria | PARCIAL | Rota paginada, filtros, interface restrita e registros nas ações críticas | `teste-auditoria.js` cobre permissão, paginação e não exposição de dados sensíveis | Cobertura ainda precisa acompanhar cada novo módulo | Exigir evento de auditoria nos próximos conectores | Ação nova pode ficar sem trilha |
| Backup | PARCIAL | Pacote verificável da API, web e banco; restauração com hashes e cópia de segurança; agenda systemd, trava e retenção estão preparadas | `teste-backup.js` cobre restauração/corrupção; `teste-backup-agendado.js` cobre retenção/concorrência; `teste-backup-mysql.js` percorre gzip e cliente MySQL com tabela temporária e duas transações revertidas | Timer ainda não foi instalado; a credencial não pode criar schema para um ensaio integral descartável | Instalar o timer na publicação aprovada e executar restauração integral em instância/schema isolado com credencial própria | A prova temporária não demonstra que todo o esquema e volume do banco real restauram corretamente |
| Monitoramento | PARCIAL | `/health`, `/health/ready`, `/health/db` e `/api/monitoramento/resumo`; tela administrativa agrega pedidos, outbox, integrações e notificações por severidade | `teste-health.js` cobre processo/banco; `teste-monitoramento.js` cobre permissão, atrasos, falhas, minimização e rollback | Falta encaminhar alertas críticos para um canal externo e definir SLO operacional | Ligar severidade crítica ao canal homologado e estabelecer SLO | Equipe ainda depende de abrir a Central para perceber uma falha crítica |

### 7. Frontend

| Requisito | Situação | Evidência concreta no código | Teste existente | Lacuna | Próximo passo | Risco operacional |
|---|---|---|---|---|---|---|
| Carregamento e timeout | COMPROVADO | Cliente comum `web/src/http.js` aplica timeout e mensagens específicas; pagamento mantém 105s | `web/teste-http.js`, lint e build | Nenhuma lacuna conhecida no cliente HTTP atual | Manter testes ao adicionar chamadas | Operação longa nova exige timeout explícito |
| Mensagens de erro | PARCIAL | Todas as respostas possuem `X-Request-ID`; erros JSON preservam códigos específicos ou recebem código estável pelo status; JSON inválido e limite têm classificação própria; frontend exibe a referência sem detalhes internos | `teste-erros-http.js` cobre correlação, códigos específicos/genéricos, JSON, limite, 404 e 500 seguro; `web/teste-api.js` cobre status, código e referência | Ainda não há teste de recuperação no navegador | Testar recuperação E2E nos fluxos críticos | Mensagem está padronizada, mas reação da interface a cada falha ainda não foi provada no navegador |
| Estados intermediários | PARCIAL | UI mostra estados de pedidos/atendimentos e bloqueia botões durante ações | Build/lint apenas | Causa da indisponibilidade/reprocessamento não é explícita nem testada | Modelar estados operacionais e testes E2E | Operador toma ação errada sobre pedido em retentativa |
| Responsividade | PARCIAL | `App.css` tem media queries entre 520px e 1120px | Nenhum teste visual | Não há matriz de dispositivos ou regressão visual | Validar fluxos críticos em celular/tablet/desktop | Ação crítica inacessível em tela pequena |
| Confirmação de ações destrutivas | PARCIAL | Confirmações em cancelamento/finalização de atendimento e bloqueio de cliente/fornecedor | Nenhum funcional | Não há política comum; cancelamento de pedido/estorno nem existem | Mapear ações destrutivas e testar confirmação | Exclusão/bloqueio acidental ou experiência inconsistente |
| Correspondência frontend/backend | PARCIAL | `Painel.jsx` liga módulos reais a componentes; a busca global consulta pedidos, clientes e fornecedores conforme permissões e abre o módulo filtrado | `teste-busca-global.js` cobre contrato HTTP, isolamento por permissão e rollback; build/lint cobrem a interface | Ainda não há teste de navegador dos fluxos críticos; integrações externas permanecem condicionadas à homologação | Adicionar E2E dos fluxos críticos e ampliar a busca somente quando houver destino operacional | Interface pode quebrar após mudança de contrato não coberta pelo teste de navegador |

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

- ficou documentado e coberto por regressão que `api.joelpires.com.br` é uma API externa já existente; a Central MyKey mantém somente o cliente de integração e não deve construir ou publicar uma segunda API Joel Pires;
- fornecedores agora possuem gestão de serviços e custos pela interface, incluindo recortes por marca, modelo e ano, prazo, moeda, status, validação de duplicidade e auditoria transacional; o teste HTTP confirma permissões e rollback;
- criação, edição e bloqueio do cadastro básico do fornecedor também passaram a integrar a mesma trilha transacional de auditoria;
- o ciclo administrativo de usuários agora registra criação, edição, status e matriz de permissões na auditoria; a substituição da matriz valida módulos inexistentes e duplicados antes de gravar;
- o relatório operacional agora separa moedas, valida datas e períodos e limita o padrão até o dia atual; um dataset transacional reconcilia vendas, custos, resultado, clientes, status, fornecedor, origem e evolução diária;
- o painel financeiro agora filtra BRL, USD e PYG em faturas, lançamentos e fechamentos; faturas explicitamente vencidas entram no valor em aberto e pagamentos ligados a lançamentos cancelados não entram no recebido do dia;
- administradores agora possuem uma tela de monitoramento atualizada a cada minuto com severidade, pedidos atrasados, reprocessamento GM, outbox, eventos de integração e alertas internos, sem exposição de payloads ou destinatários;
- a busca do cabeçalho agora localiza pedidos, clientes e fornecedores apenas nos módulos autorizados e abre o destino já filtrado; o teste HTTP confirma isolamento por permissão e rollback;
- a rotina de backup agora possui trava contra concorrência, recuperação de trava obsoleta, retenção por idade com mínimo preservado e unidades systemd versionadas; a instalação do timer e o ensaio com MySQL descartável continuam pendentes;
- o pipeline de restauração foi exercitado contra o cliente MySQL real com dump fictício, tabela temporária e duas transações revertidas; a credencial atual não permite criar um schema para o ensaio integral;
- erros HTTP agora recebem identificador de correlação, preservam códigos de negócio ou recebem código estável pelo status e ocultam detalhes inesperados; JSON inválido e excesso de tamanho têm classificação própria, e o frontend mostra a referência;
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
- o sino agora possui notificações persistentes com leitura por usuário, visibilidade por permissão, níveis e resolução; falhas da outbox geram alertas e o envio posterior os resolve;
- as rotas de notificações têm teste funcional com MySQL e rollback, enquanto a interface foi validada por lint e build; outros eventos operacionais ainda precisam ser conectados;
- administradores agora possuem consulta paginada da auditoria por texto, módulo, usuário e período; a API omite JSONs internos e IP para não expor conteúdo sensível;
- a rota de auditoria tem teste funcional de autorização, paginação, filtros, minimização de dados e rollback; a cobertura de gravação das ações do sistema continua desigual;
- a seleção GM agora possui teste específico de Márcio e Emerson nos limites de 08h, 19h e 22h, fallback por disponibilidade, menor custo e desempate determinístico;
- o mesmo teste confirma, sem expor contatos, que os cadastros vivos mantêm Márcio ativo a R$ 22 das 08h às 22h e Emerson ativo a R$ 25 das 08h às 19h;
- pedidos GM em `AGUARDANDO_DADOS` agora podem ser corrigidos na interface e reprocessados atomicamente pela API, com validação de estado, histórico e auditoria;
- o teste funcional da correção usa API Joel Pires simulada e MySQL com rollback, e comprova conclusão, resultado e agendamento da entrega sem deixar dados de negócio;
- todas as chamadas HTTP do frontend agora possuem timeout padrão de 30 segundos e mensagens específicas para indisponibilidade de rede e tempo esgotado;
- o pagamento preserva seu timeout especial de 105 segundos, e o teste automatizado do frontend cobre sucesso, rede, timeout e cancelamento fornecido pela operação;
- pedidos novos agora distinguem cliente, comprador e pagador por snapshots; a interface permite informar pessoas diferentes e o detalhe exibe cada papel;
- o teste HTTP da criação comprova tanto o pedido GM pós-pago quanto o antecipado, incluindo validação, identidades, persistência e leitura usando tabela MySQL temporária e rollback;
- no pedido GM antecipado, o mesmo teste percorre criação, confirmação manual idempotente, resposta encontrada da API Joel Pires simulada, conclusão com custo zero e sem fornecedor, resultado confirmado, alimentação do cache e agendamento da entrega ao cliente;
- essa prova usa as rotas HTTP reais e o MySQL dentro de uma transação externa; após o rollback, confirma ausência do pedido, pagamento, cache, cliente e fornecedor fictícios;
- a API agora separa vivacidade (`/health`) de prontidão (`/health/ready`); o segundo devolve HTTP 503 quando o MySQL está indisponível sem expor detalhes internos;
- o teste HTTP de health cobre banco disponível e indisponível com dependência simulada, e o diagnóstico detalhado continua autenticado;
- backups agora são gerados atomicamente com API, frontend, dump MySQL, permissões restritas e manifesto SHA-256; a restauração valida integridade e cria um backup de segurança antes de substituir dados;
- o teste automatizado restaura artefatos e dump fictícios em `/tmp` e rejeita corrupção; um ensaio controlado com MySQL descartável ainda é necessário antes de classificar a restauração de banco como comprovada em ambiente operacional;
- autenticação e autorização agora possuem teste funcional com login real, JWT válido/adulterado, cinco ações de permissão, senha provisória e bloqueio imediato;
- o teste de acesso usa usuário fictício com rollback e tabelas temporárias para módulos e permissões, sem alterar a matriz real do ambiente;
- a ativação continua bloqueada até homologar os dois modelos da Meta e confirmar contatos válidos de fornecedores e clientes.

Esses itens continuam **PARCIAIS** até as migrações serem validadas para publicação, os modelos serem homologados, o fluxo ser publicado com backup e um envio controlado ser comprovado sem dados reais. O fechamento de fornecedores também depende da aprovação da política operacional de período e pagamento; ele registra pagamentos realizados, mas não movimenta a conta bancária.
