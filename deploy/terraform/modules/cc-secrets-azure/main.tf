locals {
  name_prefix = var.deployment_name
  common_tags = merge({
    deployment = var.deployment_name
    managed-by = "terraform"
    component  = "telnyx-contact-center"
  }, var.tags)

  # Key Vault names are GLOBALLY unique, 3-24 chars, alphanumeric + hyphen
  # only, must start with a letter — tighter than S3/GCS bucket names
  # (which allow longer, more varied names). Same truncate+hash defensive
  # strategy as cc-storage-gcp's storage_hmac_account_id: unchanged for
  # names that already fit, truncated+hashed for names that don't, so two
  # long deployment names sharing a prefix never collide.
  kv_suffix    = "-kv"
  kv_full_name = "${local.name_prefix}${local.kv_suffix}"
  kv_name      = length(local.kv_full_name) <= 24 ? local.kv_full_name : "${substr(local.name_prefix, 0, 24 - length(local.kv_suffix) - 5)}-${substr(md5(local.name_prefix), 0, 4)}${local.kv_suffix}"
}

data "azurerm_client_config" "current" {}

# ===========================================================================
# ONE Key Vault per deployment, shared by every module that needs to store a
# secret (database credentials, storage account key, and the app runtime
# .env placeholder below) — a deliberate departure from the AWS/GCP roots'
# shape, where each module (cc-database/cc-storage/cc-secrets) owns its own
# independent secret resource directly in a flat, project-wide secret
# namespace (Secrets Manager / Secret Manager). Azure Key Vault is a
# provisioned CONTAINER resource in its own right (not a flat namespace),
# with its own soft-delete/purge-protection lifecycle, RBAC surface, and a
# hard 90-day-default soft-delete retention per vault (see this module's
# purge_protection_enabled=false + the skill's Key Vault soft-delete
# pitfall). Creating three separate per-deployment vaults (one each for db/
# storage/app-env) would triple that soft-delete/purge management surface
# for zero practical benefit — a single vault's secrets are already
# individually access-controlled via secret-level RBAC
# (azurerm_role_assignment scoped to a specific secret, not just the vault),
# so this module is the SOLE owner of the Key Vault resource, and
# cc-database-azure / cc-storage-azure receive its id as an input variable
# and write their own secrets into it rather than creating their own vaults.
# ===========================================================================

resource "azurerm_key_vault" "main" {
  name                = local.kv_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  # RBAC-based access (azurerm_role_assignment scoped to this vault or
  # individual secrets) instead of the legacy vault access-policy model —
  # matches how the compute module's User-Assigned Managed Identity is
  # granted read access (azurerm_role_assignment "Key Vault Secrets User"),
  # consistent with the rest of this deployment's IAM being modeled as
  # Azure RBAC role assignments throughout, not a vault-local policy list.
  rbac_authorization_enabled = true

  # false (not the Azure default of true) — reproducible lab/demo
  # deployments need `cc destroy` followed by a fresh `cc up` under the SAME
  # deployment name to actually succeed. purge_protection_enabled=true would
  # make the vault (and everything in it) unrecoverable-but-not-gone for 90
  # days, blocking a same-name recreate with "vault name already in use" —
  # the Key Vault analogue of the AWS/GCP skill's Secrets Manager
  # recovery_window_in_days=0 pitfall. Soft-delete itself (the 90-day
  # recovery window) cannot be disabled at all as of the current Key Vault
  # API — only purge protection is togglable — but that's fine: the
  # azurerm provider's `features.key_vault.purge_soft_delete_on_destroy`
  # defaults to true (see versions.tf's empty `features {}` block, which
  # takes every provider default as-is), so `terraform destroy` already
  # purges this vault as part of destroying it — no separate `az keyvault
  # purge` step is needed or should be added in the CLI (a prior version
  # of destroyAzureInfra did add one, and it always failed with
  # DeletedVaultNotFound since the vault was already fully gone by the
  # time it ran — removed).
  purge_protection_enabled   = false
  soft_delete_retention_days = 7

  tags = local.common_tags
}

# Terraform creates the CONTAINER for the app's runtime .env only — never
# the value. The wizard populates the real secret value via
# `az keyvault secret set` right after Telnyx bootstrap resolves every
# TELNYX_* id/secret, mirroring the AWS/GCP roots' cc-secrets module exactly
# (documented "value managed outside Terraform" convention).
resource "azurerm_key_vault_secret" "app_env" {
  name         = "${local.name_prefix}-app-env"
  key_vault_id = azurerm_key_vault.main.id
  value        = "# placeholder - populated by deploy wizard after Telnyx bootstrap"

  lifecycle {
    ignore_changes = [value]
  }

  depends_on = [azurerm_role_assignment.deployer_secrets_officer]
}

# The Service Principal/user running `terraform apply` needs write access to
# create the placeholder secret above — Key Vault RBAC applies to the
# CALLER too, not just the VM's managed identity (which only gets READ
# access, see cc-compute-single-azure). Without this, `terraform apply`
# itself fails on the very first azurerm_key_vault_secret create with a
# 403, even though the identity running apply is subscription Owner/
# Contributor (Key Vault RBAC is enforced independently of general
# subscription-level roles once enable_rbac_authorization=true).
resource "azurerm_role_assignment" "deployer_secrets_officer" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Same rationale as deployer_secrets_officer above, but for CERTIFICATES —
# a Key Vault RBAC-relevant action distinct from secrets, requiring its own
# role. The operator (or a wizard-driven service principal, per
# runAzureLbStep's printed instructions) runs `az keyvault certificate
# import` to load a real TLS cert BEFORE the Application Gateway apply —
# discovered as a real, live "Forbidden" 403 on
# 'Microsoft.KeyVault/vaults/certificates/import/action' during a first e2e
# Application Gateway test: holding Key Vault Secrets Officer does NOT
# implicitly grant certificate import/read, even though certificates are
# stored as a specialized secret type under the hood. Without this grant,
# the exact two-pass flow runAzureLbStep documents (apply once without the
# Gateway, import the cert, apply again with it) is unusable for whichever
# identity actually holds the Service Principal's credentials.
resource "azurerm_role_assignment" "deployer_certificates_officer" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Certificates Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}
