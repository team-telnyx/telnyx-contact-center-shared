variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "deployment_name" {
  description = "Deployment slug used to name every resource (e.g. \"cc-main\"). Must match ^[a-z0-9][a-z0-9-]{1,30}$."
  type        = string
}

variable "subnet_cidr" {
  description = "CIDR block for this deployment's dedicated subnet. Each deployment gets its own VPC + subnet (no sharing with anything else in the project), mirroring the AWS root's one-VPC-per-deployment design."
  type        = string
  default     = "10.52.0.0/20"
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
  description = "CIDRs allowed to reach the instance on port 22. Defaults to Google's IAP TCP forwarding range only (35.235.240.0/20) — see cc-network-gcp's main.tf firewall rule comment."
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

variable "lb_enabled" {
  description = "true when the HTTPS Load Balancer (google_compute_managed_ssl_certificate + backend services, see cc-compute-single-gcp) is in front of the instance. Gates allow_app_ports below: with the LB in front, direct public access to the app ports is closed and only Google's Load Balancing / health-check source ranges are allowed through — the LB is the sole public entry point, mirroring the AWS root's alb_enabled gate on its equivalent security group rule."
  type        = bool
  default     = false
}

variable "labels" {
  description = "Extra labels merged onto every resource this module creates. GCP labels must be lowercase alphanumeric/dash/underscore — unlike AWS tags, uppercase values are rejected outright, so callers must pass already-lowercased values."
  type        = map(string)
  default     = {}
}
