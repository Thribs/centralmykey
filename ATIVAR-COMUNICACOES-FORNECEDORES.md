# Ativação das comunicações de pedidos

Este plano se refere ao código posterior à `v0.5.0`. Ele não autoriza publicação nem envio de mensagens por si só.

## Pré-condições obrigatórias

1. Ter um modelo de utilidade aprovado na Meta para consulta ao fornecedor.
2. Confirmar que a ordem dos parâmetros do modelo é: protocolo, chassi, marca, modelo e ano.
   O texto do modelo deve orientar o fornecedor a responder exatamente neste formato:

   ```text
   MYKEY <protocolo>
   MECANICO: <código>
   IMOBILIZADOR: <código>
   RADIO: <código>
   ALARME: <código>
   PIN: <código>
   ```

   Pelo menos um campo técnico deve ser informado. Campos sem valor podem ser omitidos.
3. Ter um modelo de utilidade aprovado para entrega do resultado ao cliente,
   com os parâmetros: pedido, código mecânico, código do imobilizador, código
   do rádio e código do alarme. O modelo não possui PIN.
4. Confirmar a elegibilidade da conta para a Groups API da Meta e cadastrar os
   `group_id` dos grupos Márcio e Emerson. A SendPulse não envia mensagens para
   grupos pela API pública.
5. Conferir o quadro **Prontidão WhatsApp GM** em Administração → Integrações. A homologação só deve começar quando o quadro não apresentar bloqueios; ele mostra apenas contagens e estados, sem expor contatos ou credenciais.
6. Confirmar que os clientes atendidos possuem telefone normalizado válido.
7. Manter `COMUNICACOES_OUTBOX_HABILITADO=false` durante migração e primeira publicação.
7. Criar backup da API publicada e do schema antes da migração.

## Publicação preparada

1. Aplicar `api/migrations/20260918_comunicacoes_outbox.sql`.
2. Publicar os arquivos aprovados da API e o build aprovado do frontend.
3. Reiniciar `central-mykey-api.service` e validar systemd, `/health` e `/health/db`.
4. Criar um pedido fictício somente em transação com rollback e confirmar que nenhuma mensagem externa foi enviada.
5. Configurar o modelo de entrega aprovado na SendPulse e, separadamente, o
   modelo de consulta ao grupo aprovado no WhatsApp Manager da Meta.
6. Ativar o worker somente depois de revisar a fila pendente e os destinatários.
7. Acompanhar os primeiros envios pelos estados `PENDENTE`, `ENVIADA`, `FALHOU` e `INCERTA`.

## Garantias do fluxo

- A chave `CONSULTA_FORNECEDOR:<pedido>:<fornecedor>` impede agendamento duplicado para a mesma combinação.
- Uma comunicação `ENVIADA` não é processada novamente.
- Timeout, erro de rede e HTTP 5xx ficam como `INCERTA`; não há repetição automática.
- Repetir uma comunicação `INCERTA` exige confirmação explícita de que o fornecedor não recebeu a consulta.
- Se o resultado chegar antes do processamento, comunicações ainda pendentes ou falhas são canceladas.
- Fornecedor sem `group_id` homologado gera falha visível e transfere o
  atendimento para uma pessoa.
- Resultado da API é preparado para entrega automaticamente; resultado de fornecedor só é preparado depois da confirmação.
- A entrega ao cliente possui chave própria por pedido e resultado e não é enviada duas vezes.
- Os eventos assinados da Meta atualizam a comunicação para `ENTREGUE` e `LIDA`, sem regressão de status.
- Uma resposta estruturada só é aceita no grupo cadastrado do fornecedor, para
  o protocolo informado e quando existe consulta enviada ou de envio incerto.
- O identificador da mensagem da Meta torna o retorno idempotente. O resultado recebido fica como `ENCONTRADO` e exige a validação humana já existente antes de alimentar o cache ou preparar a entrega.
- Texto comum, campo desconhecido, protocolo sem vínculo ou remetente divergente não altera o pedido automaticamente.
- Cliente sem WhatsApp válido gera falha visível e permite reenvio após corrigir o cadastro.
- A prontidão compara os nomes e idiomas configurados com modelos `APROVADO` e ativos, confere destinatários dos fornecedores GM e sinaliza mensagens em processamento ou estado incerto antes da homologação.

## Rollback operacional

1. Definir `COMUNICACOES_OUTBOX_HABILITADO=false` e reiniciar o serviço.
2. Restaurar os artefatos da API e do frontend a partir do backup da publicação.
3. Manter a tabela da outbox para auditoria; não remover registros durante rollback emergencial.
4. Validar novamente systemd e `/health`.

Não ativar os envios automáticos sem os dois modelos homologados nos respectivos
provedores e sem os grupos confirmados. O transporte é testado com mock; nenhuma
mensagem real deve fazer parte da validação automatizada.
