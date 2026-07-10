locals {
  name_prefix = var.deployment_name
  common_labels = merge({
    deployment = var.deployment_name
    managed-by = "terraform"
    component  = "telnyx-contact-center"
  }, var.labels)

  # GCP service account `account_id` is capped at 30 characters. The
  # wizard's shared slugify() allows deployment names up to 31 characters
  # (a limit sized for AWS, which has no comparably tight identifier here),
  # so "${name_prefix}-storage-hmac" (the -storage-hmac suffix alone is 13
  # chars) overflows 30 for any deployment name longer than 17 characters —
  # Terraform would fail apply with an invalid-account-id error only after
  # Telnyx bootstrap has already created live resources. Defensively shorten
  # instead of assuming the caller enforces the length: for names that fit,
  # use the natural id unchanged (keeps existing deployments' account_id
  # stable — no behavior change for the common case); for names that don't
  # fit, truncate the prefix and append a short hash of the full name so two
  # long deployment names sharing a common prefix still get distinct,
  # non-colliding account ids.
  storage_hmac_suffix     = "-storage-hmac"
  storage_hmac_full_id    = "${local.name_prefix}${local.storage_hmac_suffix}"
  storage_hmac_account_id = length(local.storage_hmac_full_id) <= 30 ? local.storage_hmac_full_id : "${substr(local.name_prefix, 0, 30 - length(local.storage_hmac_suffix) - 7)}-${substr(md5(local.name_prefix), 0, 6)}${local.storage_hmac_suffix}"
}

# One bucket per deployment, same logical layout as the AWS root's cc-storage
# module (media/ | logs/ | deploy-artifacts/ prefixes in a single bucket)
# rather than three separate buckets — simpler IAM, simpler teardown.
resource "google_storage_bucket" "main" {
  name     = "${local.name_prefix}-${random_id.bucket_suffix.hex}"
  project  = var.project_id
  location = var.location

  # GCS bucket names are GLOBAL (unlike S3, still global too, but GCS is
  # stricter about reuse cooldowns after deletion) — random_id suffix avoids
  # collisions across deployments/operators the same way the AWS root does.
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  # force_destroy: same rationale as the AWS root's aws_s3_bucket.main —
  # versioning means every object accumulates noncurrent versions, and a
  # plain bucket delete fails with "bucket not empty" unless every object+
  # version is purged first. force_destroy makes `terraform destroy`/
  # `cc destroy` actually tear the bucket down instead of requiring the
  # operator to hand-purge it via `gcloud storage rm` first (the exact
  # BucketNotEmpty class of incident the AWS root's force_destroy fix was
  # added for).
  force_destroy = true

  dynamic "cors" {
    for_each = var.domain != "" ? [1] : []
    content {
      origin          = ["https://${var.domain}"]
      method          = ["GET", "PUT", "POST", "HEAD"]
      response_header = ["ETag"]
      max_age_seconds = 3000
    }
  }

  lifecycle_rule {
    condition {
      age            = 30
      matches_prefix = ["media/"]
      with_state     = "ARCHIVED" # GCS's "noncurrent version" equivalent
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }

  lifecycle_rule {
    condition {
      age            = 14
      matches_prefix = ["deploy-artifacts/"]
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age            = 3
      matches_prefix = ["deploy-artifacts/"]
      with_state     = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  labels = merge(local.common_labels, { name = "${local.name_prefix}-storage" })
}

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

# ===========================================================================
# HMAC key — the app's storage driver (lib/storage/s3-driver.mjs) talks to
# GCS over its S3-compatible "interoperability" API
# (STORAGE_ENDPOINT=https://storage.googleapis.com), which authenticates with
# an S3-style access-key/secret-key pair rather than a service account JSON
# key or ADC. GCS's interop layer issues these as HMAC keys bound to a
# service account. This lets the SAME storage driver code serve AWS S3, GCS,
# and MinIO without a GCS-specific driver having to be written — see
# lib/storage/s3-driver.mjs's own header for the three supported backends.
# ===========================================================================

resource "google_service_account" "storage_hmac" {
  account_id   = local.storage_hmac_account_id
  project      = var.project_id
  display_name = "Telnyx Contact Center storage HMAC (${var.deployment_name})"
}

resource "google_storage_bucket_iam_member" "hmac_object_admin" {
  bucket = google_storage_bucket.main.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.storage_hmac.email}"
}

resource "google_storage_hmac_key" "main" {
  service_account_email = google_service_account.storage_hmac.email
  project               = var.project_id
}

# The HMAC secret is sensitive (it's a bearer credential for the whole
# bucket) — never surfaced as a plain Terraform output (same rule as the
# database module's random_password.db). Stored in its own Terraform-owned
# Secret Manager secret; the wizard/app read it back via
# `gcloud secrets versions access`, never via `terraform output`.
resource "google_secret_manager_secret" "storage_hmac" {
  secret_id = "${local.name_prefix}-storage-hmac"
  project   = var.project_id

  replication {
    auto {}
  }

  labels = local.common_labels
}

resource "google_secret_manager_secret_version" "storage_hmac" {
  secret = google_secret_manager_secret.storage_hmac.id
  secret_data = jsonencode({
    access_id = google_storage_hmac_key.main.access_id
    secret    = google_storage_hmac_key.main.secret
  })
}
