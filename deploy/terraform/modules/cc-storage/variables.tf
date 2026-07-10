variable "deployment_name" {
  type = string
}

variable "domain" {
  description = "The deployment's public domain (for S3 CORS allowed_origins). Empty string is valid for domain-less local/nip.io setups (CORS falls back to no cross-origin allowance beyond same-origin)."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
