variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "deployment_name" {
  description = "Deployment slug used to name every resource (e.g. \"cc-main\"). Must match ^[a-z0-9][a-z0-9-]{1,30}$."
  type        = string
}

variable "vnet_cidr" {
  description = "CIDR block for this deployment's dedicated VNet. Each deployment gets its own VNet + subnet (no sharing with anything else in the resource group), mirroring the AWS/GCP roots' one-network-per-deployment design."
  type        = string
  default     = "10.60.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for the app subnet, must fall inside vnet_cidr."
  type        = string
  default     = "10.60.0.0/20"
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "streaming_ws_port" {
  type    = number
  default = 3001
}

variable "admin_ssh_source_ranges" {
  description = "CIDRs allowed to reach the instance on port 22. Unlike AWS's EC2 Instance Connect or GCP's IAP tunnel, Azure has no equivalent published always-on proxy CIDR — the wizard's own resolved admin IP (see aws-instance-connect-cidrs.mjs's pattern, reused here) is passed in directly. Defaults to empty (no SSH ingress) because the wizard's primary remote-exec path is `az vm run-command invoke`, which needs no open port 22 at all — same \"no SSH keys, ever\" posture as the AWS/GCP roots' SSM/IAP paths. Only populate this if an operator explicitly wants direct SSH as a fallback."
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

variable "lb_enabled" {
  description = "true when the Application Gateway (see cc-compute-single-azure) is in front of the instance. Gates the direct-app-port NSG rule below: with the gateway in front, direct public access to the app ports is closed and only Azure's Application Gateway subnet/health-probe traffic is allowed through — mirrors the AWS root's alb_enabled gate and the GCP root's lb_enabled gate on their equivalent security rules."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Extra tags merged onto every resource this module creates."
  type        = map(string)
  default     = {}
}
