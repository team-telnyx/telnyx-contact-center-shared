locals {
  name_prefix = var.deployment_name
  common_tags = merge({
    deployment = var.deployment_name
    managed-by = "terraform"
    component  = "telnyx-contact-center"
  }, var.tags)

  # Storage Account names are GLOBALLY unique across ALL of Azure, 3-24
  # chars, LOWERCASE ALPHANUMERIC ONLY — no hyphens, no underscores. This is
  # tighter than S3 (hyphens allowed) and GCS (hyphens allowed, up to 63
  # chars) bucket names, and tighter even than this deployment's own Key
  # Vault name limit (which at least allows hyphens). The wizard's
  # deployment_name slug allows hyphens and up to 31 chars, so it almost
  # never fits directly — strip hyphens, lowercase, then apply the same
  # truncate+hash defensive strategy cc-storage-gcp's storage_hmac_account_id
  # and this deployment's own cc-secrets-azure kv_name locals already use,
  # sized for the tighter 24-char/no-hyphen constraint here.
  sa_name_raw   = lower(replace(local.name_prefix, "-", ""))
  sa_name_short = length(local.sa_name_raw) <= 20 ? local.sa_name_raw : substr(local.sa_name_raw, 0, 20)
  sa_name       = "${local.sa_name_short}${substr(md5(local.name_prefix), 0, 4)}"
}

data "azurerm_client_config" "current" {}

