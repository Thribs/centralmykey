# Central MyKey — regras permanentes de desenvolvimento e operação

## Escopo e ambientes

- Repositório e fonte versionada: `/opt/centralmykey-source`.
- API publicada: `/opt/central-mykey-api`.
- Frontend publicado: `/opt/central-mykey-web`.
- Serviço da API: `central-mykey-api.service`.
- Repositório remoto: `Thribs/centralmykey`.
- Autor Git: `thribs-rodolfo <thribs-rodolfo@users.noreply.github.com>`.
- Baseline validada em 2026-09-18: `main` no commit `065ea3e`, tag `v0.4.1`.
- Publicação interna validada em 2026-09-21: commit `188c864` da branch
  `feature/pagamento-manual-idempotente`, sem merge ou nova tag; backup
  `/opt/centralmykey-backups/20260922T024848Z`.

O repositório é a fonte das alterações. Nunca desenvolver diretamente nos diretórios publicados. Antes de iniciar trabalho, inspecionar o estado do Git, preservar modificações existentes e trabalhar na branch `teste`. Nunca usar `git reset --hard`.

O fluxo permanente usa somente duas branches de trabalho: `teste`, onde toda
alteração é desenvolvida e validada, e `publico`, que deve apontar exatamente
para o commit efetivamente publicado. Não criar branches por tarefa.

## Segurança e configuração

- Nunca exibir, registrar, copiar para documentação ou versionar valores de `.env`, chaves, senhas ou tokens.
- O ambiente atual da API Joel Pires é staging (`teste` na configuração existente).
- `ID_USUARIO_API_JOELPIRES` deve vir exclusivamente do `.env`.
- O dispositivo da integração é `centralmykey`.
- Nunca enviar nem criar `ID_TRANSACAO`; a API Joel Pires gera a transação.
- Não usar dados reais para testes e não alterar registros reais para preparar cenários.

## Fonte de verdade e fluxo GM

A API Joel Pires é um serviço externo já existente. O ambiente público é `https://api.joelpires.com.br` e o ambiente de teste é `https://staging.api.joelpires.com.br`. A Central MyKey não implementa nem publica essa API: apenas a consome por meio do cliente em `api/consulta-api-joelpires.js`.

A API Joel Pires é a fonte de verdade das senhas. O banco local armazena somente cache de respostas dessa API; entradas de outras origens não substituem a consulta à fonte de verdade.

O fluxo GM obrigatório é:

1. Consultar o cache local da API Joel Pires.
2. Se não houver entrada válida, consultar a API Joel Pires.
3. Quando houver resultado, concluir automaticamente o pedido e alimentar ou atualizar o cache local.
4. Tratar HTTP 404, inclusive quando identificado no corpo como `SenhaNotFoundError`, como `NAO_ENCONTRADO` e então encaminhar ao fornecedor GM disponível; nunca classificar esse caso como indisponibilidade.
5. Tratar HTTP 400, 417 e 422 como `DADOS_INVALIDOS`: manter o pedido em `AGUARDANDO_DADOS` e não acionar fornecedor.
6. Em indisponibilidade real da API, manter o pedido aguardando reprocessamento e não acionar fornecedor.
7. Selecionar o fornecedor ativo e disponível de menor custo: Márcio das 08h às 22h, custo R$ 22; Emerson das 08h às 19h, custo R$ 25.

No atendimento automático antecipado pelo WhatsApp, reconhecer a intenção de
senha GM, identificar um cliente ativo pelo telefone e solicitar o chassi. Fazer
uma pré-consulta na fonte de verdade para decidir entre cache/API e fornecedor,
mas não acionar o fornecedor antes do pagamento. Informar o preço, coletar nome,
CPF/CNPJ, e-mail e cidade para a nota fiscal, oferecer Pix e gerar a cobrança
Sicoob. Somente a confirmação idempotente do pagamento pode iniciar a consulta
operacional e acionar o fornecedor. Cliente com faturamento semanal deve ser
encaminhado ao atendimento humano para preservar sua política comercial.

