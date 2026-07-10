resource "azurerm_resource_group" "main" {
  name     = "${var.deployment_name}-rg"
  location = var.location

  tags = {
    deployment = var.deployment_name
    managed-by = "terraform"
    component  = "telnyx-contact-center"
  }
}

module "network" {
  source = "../../modules/cc-network-azure"

  resource_group_name     = azurerm_resource_group.main.name
  location                = var.location
  deployment_name         = var.deployment_name
  admin_ssh_source_ranges = var.admin_ssh_source_ranges
  portainer_agent_enabled = var.portainer_agent_enabled
  portainer_agent_port    = var.portainer_agent_port
  portainer_server_cidrs  = var.portainer_server_cidrs
  lb_enabled              = var.lb_enabled
}

module "secrets" {
  source = "../../modules/cc-secrets-azure"

  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  deployment_name     = var.deployment_name
}

module "database" {
  source = "../../modules/cc-database-azure"

  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  deployment_name     = var.deployment_name
  db_subnet_id        = module.network.db_subnet_id
  private_dns_zone_id = module.network.postgres_private_dns_zone_id
  key_vault_id        = module.secrets.key_vault_id
  db_sku_name         = var.db_sku_name
  db_storage_mb       = var.db_storage_mb
  db_ha_enabled       = var.db_ha_enabled

  # Postgres Flexible Server private-access creation requires the delegated
  # subnet + private DNS zone virtual network link to already exist — this
  # dependency crosses modules (db_subnet_id/private_dns_zone_id are plain
  # strings, not resource references), so Terraform can't infer it
  # automatically. See cc-database-azure/main.tf's header comment for the
  # full explanation (same pattern as the GCP root's module.network
  # depends_on).
  #
  # ALSO depends on module.secrets: this module writes its own
  # azurerm_key_vault_secret (the db-credentials secret) into the shared
  # vault, which requires the Service Principal/user running `terraform
  # apply` to already hold "Key Vault Secrets Officer" on that vault —
  # granted by cc-secrets-azure's azurerm_role_assignment.deployer_secrets_officer,
  # a SIBLING resource in that module Terraform has no automatic reference
  # to (key_vault_id above only proves the VAULT exists, not that the
  # caller's RBAC role on it has propagated). Discovered as a real 403
  # ("ForbiddenByRbac") on a live apply — see cc-secrets-azure/main.tf's
  # deployer_secrets_officer comment for the vault-level fix; this
  # module-level depends_on is the cross-module half of that same fix.
  depends_on = [module.network, module.secrets]
}

module "storage" {
  source = "../../modules/cc-storage-azure"

  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  deployment_name     = var.deployment_name
  key_vault_id        = module.secrets.key_vault_id
  domain              = var.domain
  uploader_object_id  = var.uploader_object_id

  # Same cross-module RBAC-propagation dependency as module.database above:
  # this module's azurerm_key_vault_secret.storage_connection_string needs
  # the caller to already hold "Key Vault Secrets Officer" on the shared
  # vault, granted by a sibling resource in module.secrets that
  # key_vault_id alone doesn't force an ordering against.
  depends_on = [module.secrets]
}

module "compute" {
  source = "../../modules/cc-compute-single-azure"

  resource_group_name                   = azurerm_resource_group.main.name
  location                              = var.location
  deployment_name                       = var.deployment_name
  vnet_id                               = module.network.vnet_id
  app_subnet_id                         = module.network.app_subnet_id
  nsg_id                                = module.network.nsg_id
  appgw_subnet_cidr                     = module.network.appgw_subnet_cidr
  vm_size                               = var.vm_size
  os_disk_size_gb                       = var.os_disk_size_gb
  key_vault_id                          = module.secrets.key_vault_id
  key_vault_name                        = module.secrets.key_vault_name
  db_secret_name                        = module.database.db_secret_name
  app_env_secret_name                   = module.secrets.app_env_secret_name
  storage_account_name                  = module.storage.storage_account_name
  storage_account_id                    = module.storage.storage_account_id
  storage_container_name                = module.storage.container_name
  storage_connection_string_secret_name = module.storage.storage_connection_string_secret_name
  portainer_agent_enabled               = var.portainer_agent_enabled
  portainer_agent_port                  = var.portainer_agent_port
  lb_enabled                            = var.lb_enabled
  domain                                = var.domain
  dns_zone_name                         = var.dns_zone_name
  dns_zone_resource_group               = var.dns_zone_resource_group

  # The VM's cloud-init reads BOTH Key Vault secrets (app-env, storage
  # connection string) at boot — those secret VALUES (not just the vault
  # container) must be fully written before the VM starts, or the boot
  # script's `az keyvault secret show` calls race the writes and the app
  # node comes up with an empty app.env/node.env for its first deploy. Same
  # race class as the GCP root's module.storage depends_on note on its
  # compute module block.
  depends_on = [module.secrets, module.storage, module.database]
}
