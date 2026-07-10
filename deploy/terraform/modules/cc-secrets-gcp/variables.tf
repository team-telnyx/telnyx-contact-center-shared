variable "project_id" {
  type = string
}

variable "deployment_name" {
  type = string
}

variable "labels" {
  type    = map(string)
  default = {}
}
