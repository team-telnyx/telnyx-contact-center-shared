locals {
  name_prefix = var.deployment_name
  common_labels = merge({
    deployment = var.deployment_name
    managed-by = "terraform"
    component  = "telnyx-contact-center"
  }, var.labels)
  # Secret Manager resource names come in as
  # "projects/<num>/secrets/<id>" from the other modules' outputs — IAM
  # bindings and the startup script both need just the secret id.
  db_secret_id           = element(split("/", var.db_secret_name), length(split("/", var.db_secret_name)) - 1)
  app_env_secret_id      = element(split("/", var.app_env_secret_name), length(split("/", var.app_env_secret_name)) - 1)
  storage_hmac_secret_id = element(split("/", var.storage_hmac_secret_name), length(split("/", var.storage_hmac_secret_name)) - 1)

  # GCP service account `account_id` is capped at 30 characters (same
  # constraint documented in cc-storage-gcp's storage_hmac account id) —
  # "${name_prefix}-app" overflows 30 for deployment names longer than 26
  # characters, even though the wizard's shared slugify() allows names up
  # to 31. Same defensive shorten-with-hash-suffix strategy: unchanged for
  # names that already fit (no behavior change for the common case),
  # truncated + hashed for names that don't so distinct long names never
  # collide on account_id.
  app_sa_suffix     = "-app"
  app_sa_full_id    = "${local.name_prefix}${local.app_sa_suffix}"
  app_sa_account_id = length(local.app_sa_full_id) <= 30 ? local.app_sa_full_id : "${substr(local.name_prefix, 0, 30 - length(local.app_sa_suffix) - 7)}-${substr(md5(local.name_prefix), 0, 6)}${local.app_sa_suffix}"
}

data "google_compute_image" "ubuntu" {
  family  = "ubuntu-2404-lts-amd64"
  project = "ubuntu-os-cloud"
}

# ===========================================================================
# IAM — instance service account, scoped tightly to THIS deployment's own
# secrets/bucket, mirrors the AWS root's per-deployment IAM role (no
# wildcard resource grants, no access to other deployments' resources in the
# same project).
# ===========================================================================

resource "google_service_account" "app" {
  account_id   = local.app_sa_account_id
  project      = var.project_id
  display_name = "Telnyx Contact Center app node (${var.deployment_name})"
}

resource "google_secret_manager_secret_iam_member" "read_db_secret" {
  secret_id = local.db_secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

resource "google_secret_manager_secret_iam_member" "read_app_env_secret" {
  secret_id = local.app_env_secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

resource "google_secret_manager_secret_iam_member" "read_storage_hmac_secret" {
  secret_id = local.storage_hmac_secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

# Scoped to exactly this deployment's own bucket (not project-wide
# storage.admin) — same "own prefixes only" tightness the AWS root's inline
# S3 policy has, though GCS IAM is bucket-grained rather than
# prefix-condition-grained the way AWS's s3:prefix condition key allows.
resource "google_storage_bucket_iam_member" "app_object_admin" {
  bucket = var.storage_bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.app.email}"
}

# Lets deploy scripts running ON the instance (gcp-cloud.mjs's remote deploy
# script, run over the IAP SSH tunnel — see module header) download the
# deploy-artifacts tarball GCS-side without any separate credential file:
# `gsutil`/`gcloud storage` on a GCE instance automatically uses the
# attached service account via the metadata server.
resource "google_project_iam_member" "log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.app.email}"
}

# ===========================================================================
# GCE instance — startup-script prepares the machine (Docker, gcloud CLI,
# zstd, fetches runtime secrets to disk) but does NOT start the app
# container itself — that's triggered explicitly by
# deploy/cli/lib/gcp-cloud.mjs over an IAP-tunneled SSH command once the
# first image tarball has been shipped to GCS (mirrors the AWS root's SSM
# RunCommand mechanism — see cc-compute-single's main.tf header for the
# shared rationale of keeping boot-time and update-time logic from
# diverging).
# ===========================================================================

resource "google_compute_instance" "app" {
  name         = "${local.name_prefix}-app"
  project      = var.project_id
  zone         = var.zone
  machine_type = var.machine_type
  tags         = [var.network_tag]

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = var.root_volume_size_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = var.subnet_self_link
    access_config {
      # Ephemeral public IP — the app is reached directly over HTTP in
      # Phase 1 (no HTTPS LB yet, see module header), and this is also what
      # `gcloud compute ssh --tunnel-through-iap` needs to exist (IAP
      # forwards through it, it does not require the IP be reachable
      # directly for SSH — see firewall rule instead).
    }
  }

  service_account {
    email  = google_service_account.app.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    startup-script = templatefile("${path.module}/templates/startup-script.sh.tpl", {
      app_port                = var.app_port
      streaming_ws_port       = var.streaming_ws_port
      project_id              = var.project_id
      app_env_secret_id       = local.app_env_secret_id
      storage_hmac_secret_id  = local.storage_hmac_secret_id
      storage_bucket          = var.storage_bucket_name
      portainer_agent_enabled = var.portainer_agent_enabled
      portainer_agent_port    = var.portainer_agent_port
    })
    # Explicit opt-in required for OS Login (which would otherwise change
    # how `gcloud compute ssh --tunnel-through-iap` resolves the login
    # identity) is intentionally NOT set here — default project metadata
    # applies. See gcp-cloud.mjs's IAP SSH helper for the exact invocation.
  }

  allow_stopping_for_update = true

  labels = merge(local.common_labels, { name = "${local.name_prefix}-app" })

  depends_on = [
    google_secret_manager_secret_iam_member.read_db_secret,
    google_secret_manager_secret_iam_member.read_app_env_secret,
    google_secret_manager_secret_iam_member.read_storage_hmac_secret,
    google_storage_bucket_iam_member.app_object_admin,
  ]
}

