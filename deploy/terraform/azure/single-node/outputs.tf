output "public_ip" {
  value = module.compute.public_ip
}

output "app_url" {
  # With the Application Gateway (lb_enabled=true), the app is reached at
  # https://<domain> — the gateway terminates TLS with the Key
  # Vault-sourced cert and the instance itself is no longer directly
  # reachable (see cc-network-azure's lb_enabled-gated NSG rule). Without
  # it (Phase 1/2 default), plain http:// either way, matching the AWS/GCP
  # roots' no-LB fallback shape.
  value = var.lb_enabled ? "https://${var.domain}" : (var.domain != "" ? "http://${var.domain}" : "http://${module.compute.public_ip}.nip.io")
}

output "appgw_public_ip" {
  description = "Static public IP of the Application Gateway. Null when lb_enabled=false. Point the domain's DNS A record here for the certificate to serve correctly."
  value       = module.compute.appgw_public_ip
}

output "appgw_cert_secret_name" {
  description = "Key Vault secret name the operator must import a real TLS certificate into BEFORE `terraform apply` when lb_enabled=true."
  value       = module.compute.appgw_cert_secret_name
}

output "vm_name" {
  value = module.compute.vm_name
}

output "vm_id" {
  value = module.compute.vm_id
}

output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "db_fqdn" {
  value = module.database.db_fqdn
}

output "db_secret_name" {
  value = module.database.db_secret_name
}

output "key_vault_name" {
  value = module.secrets.key_vault_name
}

output "app_env_secret_name" {
  value = module.secrets.app_env_secret_name
}

output "storage_account_name" {
  value = module.storage.storage_account_name
}

output "storage_container_name" {
  value = module.storage.container_name
}
