# Backup e restauração

O utilitário `api/executar-backup.js` cria um diretório datado em
`/opt/centralmykey-backups` contendo:

- `api.tar.gz`, incluindo a configuração publicada;
- `web.tar.gz`;
- `database.sql.gz`, gerado com transação consistente pelo `mysqldump`;
- `manifesto.json`, com tamanho e SHA-256 de cada artefato.

O pacote é preparado em diretório temporário e só recebe o nome definitivo
depois que os três artefatos e o manifesto foram concluídos. Diretórios usam
permissão `0700` e arquivos `0600`. A credencial temporária do MySQL também usa
`0600`, nunca é impressa e é removida no `finally`.

Criação manual controlada:

```bash
cd /opt/centralmykey-source/api
node executar-backup.js
```

Antes de restaurar, o utilitário valida todos os hashes. A restauração exige a
opção explícita, cria um novo backup de segurança, prepara API e frontend fora
dos destinos e restaura o banco. Os diretórios publicados são trocados somente
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
`/tmp`. Ele cria o pacote, confere os hashes, restaura API, frontend e o dump
simulado e comprova que uma corrupção deliberada é rejeitada. Nenhum arquivo ou
dado de produção participa do teste.