O transporte WhatsApp atual é a SendPulse. As credenciais da conta, o ID do
bot, o token privado do webhook e os números de Márcio e Emerson devem existir
somente em variáveis de ambiente. O aplicativo publicado no Meta Developers é
a infraestrutura vinculada à SendPulse; a Central não deve depender do número
de teste da Meta para operar pelo provedor atual. Modelos devem ser aprovados no
canal WhatsApp conectado à SendPulse antes de habilitar a automação.

A automação GM do WhatsApp deve permanecer desabilitada por padrão. Somente
definir `AUTOMACAO_GM_WHATSAPP_HABILITADA=true` depois que WhatsApp, modelos,
destinatários, Sicoob, webhook mTLS e gravação na API Joel Pires estiverem
homologados. Enquanto estiver desabilitada, toda entrada segue para a fila
humana sem criar pedido; mensagens automáticas pendentes não são enviadas e
comunicações vinculadas a pedidos automáticos são canceladas. Pedidos manuais
continuam usando sua outbox normal.

A publicação automática de uma resposta de fornecedor na API Joel Pires deve
permanecer bloqueada até `APIJOELPIRES_GRAVACAO_HOMOLOGADA=true`. Essa chave só
pode ser ativada depois de um ensaio controlado no staging confirmar POST e
releitura com o usuário configurado. Enquanto estiver falsa, o resultado fica
preservado localmente e o atendimento segue para humano sem chamada externa.

A resposta do fornecedor deve estar vinculada ao protocolo, telefone cadastrado
e consulta enviada. Antes de entregar a senha ao cliente, salvar o resultado na
API Joel Pires e relê-lo na fonte de verdade; somente a confirmação idêntica
pode alimentar o cache local e liberar a entrega. Falha de reconhecimento,
cadastro, dados fiscais, criação, cobrança, pagamento, transporte, gravação ou
releitura deve transferir o atendimento para o modo humano e bloquear
comunicações automáticas posteriores daquele atendimento. Uma comunicação
que permanecer em processamento sem confirmação também deve ser classificada
como incerta e transferida ao atendimento humano, sem reenvio automático.

Qualquer mudança nesse fluxo deve manter as transições, o histórico e os lançamentos financeiros consistentes e idempotentes.

## Testes e banco de dados

- Testes nunca podem deixar pedidos, resultados, históricos, cache temporário ou lançamentos financeiros persistidos.
- Todo teste que acessar banco deve abrir transação e executar rollback em bloco `finally`, inclusive quando houver falha.
- Preferir mocks para classificação de respostas da API, seleção de fluxo e erros de comunicação.
- Nunca executar scripts de integração contra dados reais sem antes confirmar que todas as escritas estão contidas na mesma transação reversível.

## Validação e publicação

Antes de publicar:

1. Revisar o diff e confirmar que nenhuma alteração existente foi sobrescrita.
2. Validar sintaxe da API, testes, lint e build do frontend.
3. Validar qualquer migração em transação ou ambiente descartável.
4. Obter aprovação dos testes e do plano de publicação.
5. Criar backup datado dos artefatos publicados que serão substituídos.

Na publicação, executar passos grandes diretamente no VPS e evitar transferências por SCP. Publicar apenas os artefatos aprovados. Depois, validar o estado do systemd e o endpoint `/health`. Se cópia, build, reinício, systemd ou health falhar, restaurar automaticamente o backup e validar novamente serviço e health.

Commits e tags só podem ser criados depois de todas as validações aplicáveis passarem. Não criar tag para estado não publicado ou parcialmente validado.

Ao concluir, relatar objetivamente: branch e arquivos alterados, validações executadas, resultado da publicação, versão/commit efetivos e qualquer risco ou lacuna encontrada.
