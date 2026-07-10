variable "deployment_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  description = "Public subnets for both the ALB and the app nodes (nodes don't need their own EIP behind an ALB)."
  type        = list(string)
}

variable "app_security_group_id" {
  type = string
}

variable "alb_security_group_id" {
  type = string
}

variable "node_count" {
  description = "Number of app nodes. HA topology requires >= 2."
  type        = number
  default     = 2
  validation {
    condition     = var.node_count >= 2
    error_message = "cc-compute-ha requires node_count >= 2 (single-node deployments should use cc-compute-single instead)."
  }
}

variable "instance_type" {
  type    = string
  default = "m6a.large"
}

variable "root_volume_size" {
  type    = number
  default = 30
}

variable "key_name" {
  type    = string
  default = ""
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "streaming_ws_port" {
  type    = number
  default = 3001
}

variable "acm_certificate_arn" {
  description = "ARN of an ISSUED ACM certificate for the deployment's domain (see deploy/cli/lib/acm.mjs / plan §4c). Required — HA always needs a real domain."
  type        = string
}

variable "streaming_ws_domain_name" {
  description = "FQDN for the Streaming WebSocket sidecar (e.g. ws.<domain>), routed by ALB host-header rule to the streaming_ws target group. Must be covered by acm_certificate_arn (SAN or wildcard) and pointed at the ALB's DNS name by the caller (see aws/multi-node root's Route53 wiring)."
  type        = string
}

variable "db_secret_arn" {
  type = string
}

variable "app_env_secret_arn" {
  type = string
}

variable "storage_bucket_arn" {
  type = string
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

variable "tags" {
  type    = map(string)
  default = {}
}

# ===========================================================================
# Optional Route53 record — see cc-compute-single's main.tf for the full
# rationale (same pattern, mirrored here for HA). HA is always ALB-fronted,
# so this is always an alias record — there's no A-record-to-EIP variant
# here the way single-node has for its no-ALB case.
# ===========================================================================

variable "domain" {
  description = "Public domain for the app (REQUIRED — mirrors the root module's own mandatory `domain` variable; HA always needs a real domain for its ACM cert)."
  type        = string
}

variable "dns_zone_id" {
  description = "Route53 hosted zone id to create/update the domain's alias record in. Empty string (default) means this deployment's domain is NOT managed in Route53 by Terraform — the domain lives with an external DNS provider, or the operator declined to let the wizard manage/overwrite an existing record. Set from state.infra.dnsZoneId, but ONLY when state.infra.dnsManaged is also true (see aws-cloud.mjs's writeAwsTfvars)."
  type        = string
  default     = ""
}
