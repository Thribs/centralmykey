#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR=/opt/centralmykey-source
API_DIR=/opt/central-mykey-api
WEB_DIR=/opt/central-mykey-web
SERVICE=central-mykey-api.service
HEALTH_URL=http://127.0.0.1:3000/health
READY_URL=http://127.0.0.1:3000/health/ready

if [[ "${1:-}" != "--confirmar-publicacao" ]]; then
  cat <<'EOF'
Publicação não executada. Este comando apenas mostra o procedimento.

Ao usar --confirmar-publicacao, ele valida Git/testes/build, prepara os
artefatos fora da produção, cria e verifica um backup integral, para o serviço,
aplica as oito migrações, copia os artefatos localmente, reinicia e valida
/health e /health/ready. Qualquer falha após a primeira alteração restaura
automaticamente API, frontend e banco a partir do backup criado.
EOF
  exit 0
fi

cd "$SOURCE_DIR"
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Publicação recusada: o working tree não está limpo.' >&2
  exit 1
fi

release_id="$(date -u +%Y%m%dT%H%M%SZ)"
stage_dir="/opt/.centralmykey-release-${release_id}"
backup_dir=''
producao_alterada=0

limpar() {
  rm -rf "$stage_dir"
}

rollback() {
  local codigo=$?
  trap - ERR
  if [[ "$producao_alterada" -eq 1 && -n "$backup_dir" ]]; then
    echo "Falha na publicação; iniciando rollback pelo backup ${backup_dir}." >&2
    systemctl stop "$SERVICE" || true
    if node "$SOURCE_DIR/api/executar-restauracao.js" \
      "$backup_dir" --confirmar-restauracao; then
      if systemctl start "$SERVICE" &&
         curl --fail --silent --show-error "$HEALTH_URL" >/dev/null; then
        echo 'Rollback automático concluído e health validado.' >&2
      else
        echo 'Rollback restaurou os dados, mas serviço/health não validou.' >&2
      fi
    else
      echo "ROLLBACK AUTOMÁTICO FALHOU. Backup preservado em ${backup_dir}." >&2
    fi
  fi
  exit "$codigo"
}

trap limpar EXIT
trap rollback ERR

echo "Preparando commit $(git rev-parse --short HEAD)."
(cd api && npm test)
(cd web && npm run lint && npm test && npm run build)
node api/validar-migracoes-descartaveis.js

mkdir -p "$stage_dir/api" "$stage_dir/web"
rsync -a --delete --exclude='.env' --exclude='node_modules' \
  "$SOURCE_DIR/api/" "$stage_dir/api/"
cp --preserve=mode,ownership,timestamps "$API_DIR/.env" "$stage_dir/api/.env"
(cd "$stage_dir/api" && npm ci --omit=dev)

rsync -a --delete --exclude='node_modules' --exclude='dist' \
  --exclude='test-results' --exclude='playwright-report' \
  "$SOURCE_DIR/web/" "$stage_dir/web/"
(cd "$stage_dir/web" && npm ci && npm run build)

backup_saida="$(cd "$SOURCE_DIR/api" && node executar-backup.js)"
backup_dir="${backup_saida##* }"
node - "$backup_dir" <<'NODE'
const { verificarBackup } = require('/opt/centralmykey-source/api/backup-centralmykey');
verificarBackup(process.argv[2]).catch(erro => {
  console.error(`Backup inválido: ${erro.message}`);
  process.exit(1);
});
NODE
echo "Backup verificado em ${backup_dir}."

systemctl stop "$SERVICE"
producao_alterada=1
CENTRALMYKEY_ENV_PATH="$API_DIR/.env" \
  node api/aplicar-migracoes-release.js --confirmar-migracoes

rsync -a --delete --exclude='.env' --exclude='storage' \
  "$stage_dir/api/" "$API_DIR/"
rsync -a --delete "$stage_dir/web/" "$WEB_DIR/"

systemctl start "$SERVICE"
for tentativa in {1..30}; do
  if curl --fail --silent --show-error "$HEALTH_URL" >/dev/null &&
     curl --fail --silent --show-error "$READY_URL" >/dev/null; then
    producao_alterada=0
    echo "Publicação concluída; commit $(git rev-parse --short HEAD); backup ${backup_dir}."
    exit 0
  fi
  sleep 1
done

echo 'Health não estabilizou após a publicação.' >&2
false
