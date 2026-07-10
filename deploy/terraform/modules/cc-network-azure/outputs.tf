output "vnet_id" {
  value = azurerm_virtual_network.main.id
}

output "vnet_name" {
  value = azurerm_virtual_network.main.name
}

output "app_subnet_id" {
  value = azurerm_subnet.app.id
}

output "db_subnet_id" {
  description = "Delegated subnet id for the Postgres Flexible Server module (cc-database-azure)."
  value       = azurerm_subnet.db.id
}

output "postgres_private_dns_zone_id" {
  description = "Private DNS zone id the database module must reference for private_dns_zone_id — required alongside the delegated subnet for Flexible Server private access."
  value       = azurerm_private_dns_zone.postgres.id
}

output "nsg_id" {
  value = azurerm_network_security_group.app.id
}

output "appgw_subnet_cidr" {
  description = "CIDR reserved for the Application Gateway's own subnet (cc-compute-single-azure creates the actual subnet resource; this module only reserves/documents the address block so the NSG rule above and the gateway module agree on it without a cross-module circular dependency)."
  value       = cidrsubnet(var.vnet_cidr, 4, 2)
}
