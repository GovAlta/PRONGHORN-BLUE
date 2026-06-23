---
name: 09.7.verfiy-ai-models
description: This skill will guide you through verifying that your deployed AI models are accessible and functioning correctly.
argument-hint: "Please follow the instructions to verify your AI model deployment."
compatibility:
  - windows
license: MIT
user-invokable: true
---

# Verify AI Model Deployment

This skill will help you confirm that your AI models deployed to Azure are accessible and responding as expected. You'll test the model endpoints directly using a simple script.

## Pre-requisites

- You have deployed AI models to Azure using Terraform as outlined in the previous skill.
- You have the Azure OpenAI API endpoint and API key for your deployed models.
- You have `curl` installed on your machine for making HTTP requests.

## Steps to Verify AI Models

1. **Obtain API Endpoint and Key**: Ensure you have the correct API endpoint URL and API key for your Azure OpenAI deployment. You can find these in the Azure portal under your Cognitive Services resource.
2. **Run Verification Script**: Use the provided PowerShell script to test the model endpoint. The script will prompt you for the API endpoint and key, then make a test request to the model.

   ```powershell
   Set-Location .github/skills/09.7.verfiy-ai-models/scripts
   .\Verify-AI-Models.ps1
   ```

   > **Note:** Only a PowerShell script is currently available. A bash equivalent for Linux/macOS is not yet implemented.

3. **Review Response**: The script will output the response from the model. You should see a valid response indicating that the model is accessible and functioning correctly.

## Validation

- Model endpoint returns a valid chat completion response.
- HTTP status code is `200`.
- Response body contains `choices` array with generated text.

## Troubleshooting

