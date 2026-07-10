variable "project_id" {
  description = "GCP project ID this deployment lives in (must already exist — the wizard does not create projects). All resources this Terraform root manages are created inside it."
  type        = string
}

variable "region" {
  description = "GCP region for this deployment (e.g. \"us-central1\", \"europe-west3\")."
  type        = string
}

variable "zone" {
  description = "GCP zone within `region` for the Compute Engine instance (e.g. \"us-central1-a\"). Cloud SQL and GCS are regional/multi-regional and don't need a zone."
  type        = string
}

variable "deployment_name" {
  description = "Deployment slug (e.g. \"cc-main\"), validated ^[a-z0-9][a-z0-9-]{1,30}$ by the wizard before this is written. Also used verbatim as the GCE instance name and Cloud SQL instance id (both must be valid GCP resource names, which the same slug pattern already satisfies)."
  type        = string
}

variable "domain" {
  description = "Public domain for the app (e.g. \"cc.example.com\"), or empty string when no domain is configured yet. When lb_enabled=false (default), there is no HTTPS Load Balancer — the app is reached directly over plain HTTP on the instance's public IP; the operator's own DNS/reverse-proxy/CDN is responsible for HTTPS, same as the AWS no-ALB path. When lb_enabled=true, this is REQUIRED — it's the exact hostname the Google-managed SSL certificate is issued for (see cc-compute-single-gcp's HTTPS Load Balancer section)."
  type        = string
  default     = ""
}

variable "lb_enabled" {
  description = "true to front the instance with a global HTTPS Load Balancer + Google-managed SSL certificate (Phase 3) — the GCP equivalent of the AWS root's alb_enabled. Requires a non-empty `domain`. false (default) keeps the Phase 1/2 behavior: plain HTTP directly on the instance's public IP."
  type        = bool
  default     = false
}

variable "dns_managed_zone" {
  description = "Cloud DNS managed zone NAME to create/update the domain's A records in (bare domain + ws. subdomain, both pointed at the Load Balancer's global IP). Empty string (default) means Cloud DNS automation is off — either there's no domain, no lb_enabled, no matching zone was found, or the operator declined to let the wizard manage/overwrite an existing record. Set from state.infra.gcpDnsZoneName by the wizard's runGcpDnsStep, ONLY when state.infra.gcpDnsManaged is also true (see gcp-cloud.mjs's writeGcpTfvars) — mirrors the AWS root's dns_zone_id/dnsManaged gate exactly. Ignored entirely when lb_enabled=false."
  type        = string
  default     = ""
}

variable "machine_type" {
  description = "Compute Engine machine type for the app node."
  type        = string
  default     = "e2-standard-2"
}

variable "root_volume_size_gb" {
  type    = number
  default = 30
}

variable "db_tier" {
  description = "Cloud SQL machine tier (the GCP equivalent of an RDS instance class)."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_disk_size_gb" {
  type    = number
  default = 20
}

variable "db_skip_final_backup" {
  description = "See cc-database-gcp module — false (default) takes a final on-demand backup before the Cloud SQL instance is destroyed, mirroring the AWS root's db_skip_final_snapshot."
  type        = bool
  default     = false
}

variable "admin_ssh_source_ranges" {
  description = "CIDRs allowed to reach the instance on port 22 for the IAP TCP forwarding path. Defaults to Google's published IAP source range (35.235.240.0/20) — the only way to reach the instance over SSH is by tunneling through IAP with an authenticated gcloud/IAM identity (`gcloud compute ssh --tunnel-through-iap`), never a public Internet-facing port 22. See cc-network-gcp's firewall rule for the full rationale."
  type        = list(string)
  default     = ["35.235.240.0/20"]
}

variable "portainer_agent_enabled" {
  type    = bool
  default = false
}

variable "portainer_agent_port" {
  type    = number
  default = 9001
}

variable "portainer_server_cidrs" {
  type    = list(string)
  default = []
}
