output "alb_dns_name" {
  value = module.compute.alb_dns_name
}

output "alb_zone_id" {
  value = module.compute.alb_zone_id
}

output "app_url" {
  value = "https://${var.domain}"
}

output "instance_ids" {
  value = module.compute.instance_ids
}

output "app_target_group_arn" {
  value = module.compute.app_target_group_arn
}

output "streaming_ws_target_group_arn" {
  value = module.compute.streaming_ws_target_group_arn
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
