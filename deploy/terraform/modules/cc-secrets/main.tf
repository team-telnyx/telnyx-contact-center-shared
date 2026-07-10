locals {
  name_prefix = var.deployment_name
  common_tags = merge({
    Name       = var.deployment_name
    Deployment = var.deployment_name
    ManagedBy  = "terraform"
    Component  = "telnyx-contact-center"
  }, var.tags)
}

# Terraform creates the CONTAINER for the app's runtime .env only — never the
# value. The wizard populates the real secret_string via
# `aws secretsmanager put-secret-value` right after Telnyx bootstrap resolves
# every TELNYX_* id/secret, mirroring the internal convention documented on
# cc-ha-infra's `app_env_secret_name` variable ("value managed outside
# Terraform"). This keeps the full .env contents (including the Telnyx API
# key and NEXTAUTH_SECRET) out of tfstate entirely.
resource "aws_secretsmanager_secret" "app_env" {
  name        = "${local.name_prefix}/app/env"
  description = "Telnyx Contact Center runtime .env (populated by the deploy wizard after Telnyx bootstrap, not by Terraform)"
  tags        = local.common_tags
  # See cc-database's db secret for the rationale — force immediate deletion
  # on destroy so re-applying the same deployment_name doesn't hit
  # ResourceExistsException("...scheduled for deletion") from AWS's default
  # 30-day recovery window.
  recovery_window_in_days = 0
}

# Placeholder version so the secret has a resolvable AWSCURRENT stage before
# the wizard's first put-secret-value call — an EC2 node's cloud-init that
# races ahead of the wizard (e.g. on a `terraform apply`-only re-run without
# going through `cc up`) gets a clear sentinel instead of a "no value found"
# error that looks like a bug.
resource "aws_secretsmanager_secret_version" "app_env_placeholder" {
  secret_id     = aws_secretsmanager_secret.app_env.id
  secret_string = "# placeholder - populated by deploy wizard after Telnyx bootstrap"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
