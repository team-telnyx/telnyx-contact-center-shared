variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "deployment_name" {
  type = string
}

variable "vnet_id" {
  type = string
}

variable "app_subnet_id" {
  type = string
}

variable "nsg_id" {
  description = "Not directly attached here (cc-network-azure already associates the NSG with the app subnet) — kept as an explicit input so this module's dependency graph makes the ordering visible even though it isn't referenced in a resource block."
  type        = string
  default     = null
}

variable "appgw_subnet_cidr" {
  description = "CIDR for the Application Gateway's dedicated subnet (cc-network-azure's appgw_subnet_cidr output). Only used when lb_enabled=true — Application Gateway REQUIRES its own subnet, it cannot share the VM's app subnet."
  type        = string
  default     = ""
}

variable "vm_size" {
  type    = string
  default = "Standard_D2s_v3"
}

variable "os_disk_size_gb" {
  type    = number
  default = 30
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "streaming_ws_port" {
  type    = number
  default = 3001
}

variable "key_vault_id" {
  type = string
}

variable "key_vault_name" {
  description = "Key Vault NAME (not id) — cloud-init's `az keyvault secret show --vault-name` needs the name, not the resource id."
  type        = string
}

variable "db_secret_name" {
  type = string
}

variable "app_env_secret_name" {
  type = string
}

variable "storage_connection_string_secret_name" {
  type = string
}

variable "storage_account_name" {
  type = string
}

variable "storage_account_id" {
  description = "Full resource id of the Storage Account (cc-storage-azure's storage_account_id output) — scope for the app identity's Storage Blob Data Contributor role assignment."
  type        = string
}

variable "storage_container_name" {
  type = string
}

variable "portainer_agent_enabled" {
  type    = bool
  default = false
}

variable "portainer_agent_port" {
  type    = number
  default = 9001
}

variable "lb_enabled" {
  description = "true to front the instance with an Application Gateway v2 + Key Vault-backed TLS certificate (Phase 3) instead of plain HTTP directly on the instance's public IP (Phase 1/2 default). Requires `domain` to be non-empty."
  type        = bool
  default     = false
}

variable "domain" {
  description = "Public domain the TLS certificate covers (e.g. \"cc.example.com\"). Required when lb_enabled=true; ignored otherwise."
  type        = string
  default     = ""
}

variable "dns_zone_name" {
  description = "Azure DNS zone NAME (not the domain suffix — the zone resource name) to create/update the domain's A record in. Empty string (default) means this deployment's domain is NOT managed in Azure DNS by Terraform. Mirrors the AWS root's dns_zone_id / GCP root's dns_managed_zone gate exactly. Ignored when lb_enabled=false."
  type        = string
  default     = ""
}

variable "dns_zone_resource_group" {
  description = "Resource group the DNS zone named by dns_zone_name lives in — Azure DNS zones are addressed by name+resource-group, not a single globally-unique id the way Route53 zone ids / Cloud DNS managed zone names are. Required whenever dns_zone_name is non-empty."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
