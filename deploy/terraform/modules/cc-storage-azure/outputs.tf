output "storage_account_name" {
  value = azurerm_storage_account.main.name
}

output "storage_account_id" {
  value = azurerm_storage_account.main.id
}

output "container_name" {
  value = azurerm_storage_container.main.name
}

output "primary_blob_endpoint" {
  value = azurerm_storage_account.main.primary_blob_endpoint
}

output "storage_connection_string_secret_name" {
  value = azurerm_key_vault_secret.storage_connection_string.name
}
