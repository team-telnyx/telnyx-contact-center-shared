variable "deployment_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_id" {
  description = "Public subnet the instance lives in."
  type        = string
}

variable "public_subnet_ids_for_alb" {
  description = "Required when alb_enabled=true — ALB needs subnets in >= 2 AZs (AWS API requirement), even though the instance itself only lives in one of them."
  type        = list(string)
  default     = []
}

variable "app_security_group_id" {
  type = string
}

variable "instance_type" {
  type    = string
  default = "t3a.medium"
}

variable "root_volume_size" {
  type    = number
  default = 30
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH. Empty by default — SSM is the primary access path; only set this if the user opted into SSH during the wizard's cloud-params step (paired with a non-empty admin_ssh_cidrs on the network module)."
  type        = string
  default     = ""
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "streaming_ws_port" {
  type    = number
  default = 3001
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
# Optional ALB (single-node + Route53-managed domain + ACM certificate path).
# Mirrors cc-compute-ha's ALB block but fronts exactly one instance. When
# alb_enabled=false (default — no domain, or an externally-hosted domain),
# none of these resources are created and the app node is reached directly
# on app_port/streaming_ws_port with no TLS termination on the instance.
# ===========================================================================

variable "alb_enabled" {
  description = "Attach an ALB + target groups in front of this single node. True only when the wizard resolved a Route53-managed domain with an ACM certificate to attach."
  type        = bool
  default     = false
}

variable "alb_security_group_id" {
  description = "Required when alb_enabled=true (from cc-network's alb_security_group_id output)."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "Required when alb_enabled=true — ISSUED ACM certificate ARN for the deployment's domain."
  type        = string
  default     = ""
}

variable "streaming_ws_domain_name" {
  description = "Required when alb_enabled=true — FQDN for the streaming WebSocket host-header routing rule (e.g. ws.<domain>)."
  type        = string
  default     = ""
}

# ===========================================================================
# Optional Route53 DNS record — see main.tf's aws_route53_record.app for why
# this lives here (in the same module/apply as the ALB/EIP it points at)
# rather than being created out-of-band by the wizard's own AWS CLI calls.
# ===========================================================================

variable "domain" {
  description = "Public domain for the app (e.g. \"cc.example.com\"). Required (non-empty) only when dns_zone_id is also set — used as the record name. Empty string is valid (nip.io/no-domain path), matching the root module's own `domain` variable."
  type        = string
  default     = ""
}

variable "dns_zone_id" {
  description = "Route53 hosted zone id to create/update the domain's A (no ALB) or alias (ALB) record in. Empty string (default) means this deployment's domain is NOT managed in Route53 by Terraform — either there's no domain, the domain lives with an external DNS provider, or the wizard's DNS step (runAwsDnsStep) found an existing record here and the operator declined to let the wizard manage/overwrite it. Set from state.infra.dnsZoneId, but ONLY when state.infra.dnsManaged is also true (see aws-cloud.mjs's writeAwsTfvars) — dnsZoneId alone is not sufficient consent to manage the record."
  type        = string
  default     = ""
}
