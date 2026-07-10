variable "subscription_id" {
  description = "Azure subscription id this deployment lives in (must already exist — the wizard does not create subscriptions)."
  type        = string
}

variable "location" {
  description = "Azure region for this deployment (e.g. \"westeurope\", \"eastus\")."
  type        = string
}

variable "deployment_name" {
  description = "Deployment slug (e.g. \"cc-main\"), validated ^[a-z0-9][a-z0-9-]{1,30}$ by the wizard before this is written. Also used as the basis for the resource group name and every child resource name."
  type        = string
}

variable "domain" {
  description = "Public domain for the app (e.g. \"cc.example.com\"), or empty string when no domain is configured yet. When lb_enabled=false (default), there is no Application Gateway — the app is reached directly over plain HTTP on the instance's public IP; the operator's own DNS/reverse-proxy/CDN is responsible for HTTPS, same as the AWS no-ALB / GCP no-LB path. When lb_enabled=true, this is REQUIRED."
  type        = string
  default     = ""
}

variable "lb_enabled" {
  description = "true to front the instance with an Application Gateway v2 + Key Vault-backed TLS certificate (Phase 3) — the Azure equivalent of the AWS root's alb_enabled / GCP root's lb_enabled. Requires a non-empty `domain` AND a certificate pre-imported into the shared Key Vault (see cc-compute-single-azure's Application Gateway section — Azure has no automated cert issuance the way ACM/Google-managed certs do). false (default) keeps the Phase 1/2 behavior: plain HTTP directly on the instance's public IP."
  type        = bool
  default     = false
}

variable "dns_zone_name" {
  description = "Azure DNS zone NAME to create/update the domain's A record in. Empty string (default) means Azure DNS automation is off. Set by the wizard's DNS step, mirroring the AWS root's dns_zone_id / GCP root's dns_managed_zone gate. Ignored entirely when lb_enabled=false."
  type        = string
  default     = ""
}

variable "dns_zone_resource_group" {
  description = "Resource group the DNS zone named by dns_zone_name lives in. Required whenever dns_zone_name is non-empty."
  type        = string
  default     = ""
}

variable "vm_size" {
  description = "Azure VM size for the app node."
  type        = string
  default     = "Standard_D2s_v3"
}

variable "os_disk_size_gb" {
  type    = number
  default = 30
}

variable "db_sku_name" {
  description = "Postgres Flexible Server compute/storage tier."
  type        = string
  default     = "GP_Standard_D2s_v3"
}

variable "db_storage_mb" {
  type    = number
  default = 32768
}

variable "db_ha_enabled" {
  description = "true = ZoneRedundant HA standby replica (Large/HA sizing). false (default) = single instance."
  type        = bool
  default     = false
}

variable "admin_ssh_source_ranges" {
  description = "CIDRs allowed to reach the instance on port 22. Empty by default — the wizard's primary remote-exec path is `az vm run-command invoke`, which needs no open port 22 at all. Only populate this if an operator explicitly wants direct SSH as a fallback."
  type        = list(string)
  default     = []
}

variable "portainer_agent_enabled" {
  type    = bool
  default = false
}

variable "portainer_agent_port" {
  type    = number
  default = 9001
}

variable "portainer_server_cidrs" {
  type    = list(string)
  default = []
}

variable "uploader_object_id" {
  description = "Azure AD object id of the identity that actually runs `az storage blob upload --auth-mode login` for deploy/update steps — passed through to cc-storage-azure's uploader_object_id (see that variable's docstring for the full Terraform-SP-vs-az-login-session rationale). Empty string (default) skips the extra role grant entirely."
  type        = string
  default     = ""
}
