# Segurança da Central MyKey

Auditoria realizada em 8 de outubro de 2026 sobre o repositório, a API
publicada, o Nginx, o serviço systemd, a estrutura do MySQL e os backups. O
vídeo do Instagram não pôde ser carregado pelo VPS; os pontos enviados por
Thiago foram analisados individualmente.

## Respostas objetivas

| Preocupação | Situação comprovada | Lacuna ou risco | Tratamento |
|---|---|---|---|
| Rotas autenticadas | As rotas internas de clientes, pedidos, financeiro, usuários, configurações, relatórios e integrações exigem JWT; ações sensíveis também consultam permissão por módulo no banco | Rotas públicas precisam continuar sendo revisadas a cada integração | Login e health mínimo são públicos. OAuth usa `state`; webhooks usam assinatura, segredo ou mTLS. O bootstrap inicial fica desligado e exige segredo próprio |
| Senhas no banco | `usuarios.senha_hash` usa bcrypt com custo 12; a senha original não é recuperável | Política ainda permite senha de oito caracteres em alguns cadastros | Elevar a política e adicionar MFA é um marco posterior |
| Tentativas de login | A branch `teste` limita cinco falhas por conta e vinte por origem em quinze minutos | O limite em memória reinicia junto com o processo e ainda não está publicado | Persistir bloqueios e alertas no banco é a evolução recomendada |
| RLS | A Central usa MySQL e não é multiempresa; o acesso atual é de funcionários, com RBAC por módulo | Não existe isolamento por linha. Quem pode visualizar clientes pode visualizar todos | Se houver portal do cliente ou várias empresas, adicionar escopo obrigatório por cliente/empresa e testes contra IDOR antes de expor essas rotas |
| Dados dos clientes criptografados | HTTPS protege o tráfego; `.env` e certificados têm permissão `0600`; MySQL e API escutam somente em `127.0.0.1`; tokens OAuth do Bling usam AES-256-GCM | Nome, documento, telefone, e-mail, chassi, placa e resultados estão legíveis no MySQL. A criptografia padrão de tabelas está desligada | Não declarar criptografia integral em repouso. Planejar criptografia de volume/banco e campos sensíveis com índices cegos quando precisarem de pesquisa |
| Backups | Diretórios usam `0700`, arquivos `0600` e hashes SHA-256 verificam integridade | Os arquivos são compactados, não cifrados; `api.tar.gz` inclui o `.env` publicado | Cifrar backups com chave guardada fora do VPS e excluir segredos que possam ser restaurados por outro mecanismo |
| Dependências | Depois da correção local, `npm audit` informa zero vulnerabilidades conhecidas na API e no frontend | A publicação ainda usa as dependências anteriores | Publicar somente após o conjunto completo de testes |
| Navegador | O frontend escapa conteúdo pela renderização normal do React e não foi encontrado uso de `dangerouslySetInnerHTML` | O JWT permanece em `localStorage`; uma futura falha XSS poderia roubá-lo | Migrar a sessão para cookie `HttpOnly`, `Secure` e `SameSite`, com proteção CSRF e revogação |
| Processo da API | A API e o MySQL não ficam expostos diretamente à internet; Nginx termina TLS | O serviço da API executa como `root` | Criar usuário de sistema restrito, ajustar propriedade dos diretórios e endurecer a unidade systemd |

## O que significa “dados dos clientes criptografados”

Há três proteções diferentes:

1. **Em trânsito:** HTTPS impede leitura da comunicação entre navegador e
   servidor. Essa proteção existe.
2. **Controle de acesso:** banco em loopback, arquivos `0600`, login e
   permissões reduzem quem consegue chegar aos dados. Essa proteção existe,
   mas não é criptografia.
3. **Em repouso:** se alguém copiar o disco, o banco ou um backup, os campos
   continuam ilegíveis sem a chave. Essa proteção ainda não cobre os dados dos
   clientes da Central.

Senha de usuário é um caso diferente: ela deve ser armazenada como **hash**,
não como dado cifrado. O sistema só verifica se a senha informada gera uma
confirmação válida; ele não precisa recuperar a senha original.

CPF, CNPJ, telefone, e-mail e chassi precisam ser consultados pelo sistema.
Cifrá-los campo a campo exige uma chave fora do banco e, para pesquisas, um
índice cego criado com HMAC. Cifrar apenas com uma chave guardada no mesmo dump
do banco não resolve o risco.

## Rotas públicas intencionais

- `POST /api/auth/login`: autenticação, com resposta genérica e limite de
  tentativas na branch `teste`.
- `POST /api/auth/bootstrap`: retorna 404 por padrão; requer ativação temporária
  e segredo de ao menos 32 bytes em instalação vazia.
- `GET /health` e `GET /health/ready`: expõem somente estado mínimo.
- Callback OAuth do Bling: exige `state` aleatório, armazenado por hash e com
  expiração.
- Webhooks da Meta e Bling: exigem assinatura criptográfica.
- Webhook SendPulse: exige segredo aleatório na URL e não registra esse caminho
  no Nginx.
- Webhook Sicoob: permanece desabilitado e exige validação mTLS no proxy.

## Correções preparadas na branch `teste`

- limite de tentativas por conta e IP, usando somente hashes dos
  identificadores em memória;
- resposta de login genérica para não revelar se a conta existe ou está
  bloqueada;
- comparação bcrypt também para usuário inexistente, reduzindo diferença de
  tempo observável;
- validação explícita do algoritmo e emissor do JWT;
- exigência de `JWT_SECRET` com pelo menos 32 bytes;
- bootstrap inicial desabilitado e protegido por segredo;
- origens CORS restritas por configuração;
- cabeçalhos CSP, HSTS, `nosniff`, bloqueio de iframe, política de referência e
  permissões do navegador;
- confiança no IP encaminhado somente pelo proxy local;
- limite de 512 KiB para JSON;
- atualização das dependências vulneráveis da API e do frontend.

## Próximos marcos de segurança

1. Validar e publicar o endurecimento HTTP e do login.
2. Executar a API com usuário sem privilégios e endurecer o systemd.
3. Migrar JWT do `localStorage` para cookie seguro com CSRF e revogação.
4. Persistir bloqueios de login e alertar tentativas anormais.
5. Cifrar backups antes da cópia externa, com chave fora do VPS.
6. Definir criptografia em repouso do volume/MySQL e o plano de recuperação da
   chave.
7. Classificar dados pessoais, limitar retenção e mascarar documentos nas telas
   que não precisam do valor integral.
8. Implementar escopo por linha antes de qualquer portal de clientes ou modelo
   multiempresa.
9. Adicionar MFA para administradores e operações financeiras.
10. Fazer revisão periódica de dependências, rotas públicas, logs e permissões.

Esta auditoria reduz riscos conhecidos, mas não representa certificação de que
o sistema é invulnerável. Segurança depende também de atualizações do sistema,
controle das contas do VPS, proteção das chaves, monitoramento e resposta a
incidentes.
