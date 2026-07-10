output "db_fqdn" {
  value = azurerm_postgresql_flexible_server.main.fqdn
}

output "db_server_name" {
  value = azurerm_postgresql_flexible_server.main.name
}

output "db_server_id" {
  value = azurerm_postgresql_flexible_server.main.id
}

output "db_secret_name" {
  description = "Name of the secret inside the shared Key Vault holding DB credentials — the Azure equivalent of the AWS root's db_secret_arn / GCP root's db_secret_name, in the shape `az keyvault secret show` and the app node's role assignment both expect."
  value       = azurerm_key_vault_secret.db.name
}
