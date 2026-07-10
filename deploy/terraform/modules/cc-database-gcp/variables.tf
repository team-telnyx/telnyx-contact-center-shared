variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "deployment_name" {
  type = string
}

variable "vpc_id" {
  description = "Self-link or id of the VPC to peer Cloud SQL's private IP into (cc-network-gcp's vpc_self_link output)."
  type        = string
}

variable "db_tier" {
  type    = string
  default = "db-custom-1-3840"
}

variable "db_version" {
  type    = string
  default = "POSTGRES_17"
}

variable "db_disk_size_gb" {
  type    = number
  default = 20
}

variable "db_name" {
  type    = string
  default = "contact_center"
}

variable "db_username" {
  type    = string
  default = "contact_center"
}

variable "db_availability_type" {
  description = "\"ZONAL\" (default, single-node/Small/Medium) or \"REGIONAL\" (HA failover, Large sizing) — the Cloud SQL equivalent of RDS's multi_az."
  type        = string
  default     = "ZONAL"
}

variable "backup_retention_days" {
  type    = number
  default = 3
}

variable "skip_final_backup" {
  description = "false (default) = take an on-demand final backup right before the Cloud SQL instance is destroyed (a destroy-time provisioner, since Cloud SQL — unlike RDS — has no built-in final-snapshot-on-delete option). Set true only for throwaway/test deployments where losing the DB on destroy is acceptable."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Terraform-level (and, when true, GCP API-level) delete protection on the instance. false by default to match the AWS root's deletion_protection=false (cc destroy is expected to actually delete the instance)."
  type        = bool
  default     = false
}

variable "labels" {
  type    = map(string)
  default = {}
}
