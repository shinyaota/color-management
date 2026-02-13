# Color Management

複数画像の色味を参照画像に合わせて統一する、カラー補正ツールです。React + Viteで構築し、PC・スマホの両方に対応しています。

運用URL: cm.sooo.co.jp

## できること

- 複数画像の一括アップロード（ドラッグ&ドロップ対応）
- HEICは自動でJPEGに変換して読み込み
- 参照画像を選択して色を統一（L*a*b*ベースのReinhard転送）
- ColorChecker診断（ΔE表示）
- サーバー側のColorChecker補正（colour-science）
- 大容量の非同期処理（Blob + Queue + Functions）
- Pantone/DIC等のパレットCSVを使った基準色合わせ（Labシフト）
- 根拠レポート（JSON）
- 出力サイズとJPEG品質の調整
- 一括ZIPダウンロード

## ローカル実行（フロントのみ）

```bash
npm install
npm run dev
```

## ローカル実行（API含む）

Azure Functions Core Tools が必要です。

`api/local.settings.json.example` を `api/local.settings.json` にコピーして、Azurite もしくは実ストレージの接続文字列を設定してください。

```bash
# フロント
npm install
npm run dev

# API
cd api
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
func start
```

Vite は `http://localhost:5173`、API は `http://localhost:7071` で動きます。

## Azure CLI デプロイ（SWA + Function App + Queue）

`scripts/az-setup-async.sh` で一括作成もできます。

### 1) 変数

```bash
RG_NAME=sooocojp
FUNC_LOCATION=japanwest
SWA_LOCATION=eastasia
SWA_NAME=sooocojp-cm
FUNC_NAME=sooocojp-cm-func
STORAGE_NAME=sooocojpcms${RANDOM}
QUEUE_NAME=colorjobs
UPLOADS_CONTAINER=uploads
OUTPUTS_CONTAINER=outputs
JOBS_CONTAINER=jobs
```

### 2) ストレージとキュー

```bash
az storage account create \
  --name $STORAGE_NAME \
  --resource-group $RG_NAME \
  --location $FUNC_LOCATION \
  --sku Standard_LRS \
  --kind StorageV2

CONNECTION=$(az storage account show-connection-string \
  --name $STORAGE_NAME \
  --resource-group $RG_NAME \
  --query connectionString -o tsv)

az storage container create --name $UPLOADS_CONTAINER --connection-string "$CONNECTION"
az storage container create --name $OUTPUTS_CONTAINER --connection-string "$CONNECTION"
az storage container create --name $JOBS_CONTAINER --connection-string "$CONNECTION"
az storage queue create --name $QUEUE_NAME --connection-string "$CONNECTION"
```

### 3) Function App 作成 & 設定

```bash
az functionapp create \
  --name $FUNC_NAME \
  --resource-group $RG_NAME \
  --consumption-plan-location $FUNC_LOCATION \
  --runtime python \
  --runtime-version 3.11 \
  --functions-version 4 \
  --storage-account $STORAGE_NAME \
  --os-type Linux

az functionapp config appsettings set \
  --name $FUNC_NAME \
  --resource-group $RG_NAME \
  --settings \
    COLOR_STORAGE_CONNECTION_SETTING=AzureWebJobsStorage \
    COLOR_CONTAINER_UPLOADS=$UPLOADS_CONTAINER \
    COLOR_CONTAINER_OUTPUTS=$OUTPUTS_CONTAINER \
    COLOR_CONTAINER_JOBS=$JOBS_CONTAINER \
    COLOR_QUEUE_NAME=$QUEUE_NAME
```

### 4) Function App デプロイ

```bash
cd api
func azure functionapp publish $FUNC_NAME
```

### 5) Static Web Apps 作成（Standard 必須）

```bash
az staticwebapp create \
  --name $SWA_NAME \
  --resource-group $RG_NAME \
  --location $SWA_LOCATION \
  --sku Standard
```

### 6) Function App を SWA にリンク（Bring Your Own Functions）

```bash
FUNC_ID=$(az functionapp show \
  --resource-group $RG_NAME \
  --name $FUNC_NAME \
  --query id -o tsv)

az staticwebapp backends link \
  --name $SWA_NAME \
  --resource-group $RG_NAME \
  --backend-resource-id $FUNC_ID \
  --backend-region $FUNC_LOCATION
```

### 7) フロントエンドデプロイ

- GitHub 連携の場合は `az staticwebapp create` に `--source` と `--branch` を付けて作成し、push で自動デプロイ。\n- 手動デプロイの場合は SWA CLI (`swa deploy`) を使用。

```bash
npm install
npm run build
SWA_CLI_DEPLOYMENT_TOKEN=$(az staticwebapp secrets list \
  --name $SWA_NAME \
  --resource-group $RG_NAME \
  --query properties.apiKey -o tsv)

SWA_CLI_DEPLOYMENT_TOKEN=$SWA_CLI_DEPLOYMENT_TOKEN \\
  swa deploy ./dist --env production --swa-config-location .
```

### 8) カスタムドメイン (cm.sooo.co.jp)

```bash
az staticwebapp hostname set \
  --name $SWA_NAME \
  --resource-group $RG_NAME \
  --hostname cm.sooo.co.jp

az staticwebapp hostname show \
  --name $SWA_NAME \
  --resource-group $RG_NAME \
  --hostname cm.sooo.co.jp
```

`hostname show` の出力にある `txtRecord` と `cname` を DNS 側に設定してください。

## 重要な注意点

- SWA の managed functions は制約があるため、Queue トリガーのような非HTTP処理は Bring Your Own Functions で運用します。
- Pantone/DICの完全一致はデバイス色域やICCプロファイルに制約されます。
- 正確性を高めるには、RAW撮影 + ColorChecker基準カット + ICCプロファイル運用を推奨します。

## 主要ファイル

- `src/App.jsx` UIと処理フロー
- `src/lib/transfer.js` L*a*b*補正（Reinhard法）
- `api/function_app.py` ColorChecker解析・補正API + キュー処理
- `staticwebapp.config.json` SPAルーティング設定

## パレットCSVフォーマット

`name,lab_l,lab_a,lab_b` 形式を推奨します。サンプル: `README_PALLETE_SAMPLE.csv`。
