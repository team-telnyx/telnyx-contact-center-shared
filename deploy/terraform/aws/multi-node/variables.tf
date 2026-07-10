variable "region" {
  type = string
}

variable "deployment_name" {
  type = string
}

variable "domain" {
  description = "Public domain for the app (REQUIRED for multi-node/HA — see plan §4c, ALB+ACM always needs a real domain)."
  type        = string
  validation {
    condition     = var.domain != ""
    error_message = "Multi-node/HA deployments require a real domain (ALB+ACM TLS termination has no domain-less fallback)."
  }
}

variable "streaming_ws_domain_name" {
  description = "FQDN for the Streaming WebSocket sidecar, e.g. ws.<domain>. Must be covered by the same ACM certificate (as a SAN) and point at the ALB via Route53/your DNS provider."
  type        = string
}

variable "dns_zone_id" {
  description = "Route53 hosted zone id for `domain`, resolved by the wizard's DNS step (runAwsDnsStep) — empty string (default) when the domain isn't managed in Route53 by Terraform (external DNS provider, or the operator declined to let the wizard manage/overwrite an existing record). See cc-compute-ha's variables.tf for the full rationale."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ARN of an ISSUED ACM certificate covering both `domain` and `streaming_ws_domain_name` (see deploy/cli/lib/acm.mjs — resolved by the wizard BEFORE this root is applied, per plan §4c/§4d)."
  type        = string
}

variable "node_count" {
  type    = number
  default = 2
}

variable "instance_type" {
  type    = string
  default = "m6a.large"
}

variable "root_volume_size" {
  type    = number
  default = 30
}

variable "db_instance_class" {
  type    = string
  default = "db.t3.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_skip_final_snapshot" {
  type    = bool
  default = false
}

variable "admin_ssh_cidrs" {
  type    = list(string)
  default = []
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
