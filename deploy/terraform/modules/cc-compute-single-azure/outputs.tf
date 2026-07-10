output "vm_name" {
  value = azurerm_linux_virtual_machine.app.name
}

output "vm_id" {
  value = azurerm_linux_virtual_machine.app.id
}

output "public_ip" {
  value = azurerm_public_ip.app.ip_address
}

output "managed_identity_id" {
  value = azurerm_user_assigned_identity.app.id
}

output "managed_identity_principal_id" {
  value = azurerm_user_assigned_identity.app.principal_id
}

output "appgw_public_ip" {
  description = "Static public IP of the Application Gateway. Null when lb_enabled=false. This is the address the operator must point the domain's DNS A record at."
  value       = var.lb_enabled ? azurerm_public_ip.appgw[0].ip_address : null
}

output "appgw_name" {
  description = "Name of the Application Gateway resource. Null when lb_enabled=false."
  value       = var.lb_enabled ? azurerm_application_gateway.app[0].name : null
}

output "appgw_cert_secret_name" {
  description = "Expected Key Vault secret name the operator/wizard must import a real TLS certificate into BEFORE `terraform apply` succeeds when lb_enabled=true (see the Application Gateway section's header comment for why this is manual, unlike ACM/Google-managed certs)."
  value       = var.lb_enabled ? "${var.deployment_name}-tls-cert" : null
}
