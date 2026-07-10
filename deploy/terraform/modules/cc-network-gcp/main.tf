locals {
  name_prefix = var.deployment_name
  common_labels = merge({
    deployment = var.deployment_name
    managed-by = "terraform"
    component  = "telnyx-contact-center"
  }, var.labels)
}

# ===========================================================================
# VPC — one dedicated VPC + subnet per deployment, no sharing with anything
# else in the project. Mirrors the AWS root's per-deployment VPC design.
# ===========================================================================

resource "google_compute_network" "main" {
  name                    = "${local.name_prefix}-vpc"
  project                 = var.project_id
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "${local.name_prefix}-subnet"
  project       = var.project_id
  region        = var.region
  network       = google_compute_network.main.id
  ip_cidr_range = var.subnet_cidr

  # Needed so the app node can reach Google APIs (Secret Manager, GCS,
  # Cloud SQL Admin API for the private-IP peering handshake) via Google's
  # private network path without a public IP being strictly required for
  # that traffic — mirrors AWS's use of public subnets + IAM (no NAT) for
  # the same class of traffic.
  private_ip_google_access = true
}

# ===========================================================================
# Private Services Access — required for Cloud SQL to get a PRIVATE IP
# inside this VPC (the GCP equivalent of RDS living in an AWS private
# subnet, reachable only from app nodes). This is Google's VPC-peering
# mechanism for “managed services” (Cloud SQL, Memorystore, etc.): a
# dedicated /20 IP range is reserved and peered with
# servicenetworking.googleapis.com, and Cloud SQL allocates its private IP
# out of that range. Without this, Cloud SQL would only be reachable via a
# public IP + authorized-networks allowlist or the Cloud SQL Auth Proxy —
# viable fallbacks, but a public database endpoint by default is a worse
# security default than what the AWS path ships (RDS is never publicly
# accessible there), so this is the one-time plumbing cost paid to match it.
# ===========================================================================

resource "google_compute_global_address" "private_services" {
  name          = "${local.name_prefix}-psa-range"
  project       = var.project_id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]

  # On `terraform destroy`, Cloud SQL's own instance deletion (the sibling
  # google_sql_database_instance resource, over in cc-database-gcp) is
  # asynchronous on GCP's backend even after the Cloud SQL Admin API call
  # that deletes it returns success — the underlying VPC peering cleanup for
  # that instance can lag behind by anywhere from seconds to a couple of
  # minutes. Terraform's own destroy ordering runs the SQL instance delete
  # first (correctly — it's the dependent resource), but the very next
  # thing it does is try to delete THIS peering connection, and GCP still
  # considers it in-use by the not-yet-fully-cleaned-up SQL instance:
  #   "Unable to remove Service Networking Connection ... Error code 9:
  #   Failed to delete connection; Producer services (e.g. CloudSQL, Cloud
  #   Memstore, etc.) are still using this connection."
  # Confirmed via a real `cc destroy` E2E run against a live GCP project —
  # happened AFTER the Cloud SQL instance itself had
  # already reported successful deletion (✔ sql database instance, 1m45s).
  # deletion_policy = "ABANDON" is Google's own documented workaround for
  # exactly this class of failure (see the provider's own field
  # description: "Prevents terraform apply failures with CloudSQL"). Safe
  # here because the whole VPC (google_compute_network.main) is being
  # destroyed in the same operation regardless — GCP cleans up the peering
  # on its own once the VPC itself is gone, same reasoning as
  # cc-database-gcp's google_sql_database/google_sql_user ABANDON policy
  # (see that module's main.tf) for the sibling class of destroy-ordering
  # race this deployment already hit.
  deletion_policy = "ABANDON"
}

# ===========================================================================
# FIREWALL RULES
# ===========================================================================

# SSH is reachable ONLY via IAP TCP forwarding (`gcloud compute ssh
# --tunnel-through-iap`), never a public Internet-facing port 22 — the GCP
# equivalent of AWS's EC2 Instance Connect auto-resolved CIDR. 35.235.240.0/20
# is Google's own published, stable IAP source range; opening it does NOT
# expose port 22 to the public internet (only traffic proxied through IAP,
# itself gated by the identity's IAM permissions, originates from it).
resource "google_compute_firewall" "allow_iap_ssh" {
  name    = "${local.name_prefix}-allow-iap-ssh"
  project = var.project_id
  network = google_compute_network.main.id

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = var.admin_ssh_source_ranges
  target_tags   = ["${local.name_prefix}-app"]
}

# App ports, direct — only when there is no HTTPS Load Balancer in front
# (lb_enabled=false, Phase 1/2 default). Once the LB exists (Phase 3,
# cc-compute-single-gcp's google_compute_backend_service), the public
# entry point is the LB's own global anycast IP/forwarding rule, not the
# instance directly — so this direct-access rule is entirely superseded by
# the allow_lb_health_check rule below, mirroring the AWS root's
# alb_enabled-gated security group rule shape exactly.
resource "google_compute_firewall" "allow_app_ports" {
  count   = var.lb_enabled ? 0 : 1
  name    = "${local.name_prefix}-allow-app-ports"
  project = var.project_id
  network = google_compute_network.main.id

  allow {
    protocol = "tcp"
    ports    = [tostring(var.app_port), tostring(var.streaming_ws_port)]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["${local.name_prefix}-app"]
}

# Google's published, stable source ranges for HTTP(S) Load Balancer health
# checks AND the actual proxied traffic from the LB to backends (both the
# classic and Envoy-based proxy paths use these two ranges) — see
# https://cloud.google.com/load-balancing/docs/health-check-concepts#ip-ranges.
# Opening these (not 0.0.0.0/0) is what makes the LB reachable while keeping
# the instance's app ports closed to the public internet directly, the GCP
# equivalent of the AWS root's ALB security group being the only thing
# allowed to reach the app security group when alb_enabled=true.
resource "google_compute_firewall" "allow_lb_health_check" {
  count   = var.lb_enabled ? 1 : 0
  name    = "${local.name_prefix}-allow-lb-health-check"
  project = var.project_id
  network = google_compute_network.main.id

  allow {
    protocol = "tcp"
    ports    = [tostring(var.app_port), tostring(var.streaming_ws_port)]
  }

  source_ranges = ["130.211.0.0/22", "35.191.0.0/16"]
  target_tags   = ["${local.name_prefix}-app"]
}

resource "google_compute_firewall" "allow_portainer_agent" {
  count   = var.portainer_agent_enabled && length(var.portainer_server_cidrs) > 0 ? 1 : 0
  name    = "${local.name_prefix}-allow-portainer-agent"
  project = var.project_id
  network = google_compute_network.main.id

  allow {
    protocol = "tcp"
    ports    = [tostring(var.portainer_agent_port)]
  }

  source_ranges = var.portainer_server_cidrs
  target_tags   = ["${local.name_prefix}-app"]
}
