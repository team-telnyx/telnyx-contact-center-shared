variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "deployment_name" {
  type = string
}

variable "key_vault_id" {
  description = "Shared per-deployment Key Vault id to write the storage connection-string secret into (cc-secrets-azure's key_vault_id output)."
  type        = string
}

variable "domain" {
  description = "The deployment's public domain (for the Blob container's CORS allowed_origins). Empty string is valid for domain-less setups — mirrors the AWS/GCP roots' cc-storage module."
  type        = string
  default     = ""
}

variable "account_tier" {
  type    = string
  default = "Standard"
}

variable "account_replication_type" {
  description = "LRS (locally redundant, cheapest) by default — bump to ZRS/GRS for HA/Large sizing if cross-zone/cross-region durability is required."
  type        = string
  default     = "LRS"
}

variable "tags" {
  type    = map(string)
  default = {}
}

# ---------------------------------------------------------------------------
# Optional SECOND deployer identity for the blob-upload data-plane role —
# see the azurerm_role_assignment.deployer_storage_blob_contributor_uploader
# resource below for the full rationale (Terraform's own auth identity vs.
# the identity actually running `az storage blob upload --auth-mode login`
# can be two different principals).
# ---------------------------------------------------------------------------
variable "uploader_object_id" {
  description = "Azure AD object id of the identity that will run `az storage blob upload --auth-mode login` (deploy/cli/lib/azure-deploy.mjs's uploadArtifactToBlob) — i.e. whatever `az account show` reports as the CALLER's own signed-in identity, resolved by the wizard (see azure-cloud.mjs's resolveActiveAzureIdentity). Empty string (default) means \"assume it's the same identity Terraform itself is authenticated as\" (data.azurerm_client_config.current.object_id) and skip the extra grant — safe/idempotent when Terraform and `az login` really are the same principal, which is the common case for a single-operator interactive `cc up` run."
  type        = string
  default     = ""
}
