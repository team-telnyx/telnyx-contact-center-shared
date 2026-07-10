variable "project_id" {
  type = string
}

variable "deployment_name" {
  type = string
}

variable "location" {
  description = "GCS bucket location — a region (e.g. \"us-central1\") or multi-region (e.g. \"US\"). Defaults to the same value as the compute region for locality; pass a multi-region string here explicitly if you want cross-region redundancy instead."
  type        = string
}

variable "domain" {
  description = "The deployment's public domain (for bucket CORS allowed_origins). Empty string is valid for domain-less setups (CORS falls back to no cross-origin allowance beyond same-origin) — mirrors the AWS root's cc-storage module."
  type        = string
  default     = ""
}

variable "labels" {
  type    = map(string)
  default = {}
}
