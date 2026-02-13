#!/usr/bin/env bash
set -euo pipefail

RG_NAME="${RG_NAME:-sooocojp}"
FUNC_LOCATION="${FUNC_LOCATION:-japanwest}"
SWA_LOCATION="${SWA_LOCATION:-eastasia}"
SWA_NAME="${SWA_NAME:-sooocojp-cm}"
FUNC_NAME="${FUNC_NAME:-sooocojp-cm-func}"
STORAGE_NAME="${STORAGE_NAME:-}"
QUEUE_NAME="${QUEUE_NAME:-colorjobs}"
UPLOADS_CONTAINER="${UPLOADS_CONTAINER:-uploads}"
OUTPUTS_CONTAINER="${OUTPUTS_CONTAINER:-outputs}"
JOBS_CONTAINER="${JOBS_CONTAINER:-jobs}"

if [[ -z "${STORAGE_NAME}" ]]; then
  echo "STORAGE_NAME is required (lowercase, 3-24 chars). Example: STORAGE_NAME=sooocojpcms123"
  exit 1
fi

az group show --name "$RG_NAME" >/dev/null

az storage account create \
  --name "$STORAGE_NAME" \
  --resource-group "$RG_NAME" \
  --location "$FUNC_LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2

CONNECTION=$(az storage account show-connection-string \
  --name "$STORAGE_NAME" \
  --resource-group "$RG_NAME" \
  --query connectionString -o tsv)

az storage container create --name "$UPLOADS_CONTAINER" --connection-string "$CONNECTION"
az storage container create --name "$OUTPUTS_CONTAINER" --connection-string "$CONNECTION"
az storage container create --name "$JOBS_CONTAINER" --connection-string "$CONNECTION"
az storage queue create --name "$QUEUE_NAME" --connection-string "$CONNECTION"

az functionapp create \
  --name "$FUNC_NAME" \
  --resource-group "$RG_NAME" \
  --consumption-plan-location "$FUNC_LOCATION" \
  --runtime python \
  --runtime-version 3.11 \
  --functions-version 4 \
  --storage-account "$STORAGE_NAME" \
  --os-type Linux

az functionapp config appsettings set \
  --name "$FUNC_NAME" \
  --resource-group "$RG_NAME" \
  --settings \
    COLOR_STORAGE_CONNECTION_SETTING=AzureWebJobsStorage \
    COLOR_CONTAINER_UPLOADS="$UPLOADS_CONTAINER" \
    COLOR_CONTAINER_OUTPUTS="$OUTPUTS_CONTAINER" \
    COLOR_CONTAINER_JOBS="$JOBS_CONTAINER" \
    COLOR_QUEUE_NAME="$QUEUE_NAME"

az staticwebapp create \
  --name "$SWA_NAME" \
  --resource-group "$RG_NAME" \
  --location "$SWA_LOCATION" \
  --sku Standard

FUNC_ID=$(az functionapp show \
  --resource-group "$RG_NAME" \
  --name "$FUNC_NAME" \
  --query id -o tsv)

az staticwebapp backends link \
  --name "$SWA_NAME" \
  --resource-group "$RG_NAME" \
  --backend-resource-id "$FUNC_ID" \
  --backend-region "$FUNC_LOCATION"

cat <<'MESSAGE'

Next steps:
1) Deploy the function app:
   cd api
   func azure functionapp publish <FUNCTION_APP_NAME>

2) Deploy the front-end:
   npm install
   npm run build
   # Use GitHub Actions or SWA CLI (swa deploy)

3) Custom domain:
   az staticwebapp hostname set --name <SWA_NAME> --resource-group <RG_NAME> --hostname cm.sooo.co.jp
   az staticwebapp hostname show --name <SWA_NAME> --resource-group <RG_NAME> --hostname cm.sooo.co.jp

MESSAGE
