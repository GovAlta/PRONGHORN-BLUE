# Prompt for API Endpoint
$foundryResource = Read-Host "Enter your Foundry Resource Name (e.g., ai-pronghorn-dev)"
$endpoint = Read-Host "Enter your Azure OpenAI Endpoint (e.g., https://your-resource-name.services.ai.azure.com/)"
az cognitiveservices account show --resource-group pronghorn-blue --name $foundryResource --query "properties.endpoint" -o tsv
$apiKey = $(az cognitiveservices account keys list --resource-group pronghorn-blue --name $foundryResource --query "key1" -o tsv)
az cognitiveservices account deployment list --resource-group pronghorn-blue --name $foundryResource -o table

curl "$endpoint/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-01-preview" \
  -H "Content-Type: application/json" \
  -H "api-key: $apiKey" \
  -d '{
    "messages": [{"role": "user", "content": "Hello, what is Pronghorn?"}],
    "max_tokens": 100
  }'