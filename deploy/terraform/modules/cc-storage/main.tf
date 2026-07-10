locals {
  name_prefix = var.deployment_name
  common_tags = merge({
    Name       = var.deployment_name
    Deployment = var.deployment_name
    ManagedBy  = "terraform"
    Component  = "telnyx-contact-center"
  }, var.tags)
}

# One bucket per deployment, logically separated by prefix rather than
# provisioning 3 separate buckets — simpler IAM (one resource ARN pattern),
# simpler teardown, still separated for lifecycle-rule purposes:
#   media/             - user-uploaded call recordings/attachments (STORAGE_BUCKET,
#                        long-lived, versioned)
#   logs/              - optional JSONL diagnostic log archive (LOG_ARCHIVE_BUCKET)
#   deploy-artifacts/  - Docker image tarballs shipped from the operator's
#                        machine via the S3-tarball deploy mechanism (short-lived,
#                        pruned by lifecycle rule below)
resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "main" {
  bucket = "${local.name_prefix}-${random_id.bucket_suffix.hex}"
  tags   = merge(local.common_tags, { Name = "${local.name_prefix}-storage" })

  # Versioning is enabled below (call recordings/media are worth protecting
  # from accidental overwrite), which means every object accumulates
  # noncurrent versions over the bucket's lifetime — plain `DeleteBucket`
  # fails with BucketNotEmpty as soon as ANY version (current or noncurrent)
  # is left behind, which is virtually guaranteed for a bucket that's ever
  # received a deploy-artifacts upload or a media file. force_destroy makes
  # `terraform destroy`/`cc destroy` actually tear the bucket down instead of
  # requiring an operator to hand-purge every object+version via the AWS CLI
  # first (see the cc-test3 destroy incident this was added for).
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "main" {
  bucket = aws_s3_bucket.main.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "main" {
  bucket = aws_s3_bucket.main.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "main" {
  bucket                  = aws_s3_bucket.main.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CORS only matters for the media/ prefix (frontend direct upload/download via
# presigned URL); scoped to the deployment's own domain when known. When no
# domain is set yet (e.g. very first apply before Telnyx bootstrap resolves a
# tunnel/domain), fall back to no external origins — same-origin server-side
# fetches still work regardless of CORS.
resource "aws_s3_bucket_cors_configuration" "main" {
  count  = var.domain != "" ? 1 : 0
  bucket = aws_s3_bucket.main.id
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = ["https://${var.domain}"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "main" {
  bucket = aws_s3_bucket.main.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "media-noncurrent-to-ia"
    status = "Enabled"
    filter { prefix = "media/" }
    noncurrent_version_transition {
      noncurrent_days = 30
      storage_class   = "STANDARD_IA"
    }
  }

  # Deploy artifacts are immutable build outputs consumed once per deploy —
  # prune old ones automatically instead of accumulating image tarballs
  # forever (each is typically several hundred MB).
  rule {
    id     = "deploy-artifacts-expire"
    status = "Enabled"
    filter { prefix = "deploy-artifacts/" }
    expiration {
      days = 14
    }
    noncurrent_version_expiration {
      noncurrent_days = 3
    }
  }
}