# ===========================================================================
# HTTPS Load Balancer (Phase 3) — GCP equivalent of the AWS root's ALB+ACM
# path (cc-compute-single's aws_lb/aws_lb_target_group/aws_lb_listener +
# acm.mjs's certificate orchestration). Entirely `count`-gated on
# var.lb_enabled, same shape as the AWS module's `alb_enabled` gate —
# nothing here exists when lb_enabled=false (Phase 1/2 default, plain HTTP
# directly on the instance's public IP).
#
# Structural difference from AWS's ACM: a `google_compute_managed_ssl_certificate`
# has NO separate "request, then create a DNS validation record, then wait
# for issuance" dance — Google's Certificate Authority validates ownership
# simply by finding the domain's DNS A/AAAA record pointing at the global
# forwarding rule's IP once that IP is known and the record is created
# (typically several minutes to ~1 hour after the DNS record propagates,
# sometimes longer). This means:
#   1. There is no cc-gcp-cloud equivalent of acm.mjs's request/validate/
#      poll orchestration — the certificate resource itself IS the whole
#      lifecycle, driven by a single `terraform apply`.
#   2. The certificate is inherently ONE Terraform resource this module
#      manages outright — there is no "reuse an existing certificate you
#      didn't create" concept the way ACM's createdByWizard tracking
#      exists for, so `terraform destroy` cleanly removes it with no
#      separate cleanup path to get wrong.
#   3. Until the DNS record is created and has propagated, the certificate
#      sits in PROVISIONING status and the LB serves a self-signed
#      fallback cert for HTTPS — the wizard's tail step (runGcpLbStep,
#      wizard.mjs) prints the load balancer's IP and the exact A record to
#      create, then polls the certificate's status the same way
#      waitForCertificateIssued does for ACM.
#
# Uses an unmanaged instance group (single VM, not a managed instance
# group / autoscaler) — appropriate for Phase 3's single-node scope; a
# future HA/multi-node GCP root would use a managed instance group instead
# (mirrors the AWS root's distinction between cc-compute-single's single
# aws_lb_target_group_attachment and cc-compute-ha's autoscaling-group
# style attachment).
# ===========================================================================

resource "google_compute_instance_group" "app" {
  count     = var.lb_enabled ? 1 : 0
  name      = "${local.name_prefix}-ig"
  project   = var.project_id
  zone      = var.zone
  instances = [google_compute_instance.app.self_link]

  named_port {
    name = "http"
    port = var.app_port
  }

  named_port {
    name = "ws"
    port = var.streaming_ws_port
  }
}

resource "google_compute_health_check" "app" {
  count   = var.lb_enabled ? 1 : 0
  name    = "${local.name_prefix}-hc-app"
  project = var.project_id

  http_health_check {
    port         = var.app_port
    request_path = "/api/health"
  }

  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3
}

resource "google_compute_backend_service" "app" {
  count                 = var.lb_enabled ? 1 : 0
  name                  = "${local.name_prefix}-backend-app"
  project               = var.project_id
  protocol              = "HTTP"
  port_name             = "http"
  timeout_sec           = 300 # matches the AWS ALB's idle_timeout=300 (SSE/long-poll streams)
  health_checks         = [google_compute_health_check.app[0].id]
  load_balancing_scheme = "EXTERNAL_MANAGED"

  backend {
    group = google_compute_instance_group.app[0].self_link
  }
}

resource "google_compute_health_check" "streaming_ws" {
  count   = var.lb_enabled ? 1 : 0
  name    = "${local.name_prefix}-hc-ws"
  project = var.project_id

  http_health_check {
    port         = var.streaming_ws_port
    request_path = "/api/health"
  }

  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3
}

resource "google_compute_backend_service" "streaming_ws" {
  count                 = var.lb_enabled ? 1 : 0
  name                  = "${local.name_prefix}-backend-ws"
  project               = var.project_id
  protocol              = "HTTP"
  port_name             = "ws"
  timeout_sec           = 300
  health_checks         = [google_compute_health_check.streaming_ws[0].id]
  load_balancing_scheme = "EXTERNAL_MANAGED"

  backend {
    group = google_compute_instance_group.app[0].self_link
  }
}

