output "public_ip" {
  value = module.compute.public_ip
}

output "app_url" {
  value = var.domain != "" ? "https://${var.domain}" : "https://${module.compute.public_ip}.nip.io"
}

output "alb_dns_name" {
  description = "Null when alb_enabled=false."
  value       = module.compute.alb_dns_name
}

output "alb_zone_id" {
  description = "Null when alb_enabled=false."
  value       = module.compute.alb_zone_id
}

output "app_target_group_arn" {
  description = "Null when alb_enabled=false."
  value       = module.compute.app_target_group_arn
}

output "streaming_ws_target_group_arn" {
  description = "Null when alb_enabled=false."
  value       = module.compute.streaming_ws_target_group_arn
}

output "instance_id" {
  value = module.compute.instance_id
}

output "db_secret_name" {
  value = module.database.db_secret_arn
}

output "app_env_secret_name" {
  value = module.secrets.app_env_secret_name
}

output "storage_bucket" {
  value = module.storage.bucket_name
}

output "db_endpoint" {
  value = module.database.db_endpoint
}
