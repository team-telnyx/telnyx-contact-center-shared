variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "deployment_name" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
