locals {
  name_prefix = var.deployment_name
  common_labels = merge({
    deployment = var.deployment_name
    managed-by = "terraform"
    component  = "telnyx-contact-center"
  }, var.labels)
}

# Terraform creates the CONTAINER for the app's runtime .env only — never
# the value. The wizard populates the real secret_data via
# `gcloud secrets versions add` right after Telnyx bootstrap resolves every
# TELNYX_* id/secret, mirroring the AWS root's cc-secrets module exactly
# (which documents the same "value managed outside Terraform" convention).
resource "google_secret_manager_secret" "app_env" {
  secret_id = "${local.name_prefix}-app-env"
  project   = var.project_id

  replication {
    auto {}
  }

  labels = local.common_labels
}

# Placeholder version so the secret has a resolvable "latest" version before
# the wizard's first `gcloud secrets versions add` call — an app node whose
# boot script races ahead of the wizard gets a clear sentinel instead of a
# "no version found" error that looks like a bug. Terraform intentionally
# never updates this version again after creation (see lifecycle block) —
# same pattern as the AWS root's aws_secretsmanager_secret_version
# "app_env_placeholder".
resource "google_secret_manager_secret_version" "app_env_placeholder" {
  secret      = google_secret_manager_secret.app_env.id
  secret_data = "# placeholder - populated by deploy wizard after Telnyx bootstrap"

  lifecycle {
    ignore_changes = [secret_data]
  }
}
