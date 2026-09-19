# Ativação do envio de consultas aos fornecedores

Este plano se refere ao código posterior à `v0.5.0`. Ele não autoriza publicação nem envio de mensagens por si só.

## Pré-condições obrigatórias

1. Ter um modelo de utilidade aprovado na Meta para consulta ao fornecedor.
2. Confirmar que a ordem dos parâmetros do modelo é: protocolo, chassi, marca, modelo e ano.
3. Cadastrar o WhatsApp de Márcio e Emerson com código do país e DDD. A auditoria automatizada encontrou o fornecedor atualmente selecionado sem número válido; nenhum valor foi exibido ou alterado.
4. Manter `COMUNICACOES_OUTBOX_HABILITADO=false` durante migração e primeira publicação.
5. Criar backup da API publicada e do schema antes da migração.

## Publicação preparada

1. Aplicar `api/migrations/20260918_comunicacoes_outbox.sql`.
2. Publicar os arquivos aprovados da API e o build aprovado do frontend.
3. Reiniciar `central-mykey-api.service` e validar systemd, `/health` e `/health/db`.
4. Criar um pedido fictício somente em transação com rollback e confirmar que nenhuma mensagem externa foi enviada.
5. Configurar o nome e idioma do modelo aprovado sem registrar seus valores em logs ou documentação.
6. Ativar o worker somente depois de revisar a fila pendente e os destinatários.
7. Acompanhar os primeiros envios pelos estados `PENDENTE`, `ENVIADA`, `FALHOU` e `INCERTA`.

## Garantias do fluxo

- A chave `CONSULTA_FORNECEDOR:<pedido>:<fornecedor>` impede agendamento duplicado para a mesma combinação.
- Uma comunicação `ENVIADA` não é processada novamente.
- Timeout, erro de rede e HTTP 5xx ficam como `INCERTA`; não há repetição automática.
- Repetir uma comunicação `INCERTA` exige confirmação explícita de que o fornecedor não recebeu a consulta.
- Se o resultado chegar antes do processamento, comunicações ainda pendentes ou falhas são canceladas.
- Fornecedor sem WhatsApp válido gera falha visível e não derruba o pagamento.

## Rollback operacional

1. Definir `COMUNICACOES_OUTBOX_HABILITADO=false` e reiniciar o serviço.
2. Restaurar os artefatos da API e do frontend a partir do backup da publicação.
3. Manter a tabela da outbox para auditoria; não remover registros durante rollback emergencial.
4. Validar novamente systemd e `/health`.

Não ativar o worker sem o modelo homologado e sem os contatos confirmados. O transporte é testado com mock; nenhuma mensagem real deve fazer parte da validação automatizada.
