variable "deployment_name" {
  description = "Deployment slug used to name/tag every resource (e.g. \"cc-main\"). Must match ^[a-z0-9][a-z0-9-]{1,30}$."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for this deployment's dedicated VPC. Each deployment gets its own VPC (no sharing with anything else on the user's AWS account)."
  type        = string
  default     = "10.42.0.0/16"
}

variable "azs" {
  description = "Availability zones to spread subnets across. Multi-node/HA needs >= 2 (ALB + RDS Multi-AZ); single-node only uses the first one."
  type        = list(string)
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs, one per AZ (EC2 nodes + ALB when present)."
  type        = list(string)
  default     = ["10.42.1.0/24", "10.42.2.0/24"]
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDRs, one per AZ (RDS only). No NAT gateway is created by default (see enable_nat) — private subnets don't need outbound internet for RDS."
  type        = list(string)
  default     = ["10.42.11.0/24", "10.42.12.0/24"]
}

variable "enable_nat" {
  description = "Create a NAT Gateway + EIP for the private subnets. Off by default: RDS doesn't need outbound internet, and SSM/S3/Secrets Manager reach the app nodes via public subnets + IAM, not NAT. Turn on only if you add something to the private subnets that needs outbound internet."
  type        = bool
  default     = false
}

variable "app_port" {
  description = "Application HTTP port (Next.js)."
  type        = number
  default     = 3000
}

variable "streaming_ws_port" {
  description = "Streaming WebSocket sidecar port."
  type        = number
  default     = 3001
}

variable "alb_enabled" {
  description = "Whether an ALB (+ its security group) fronts the app node(s). Always true for \"ha\" topology (ALB is mandatory there). For \"single\" topology, true only when the wizard's Route53+ACM flow resolved a certificate to attach to a load balancer — false means the app node is reached directly (no TLS on the instance; the operator's own DNS/reverse-proxy/CDN is responsible for HTTPS, see plan's HTTPS-handling rewrite)."
  type        = bool
}

variable "topology" {
  description = "\"single\" or \"ha\". Kept for tagging/labeling only — ALB presence is now driven entirely by alb_enabled, not derived from topology (a single-node deployment can also get an ALB when the user picks a Route53-managed domain + ACM certificate)."
  type        = string
  validation {
    condition     = contains(["single", "ha"], var.topology)
    error_message = "topology must be \"single\" or \"ha\"."
  }
}

variable "admin_ssh_cidrs" {
  description = "CIDRs allowed to SSH (port 22) into app nodes. Auto-resolved by the wizard (deploy/cli/lib/aws-instance-connect-cidrs.mjs) to AWS's own EC2 Instance Connect IP range for the target region, so the EC2 console's browser 'Connect' button works without exposing port 22 to the public internet. Empty list disables the ingress rule entirely (SSM remains the access path either way)."
  type        = list(string)
  default     = []
}

variable "portainer_agent_enabled" {
  description = "Whether the Portainer agent container will run on app nodes (see cc-compute-single/cc-compute-ha). When true and portainer_server_cidrs is non-empty, opens the agent port to exactly those CIDRs."
  type        = bool
  default     = false
}

variable "portainer_agent_port" {
  type    = number
  default = 9001
}

variable "portainer_server_cidrs" {
  description = "CIDRs of the user's own existing Portainer server allowed to reach the agent port. Empty by default (agent port stays closed; user connects via VPN/peering or adds this later)."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Extra tags merged onto every resource this module creates. Deployment-name-derived, not the internal FDE Owner/CostCenter convention."
  type        = map(string)
  default     = {}
}
