variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "deployment_name" {
  type = string
}

variable "db_subnet_id" {
  description = "Delegated subnet id for private VNet-integrated access (cc-network-azure's db_subnet_id output)."
  type        = string
}

variable "private_dns_zone_id" {
  description = "Private DNS zone id for Flexible Server's private-access hostname resolution (cc-network-azure's postgres_private_dns_zone_id output)."
  type        = string
}

variable "key_vault_id" {
  description = "Shared per-deployment Key Vault id to write the DB credentials secret into (cc-secrets-azure's key_vault_id output). See that module's header for why one vault is shared across cc-database-azure/cc-storage-azure/cc-secrets-azure instead of each owning its own."
  type        = string
}

variable "db_sku_name" {
  description = "Flexible Server compute/storage tier, e.g. \"GP_Standard_D2s_v3\" (General Purpose, 2 vCores) or \"B_Standard_B1ms\" (Burstable, cheapest — good for Small sizing). Azure equivalent of an RDS instance class / Cloud SQL tier."
  type        = string
  default     = "GP_Standard_D2s_v3"
}

variable "db_version" {
  type    = string
  default = "16"
}

variable "db_storage_mb" {
  type    = number
  default = 32768 # 32 GiB, Flexible Server's minimum allocatable size
}

variable "db_name" {
  type    = string
  default = "contact_center"
}

variable "db_username" {
  type    = string
  default = "contact_center"
}

variable "db_ha_enabled" {
  description = "true = ZoneRedundant high-availability standby replica (Large/HA sizing) — the Azure equivalent of RDS multi_az / Cloud SQL REGIONAL availability_type. false (default) = no standby, single instance."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "geo_redundant_backup" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  description = "See main.tf's lifecycle block on azurerm_postgresql_flexible_server — Terraform-level guard only, not a native Azure API flag. Kept false by default to match the AWS/GCP roots — `cc destroy` is expected to actually delete the instance."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
