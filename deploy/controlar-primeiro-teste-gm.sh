#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR=/opt/centralmykey-source
API_DIR=/opt/central-mykey-api
ENV_FILE="$API_DIR/.env"
SERVICE=central-mykey-api.service
BACKUP_DIR=/root/centralmykey-secrets/env-backups
HEALTH_URL=http://127.0.0.1:3000/health
READY_URL=http://127.0.0.1:3000/health/ready

exec 9>/run/lock/centralmykey-primeiro-teste-gm.lock
if ! flock -n 9; then
  echo 'Outro controle do primeiro teste GM já está em execução.' >&2
  exit 1
fi

uso() {
  cat <<'EOF'
Uso:
  controlar-primeiro-teste-gm.sh status
  controlar-primeiro-teste-gm.sh validar TELEFONE_AUTORIZADO
  controlar-primeiro-teste-gm.sh ativar TELEFONE_AUTORIZADO
  controlar-primeiro-teste-gm.sh desativar

O comando nunca imprime credenciais nem o telefone autorizado.
EOF
}

diagnosticar() {
  CENTRALMYKEY_ENV_PATH="$ENV_FILE" \
    node "$SOURCE_DIR/api/diagnosticar-primeiro-teste-gm.js" "$@"
}

aguardar_saude() {
  for _ in {1..30}; do
    if curl --fail --silent --show-error "$HEALTH_URL" >/dev/null &&
       curl --fail --silent --show-error "$READY_URL" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

criar_backup_env() {
  install -d -m 700 "$BACKUP_DIR"
  BACKUP_ENV="$BACKUP_DIR/central-mykey-api-$(date -u +%Y%m%dT%H%M%SZ)-$$.env"
  install -m 600 "$ENV_FILE" "$BACKUP_ENV"
}

alterar_env() {
  local modo="$1"
  local telefone="${2:-}"
  node - "$ENV_FILE" "$modo" "$telefone" <<'NODE'
const fs = require('fs');
const [arquivo, modo, telefone] = process.argv.slice(2);
const alteracoes = modo === 'ativar' ? {
  AUTOMACAO_GM_WHATSAPP_TELEFONES_TESTE: telefone,
  AUTOMACAO_GM_WHATSAPP_HABILITADA: 'true',
  COMUNICACOES_OUTBOX_HABILITADO: 'true',
  SICOOB_AMBIENTE: 'producao',
  SICOOB_COBRANCA_HABILITADA: 'true',
  SICOOB_CONSULTA_HABILITADA: 'true',
  SICOOB_WEBHOOK_HABILITADO: 'false'
} : {
  AUTOMACAO_GM_WHATSAPP_TELEFONES_TESTE: '',
  AUTOMACAO_GM_WHATSAPP_HABILITADA: 'false',
  COMUNICACOES_OUTBOX_HABILITADO: 'false',
  SICOOB_COBRANCA_HABILITADA: 'false',
  SICOOB_CONSULTA_HABILITADA: 'false',
  SICOOB_WEBHOOK_HABILITADO: 'false'
};
let linhas = fs.readFileSync(arquivo, 'utf8').split(/\r?\n/);
for (const [chave, valor] of Object.entries(alteracoes)) {
  const indice = linhas.findIndex(linha => linha.startsWith(`${chave}=`));
  if (indice >= 0) linhas[indice] = `${chave}=${valor}`;
  else linhas.push(`${chave}=${valor}`);
}
const temporario = `${arquivo}.controle-gm-${process.pid}`;
fs.writeFileSync(temporario, `${linhas.join('\n').replace(/\n+$/, '')}\n`, {
  mode: 0o600
});
fs.chmodSync(temporario, fs.statSync(arquivo).mode);
fs.renameSync(temporario, arquivo);
NODE
}

restaurar() {
  local codigo=$?
  trap - ERR
  if [[ -n "${BACKUP_ENV:-}" && -f "$BACKUP_ENV" ]]; then
    install -m 600 "$BACKUP_ENV" "$ENV_FILE"
    systemctl restart "$SERVICE" || true
    aguardar_saude || true
    echo 'Falha na preparação; configuração anterior restaurada.' >&2
  fi
  exit "$codigo"
}

comando="${1:-}"
case "$comando" in
  status)
    diagnosticar || true
    ;;
  validar)
    telefone="$(printf '%s' "${2:-}" | tr -cd '0-9')"
    if [[ ! "$telefone" =~ ^[0-9]{10,15}$ ]]; then
      echo 'Telefone autorizado inválido; informe DDI, DDD e número.' >&2
      exit 2
    fi
    env \
      CENTRALMYKEY_ENV_PATH="$ENV_FILE" \
      AUTOMACAO_GM_WHATSAPP_TELEFONES_TESTE="$telefone" \
      AUTOMACAO_GM_WHATSAPP_HABILITADA=true \
      COMUNICACOES_OUTBOX_HABILITADO=true \
      SICOOB_AMBIENTE=producao \
      SICOOB_COBRANCA_HABILITADA=true \
      SICOOB_CONSULTA_HABILITADA=true \
      SICOOB_WEBHOOK_HABILITADO=false \
      node "$SOURCE_DIR/api/diagnosticar-primeiro-teste-gm.js" --exigir-pronto
    echo 'Configuração validada sem ativar integrações nem enviar mensagens.'
    ;;
  ativar)
    telefone="$(printf '%s' "${2:-}" | tr -cd '0-9')"
    if [[ ! "$telefone" =~ ^[0-9]{10,15}$ ]]; then
      echo 'Telefone autorizado inválido; informe DDI, DDD e número.' >&2
      exit 2
    fi
    diagnosticar --exigir-fila-vazia >/dev/null
    criar_backup_env
    trap restaurar ERR
    alterar_env ativar "$telefone"
    systemctl restart "$SERVICE"
    aguardar_saude
    diagnosticar --exigir-pronto
    trap - ERR
    echo 'Primeiro teste GM ativado somente para o contato autorizado.'
    ;;
  desativar)
    criar_backup_env
    trap restaurar ERR
    alterar_env desativar
    systemctl restart "$SERVICE"
    aguardar_saude
    trap - ERR
    echo 'Primeiro teste GM desativado; automações e Sicoob estão bloqueados.'
    ;;
  *)
    uso
    exit 2
    ;;
esac
