variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "zone" {
  type = string
}

variable "deployment_name" {
  type = string
}

variable "vpc_self_link" {
  type = string
}

variable "subnet_self_link" {
  type = string
}

variable "network_tag" {
  description = "Instance network tag matching cc-network-gcp's firewall rules (its network_tag output)."
  type        = string
}

variable "machine_type" {
  type    = string
  default = "e2-standard-2"
}

variable "root_volume_size_gb" {
  type    = number
  default = 30
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "streaming_ws_port" {
  type    = number
  default = 3001
}

variable "db_secret_name" {
  description = "Fully-qualified Secret Manager resource name for the DB credentials secret (cc-database-gcp's db_secret_name output)."
  type        = string
}

variable "app_env_secret_name" {
  description = "Fully-qualified Secret Manager resource name for the app/env secret (cc-secrets-gcp's app_env_secret_name output)."
  type        = string
}

variable "storage_hmac_secret_name" {
  description = "Fully-qualified Secret Manager resource name for the storage HMAC key secret (cc-storage-gcp's storage_hmac_secret_name output)."
  type        = string
}

variable "storage_bucket_name" {
  type = string
}

variable "portainer_agent_enabled" {
  type    = bool
  default = false
}

variable "portainer_agent_port" {
  type    = number
  default = 9001
}

variable "lb_enabled" {
  description = "true to front the instance with a global HTTPS Load Balancer + Google-managed SSL certificate (Phase 3) instead of plain HTTP directly on the instance's public IP (Phase 1/2 default). Requires `domain` to be non-empty (the managed cert is issued for that exact hostname)."
  type        = bool
  default     = false
}

variable "domain" {
  description = "Public domain the managed SSL certificate covers (e.g. \"cc.example.com\"). Required when lb_enabled=true; ignored otherwise."
  type        = string
  default     = ""
}

# ===========================================================================
# Optional Cloud DNS record — created in the SAME apply/destroy cycle as the
# Load Balancer it points at, rather than out-of-band via the wizard's own
# gcloud CLI calls. Mirrors the AWS root's aws_route53_record.app exactly
# (see cc-compute-single/main.tf's header for the full rationale): modeling
# the record as a real Terraform resource means create/update AND delete are
# both handled natively by `terraform apply`/`terraform destroy` — no
# separate out-of-band cleanup path to forget or leave a dangling record
# pointing at now-destroyed infrastructure.
# ===========================================================================

variable "dns_managed_zone" {
  description = "Cloud DNS managed zone NAME (not dnsName/domain suffix — the zone resource name, e.g. \"cc-example-zone\") to create/update the domain's A records in. Empty string (default) means this deployment's domain is NOT managed in Cloud DNS by Terraform — either there's no domain, the domain lives with an external DNS provider, or the wizard's DNS step (runGcpDnsStep) found an existing record here and the operator declined to let the wizard manage/overwrite it. Set from state.infra.gcpDnsZoneName, but ONLY when state.infra.gcpDnsManaged is also true (see gcp-cloud.mjs's writeGcpTfvars) — zone name alone is not sufficient consent to manage the record. Ignored when lb_enabled=false (there is no stable Load Balancer IP to point a Terraform-managed record at without it)."
  type        = string
  default     = ""
}

variable "labels" {
  type    = map(string)
  default = {}
}