# The identity running `terraform apply`/the wizard's deploy step needs
# DATA-PLANE access to upload blobs (`az storage blob upload --auth-mode
# login`, see deploy/cli/lib/azure-deploy.mjs's uploadArtifactToBlob) —
# discovered as a real, live "You do not have the required permissions"
# 403 on a first real e2e deploy. Azure RBAC splits management-plane roles
# (Contributor, Owner — control who can create/delete the storage account
# resource) from DATA-plane roles (Storage Blob Data Contributor/Reader —
# control who can read/write blobs INSIDE it) as two independent axes;
# holding Contributor on the subscription does NOT implicitly grant blob
# read/write, however privileged it looks. The VM's own Managed Identity
# already gets this same role in cc-compute-single-azure
# (app_storage_blob_contributor) for the identical reason — this is the
# missing deployer-side half of that same requirement, mirrored here
# rather than in the root module so the grant lives right next to the
# storage account it applies to.
resource "azurerm_role_assignment" "deployer_storage_blob_contributor" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Codex review finding (PR #1197): when Terraform is authenticated as a
# Service Principal via the ARM_* env vars (deploy/terraform/azure/
# single-node/versions.tf's documented auth model — the wizard's own
# `cc-deploy-wizard` SP, see the azure-infra-provisioning skill) but the
# operator's `az` CLI session driving `az storage blob upload --auth-mode
# login` (deploy/cli/lib/azure-deploy.mjs's uploadArtifactToBlob) is a
# DIFFERENT identity — e.g. the operator's own interactive `az login` user
# — the role assignment above only covers the Terraform SP. `--auth-mode
# login` always uses the CLI's OWN active session credentials, never the
# ARM_* Terraform credentials, so the actual uploader can still 403 with
# "You do not have the required permissions" even though `terraform apply`
# itself succeeded cleanly. Grant the same role to that second identity
# too, when the caller (writeAzureTfvars's resolveActiveAzureIdentity)
# tells us it differs from Terraform's own identity — see
# cc-storage-azure/variables.tf's uploader_object_id docstring.
#
# The equality check against Terraform's own identity is done in the
# CALLER (azure-cloud.mjs, in plain JS) rather than in a `count` expression
# here comparing against data.azurerm_client_config.current.object_id —
# this module's `storage` block carries `depends_on = [module.secrets]` at
# the ROOT level (azure/single-node/main.tf), which makes EVERY resource
# and data source inside this module (including this module's own
# data.azurerm_client_config.current) a deferred, apply-time-only read.
# `count` can't depend on a value Terraform can't resolve during `plan`
# ("Invalid count argument... cannot be determined until apply") — the
# caller pre-computing an already-empty-when-equal uploader_object_id
# sidesteps that entirely, at the cost of one extra `az` call in
# writeAzureTfvars instead of a Terraform-native comparison.
resource "azurerm_role_assignment" "deployer_storage_blob_contributor_uploader" {
  count                = var.uploader_object_id != "" ? 1 : 0
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.uploader_object_id
}

resource "azurerm_storage_account" "main" {
  name                     = local.sa_name
  resource_group_name      = var.resource_group_name
  location                 = var.location
  account_tier             = var.account_tier
  account_replication_type = var.account_replication_type

  # Blob versioning — the closest Azure Blob equivalent of S3/GCS bucket
  # versioning (AWS/GCP roots both enable it on their storage modules).
  blob_properties {
    versioning_enabled = true

    dynamic "cors_rule" {
      for_each = var.domain != "" ? [1] : []
      content {
        allowed_origins    = ["https://${var.domain}"]
        allowed_methods    = ["GET", "PUT", "POST", "HEAD"]
        allowed_headers    = ["*"]
        exposed_headers    = ["ETag"]
        max_age_in_seconds = 3000
      }
    }
  }

  # Public access stays OFF at the account level — the app reaches Blob
  # Storage exclusively through the Managed Identity + RBAC path (see
  # cc-compute-single-azure's role assignment) or, for local
  # tooling/debugging, the connection-string secret below. No SAS/public
  # container URLs by default, matching the AWS/GCP roots' private-bucket
  # default (presigned URLs only).
  public_network_access_enabled   = true
  allow_nested_items_to_be_public = false

  min_tls_version = "TLS1_2"

  tags = merge(local.common_tags, { name = "${local.name_prefix}-storage" })
}

# One container per deployment, same logical layout as the AWS/GCP roots'
# single-bucket-with-prefixes design (media/ | logs/ | deploy-artifacts/
# inside one container) rather than one container per prefix — simpler
# RBAC, simpler teardown.
resource "azurerm_storage_container" "main" {
  name                  = "cc-media"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# Lifecycle management policy — mirrors the AWS/GCP roots' lifecycle rules:
# age out old deploy-artifact blobs quickly, tier down old media blobs to a
# cheaper cool/archive tier instead of deleting them.
resource "azurerm_storage_management_policy" "main" {
  storage_account_id = azurerm_storage_account.main.id

  rule {
    name    = "expire-deploy-artifacts"
    enabled = true
    filters {
      prefix_match = ["cc-media/deploy-artifacts/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 14
      }
      snapshot {
        delete_after_days_since_creation_greater_than = 3
      }
    }
  }

  rule {
    name    = "tier-down-old-media"
    enabled = true
    filters {
      prefix_match = ["cc-media/media/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        tier_to_cool_after_days_since_modification_greater_than = 30
      }
    }
  }
}

# Connection-string secret — written to the SHARED per-deployment Key Vault
# (see cc-secrets-azure's header for why one vault, not one per module).
# Primarily a fallback/debugging credential for local tooling (`az storage`
# CLI, Azure Storage Explorer); the app node itself authenticates via its
# Managed Identity + RBAC role assignment (cc-compute-single-azure), not
# this connection string, so this secret is never read by the boot
# sequence — parallels how the AWS/GCP roots' storage HMAC/access-key
# secrets exist primarily for the app driver's auth, whereas here the
# equivalent driver auth path is identity-based and this secret is the
# secondary/manual-access path instead.
resource "azurerm_key_vault_secret" "storage_connection_string" {
  name         = "${local.name_prefix}-storage-connection-string"
  key_vault_id = var.key_vault_id
  value        = azurerm_storage_account.main.primary_connection_string

  tags = local.common_tags
}
