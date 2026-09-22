# Backup e restauração

O utilitário `api/executar-backup.js` cria um diretório datado em
`/opt/centralmykey-backups` contendo:

- `api.tar.gz`, incluindo a configuração publicada;
- `web.tar.gz`, contendo o projeto frontend publicado em `/opt`;
- `web-public.tar.gz`, contendo exatamente os arquivos servidos pelo Nginx;
- `database.sql.gz`, gerado com transação consistente pelo `mysqldump`;
- `manifesto.json`, com tamanho e SHA-256 de cada artefato.

O pacote é preparado em diretório temporário e só recebe o nome definitivo
depois que os quatro artefatos e o manifesto foram concluídos. Diretórios usam
permissão `0700` e arquivos `0600`. A credencial temporária do MySQL também usa
`0600`, nunca é impressa e é removida no `finally`.

Criação manual controlada:

```bash
cd /opt/centralmykey-source/api
node executar-backup.js
```

Antes de restaurar, o utilitário valida todos os hashes. A restauração exige a
opção explícita, cria um novo backup de segurança, prepara API, projeto frontend
e frontend servido fora dos destinos e restaura o banco. Os três diretórios são
trocados somente
depois dessa etapa. Em falha, os diretórios são revertidos e o utilitário tenta
restaurar automaticamente o banco de segurança.

```bash
cd /opt/centralmykey-source/api
node executar-restauracao.js /opt/centralmykey-backups/DIRETORIO \
  --confirmar-restauracao
```

Depois de uma restauração operacional ainda é obrigatório reiniciar o serviço e
validar systemd, `/health` e `/health/ready`.

O teste `api/teste-backup.js` usa apenas diretórios e conteúdo fictícios em
`/tmp`. Ele cria o pacote, confere os hashes, restaura API, projeto frontend,
frontend servido e o dump
simulado e comprova que uma corrupção deliberada é rejeitada. Nenhum arquivo ou
dado de produção participa do teste.

## Agenda e retenção

O comando `api/executar-backup-agendado.js` acrescenta uma trava contra duas
execuções simultâneas, verifica o pacote recém-criado e só depois aplica a
retenção. Por padrão, preserva todos os pacotes dos últimos 30 dias e sempre
mantém ao menos os 7 mais recentes. Diretórios manuais, incompletos ou com nome
fora do padrão gerado pelo utilitário não são removidos automaticamente.

Os limites podem ser ajustados por `BACKUP_RETENCAO_DIAS`,
`BACKUP_RETENCAO_MINIMO` e `BACKUP_LOCK_LIMITE_HORAS`. A trava é recuperada
automaticamente somente depois do limite configurado.

O monitoramento classifica o pacote gerenciado mais recente como `OK`,
`ATRASADO`, `AUSENTE` ou `INVALIDO`. A idade máxima padrão é 30 horas,
configurável por `MONITORAMENTO_BACKUP_ATRASO_HORAS`; a verificação integral dos
hashes é armazenada em memória por 60 minutos, configuráveis por
`MONITORAMENTO_BACKUP_VERIFICACAO_MINUTOS`. Estado, idade e limite aparecem na
tela de Monitoramento sem expor caminhos. Um estado diferente de `OK` cria um
alerta interno crítico, resolvido automaticamente depois de um backup válido.

Os arquivos em `deploy/systemd/central-mykey-backup.service` e
`deploy/systemd/central-mykey-backup.timer` preparam uma execução diária às
03h15, com atraso aleatório de até 30 minutos. As unidades foram instaladas e
habilitadas em 21/09/2026; a primeira execução observada terminou com sucesso e
criou um pacote formato 2 com quatro artefatos verificados.

`api/teste-backup-agendado.js` usa somente `/tmp` e comprova retenção mínima,
preservação de diretórios desconhecidos, bloqueio concorrente, recuperação de
trava antiga e limpeza da trava em caso de erro.

`api/teste-estado-backup.js` comprova as quatro classificações e a minimização
da resposta. `api/teste-monitoramento.js` e `api/teste-alertas-operacionais.js`
usam MySQL dentro de transação e rollback para comprovar a exibição, a
persistência estável do alerta e sua resolução.

`api/teste-backup-mysql.js` passa um dump fictício compactado pelo mesmo pipeline
de restauração e pelo cliente MySQL real. O SQL cria apenas uma tabela
temporária e executa duas inserções em transações revertidas; ao final, outra
conexão confirma que não existe tabela permanente. Essa prova não lê nem altera
dados de negócio. Ela valida o transporte do dump, mas não substitui o ensaio de
um backup completo em um schema descartável, pois a credencial atual não possui
permissão para criar ou remover bancos.