# Host/path routing: the streaming websocket path is routed by the
# ws.<domain> host header to the streaming_ws backend, everything else
# (the bare domain) goes to the app backend — same host-header-based split
# the AWS root's aws_lb_listener_rule.streaming_ws does for the ALB path.
resource "google_compute_url_map" "app" {
  count           = var.lb_enabled ? 1 : 0
  name            = "${local.name_prefix}-url-map"
  project         = var.project_id
  default_service = google_compute_backend_service.app[0].id

  host_rule {
    hosts        = ["ws.${var.domain}"]
    path_matcher = "streaming-ws"
  }

  path_matcher {
    name            = "streaming-ws"
    default_service = google_compute_backend_service.streaming_ws[0].id
  }
}

# Google-managed SSL certificate — see this section's header comment for
# the full validation-model explanation (no separate request/validate/poll
# dance the way ACM needs; Google's CA polls the domain's own DNS record).
# Includes BOTH the bare domain and its ws. subdomain as SANs so one
# certificate covers both backends' host-header routes above.
resource "google_compute_managed_ssl_certificate" "app" {
  count   = var.lb_enabled ? 1 : 0
  name    = "${local.name_prefix}-cert"
  project = var.project_id

  managed {
    domains = [var.domain, "ws.${var.domain}"]
  }
}

resource "google_compute_target_https_proxy" "app" {
  count            = var.lb_enabled ? 1 : 0
  name             = "${local.name_prefix}-https-proxy"
  project          = var.project_id
  url_map          = google_compute_url_map.app[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.app[0].id]
}

# Global static IP — reserved BEFORE the certificate is expected to
# validate, since the operator needs this address to create the DNS A
# record the managed certificate polls for. Global (not regional) because
# the forwarding rule below is a global external HTTPS LB forwarding rule.
resource "google_compute_global_address" "lb" {
  count   = var.lb_enabled ? 1 : 0
  name    = "${local.name_prefix}-lb-ip"
  project = var.project_id
}

resource "google_compute_global_forwarding_rule" "https" {
  count                 = var.lb_enabled ? 1 : 0
  name                  = "${local.name_prefix}-fwd-https"
  project               = var.project_id
  ip_address            = google_compute_global_address.lb[0].address
  port_range            = "443"
  target                = google_compute_target_https_proxy.app[0].id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# Plain :80 -> :443 redirect (matches the AWS ALB's http listener default
# action), so a browser hitting http://<domain> gets bounced to https://
# instead of a connection refused / raw app response over an unintended
# plaintext path.
resource "google_compute_url_map" "http_redirect" {
  count   = var.lb_enabled ? 1 : 0
  name    = "${local.name_prefix}-url-map-http-redirect"
  project = var.project_id

  default_url_redirect {
    https_redirect = true
    strip_query    = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  count   = var.lb_enabled ? 1 : 0
  name    = "${local.name_prefix}-http-proxy"
  project = var.project_id
  url_map = google_compute_url_map.http_redirect[0].id
}

resource "google_compute_global_forwarding_rule" "http" {
  count                 = var.lb_enabled ? 1 : 0
  name                  = "${local.name_prefix}-fwd-http"
  project               = var.project_id
  ip_address            = google_compute_global_address.lb[0].address
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect[0].id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# ===========================================================================
# Optional Cloud DNS record — GCP equivalent of the AWS root's
# aws_route53_record.app (cc-compute-single/main.tf). count-gated on BOTH
# lb_enabled (there is no stable, Terraform-managed public IP to point a
# record at otherwise — the bare instance's ephemeral public IP is not a
# good Terraform-managed DNS target) AND a non-empty dns_managed_zone (the
# operator's explicit consent, resolved by the wizard's runGcpDnsStep and
# threaded through by gcp-cloud.mjs's writeGcpTfvars exactly like AWS's
# dns_zone_id/dnsManaged gate).
#
# Two A records are created — the bare domain (routed to the app backend by
# the url_map's default_service) and the ws. subdomain (routed to the
# streaming_ws backend by the url_map's host_rule) — both pointing at the
# SAME global Load Balancer IP, since GCP's HTTPS LB does host-header
# routing at the proxy layer rather than needing distinct IPs per backend.
# ===========================================================================

resource "google_dns_record_set" "app" {
  count        = (var.lb_enabled && var.dns_managed_zone != "") ? 1 : 0
  project      = var.project_id
  managed_zone = var.dns_managed_zone
  name         = "${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.lb[0].address]
}

resource "google_dns_record_set" "app_ws" {
  count        = (var.lb_enabled && var.dns_managed_zone != "") ? 1 : 0
  project      = var.project_id
  managed_zone = var.dns_managed_zone
  name         = "ws.${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.lb[0].address]
}
