variable "deployment_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "rds_security_group_id" {
  type = string
}

variable "db_engine_version" {
  type    = string
  default = "17.10"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
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

variable "db_multi_az" {
  description = "Multi-AZ failover. true for Large/HA sizing, false for Small/Medium single-node."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  type    = number
  default = 3
}

variable "skip_final_snapshot" {
  description = "false (default) = take a final snapshot on destroy (no-DROP safety net — costs a small amount of storage until manually deleted). Set true only for throwaway/test deployments where losing the DB on destroy is acceptable."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
