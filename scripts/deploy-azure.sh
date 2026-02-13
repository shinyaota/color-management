#!/usr/bin/env bash
set -euo pipefail

RG_NAME="${RG_NAME:-sooocojp}"
LOCATION="${LOCATION:-japaneast}"
STORAGE_ACCOUNT_NAME="${STORAGE_ACCOUNT_NAME:-}"

if [[ -z "${STORAGE_ACCOUNT_NAME}" ]]; then
  echo "STORAGE_ACCOUNT_NAME is required. Example: STORAGE_ACCOUNT_NAME=sooocojpcolor123"
  exit 1
fi

az group show --name "${RG_NAME}" >/dev/null

az deployment group create \
  --resource-group "${RG_NAME}" \
  --template-file "infra/main.bicep" \
  --parameters storageAccountName="${STORAGE_ACCOUNT_NAME}" location="${LOCATION}"

npm install
npm run build

az storage blob upload-batch \
  --account-name "${STORAGE_ACCOUNT_NAME}" \
  --destination '$web' \
  --source dist \
  --auth-mode login \
  --overwrite

az storage account show \
  --name "${STORAGE_ACCOUNT_NAME}" \
  --resource-group "${RG_NAME}" \
  --query "primaryEndpoints.web" \
  --output tsv
