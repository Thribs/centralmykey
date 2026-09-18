# Ativação do reprocessamento automático GM

## Estado preparado

- Branch: `feature/reprocessamento-automatico-gm`.
- Commit do worker: `0c8cb68`.
- Código instalado na API publicada, com ativação desligada.
- O worker não abre conexão com o banco enquanto estiver desligado.
- Auditoria em 2026-09-18: nenhum pedido real elegível para o primeiro lote.

## Comportamento que precisa de aprovação do Thiago

Ao ativar, a Central verificará a cada 5 minutos até 10 pedidos GM cujo último evento seja indisponibilidade da API Joel Pires e que estejam aguardando há pelo menos 5 minutos.

Cada pedido é revalidado com bloqueio de linha e processado em transação própria:

- senha encontrada: conclui automaticamente com custo zero e alimenta o cache;
- `SenhaNotFoundError`/404: encaminha ao fornecedor GM disponível de menor custo;
- 400, 417 ou 422: mantém em `AGUARDANDO_DADOS` e não aciona fornecedor;
- rede, timeout ou 5xx: continua `ABERTO` e volta a ficar elegível depois da espera;
- pedido alterado por outro processo antes do bloqueio: é ignorado.

## Parâmetros propostos

```text
REPROCESSAMENTO_GM_AUTOMATICO=true
REPROCESSAMENTO_GM_INTERVALO_MS=300000
REPROCESSAMENTO_GM_ESPERA_SEGUNDOS=300
REPROCESSAMENTO_GM_LOTE=10
```

Os valores devem ser inseridos no `.env` sem imprimir seu conteúdo. Nenhum outro valor do arquivo deve ser alterado.

## Procedimento após aprovação

1. Recontar, sem listar dados pessoais, os pedidos que entrarão no primeiro lote.
2. Criar backup datado e protegido do `.env` e dos arquivos publicados envolvidos.
3. Alterar somente as quatro configurações acima.
4. Reiniciar `central-mykey-api.service`.
5. Aguardar prontidão e validar systemd e `/health`.
6. Confirmar por leitura segura que o worker ficou habilitado.
7. Observar a primeira execução por contagens agregadas, sem expor pedido, chassi ou credenciais.
8. Em qualquer falha, restaurar o backup, reiniciar o serviço e validar `/health` novamente.

## Rollback operacional

O rollback preferencial é definir `REPROCESSAMENTO_GM_AUTOMATICO=false` e reiniciar o serviço. Se a configuração ou o código tiver sido danificado, restaurar o backup datado criado imediatamente antes da ativação.

Desativar o worker não reverte pedidos já concluídos ou encaminhados durante uma execução aprovada; esses casos devem ser tratados pelo fluxo operacional normal e pelo histórico do pedido.
