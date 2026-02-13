param location string = resourceGroup().location
param storageAccountName string

resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  name: '${storage.name}/default'
  properties: {
    staticWebsite: {
      indexDocument: 'index.html'
      error404Document: 'index.html'
    }
  }
}

output webEndpoint string = storage.properties.primaryEndpoints.web
