variable "region" {
  description = "AWS region for this deployment."
  type        = string
}

variable "deployment_name" {
  description = "Deployment slug (e.g. \"cc-main\"), validated ^[a-z0-9][a-z0-9-]{1,30}$ by the wizard before this is written."
  type        = string
}

variable "domain" {
  description = "Public domain for the app (e.g. \"cc.example.com\"), or empty string for a nip.io fallback (demo-only)."
  type        = string
  default     = ""
}

variable "instance_type" {
  type    = string
  default = "t3a.medium"
}

variable "root_volume_size" {
  type    = number
  default = 30
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_skip_final_snapshot" {
  description = "See cc-database module — false (default) takes a final RDS snapshot on destroy."
  type        = bool
  default     = false
}

variable "admin_ssh_cidrs" {
  description = "Opt-in SSH access CIDRs (empty by default — SSM is the primary access path)."
  type        = list(string)
  default     = []
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

# ===========================================================================
# Optional ALB (Route53-managed domain + ACM certificate path — see plan's
# HTTPS-handling rewrite). alb_enabled=false (default) means the app node is
# reached directly with no on-instance TLS — Caddy/Let's Encrypt on the
# instance was removed entirely; either the deployment has no public domain
# (nip.io demo) or the domain is hosted outside Route53 and the operator's
# own DNS/reverse-proxy/CDN is responsible for HTTPS.
# ===========================================================================

variable "alb_enabled" {
  description = "Attach an ALB + target groups in front of the single node. Set by the wizard only when the user picked a Route53-managed domain and an ACM certificate to attach."
  type        = bool
  default     = false
}

variable "acm_certificate_arn" {
  description = "Required when alb_enabled=true — ISSUED ACM certificate ARN."
  type        = string
  default     = ""
}

variable "streaming_ws_domain_name" {
  description = "Required when alb_enabled=true — FQDN for the streaming WebSocket host-header routing rule."
  type        = string
  default     = ""
}

variable "dns_zone_id" {
  description = "Route53 hosted zone id for `domain`, resolved by the wizard's DNS step (runAwsDnsStep) — empty string (default) when the domain isn't managed in Route53 by Terraform (no domain, external DNS provider, or the operator declined to let the wizard manage/overwrite an existing record). See cc-compute-single's variables.tf for the full rationale."
  type        = string
  default     = ""
}
