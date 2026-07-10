output "public_ip" {
  value = module.compute.public_ip
}

output "app_url" {
  # With the HTTPS Load Balancer (lb_enabled=true), the app is reached at
  # https://<domain> — the LB terminates TLS with the Google-managed cert
  # and the instance itself is no longer directly reachable (see
  # cc-network-gcp's allow_app_ports count-gate). Without it (Phase 1/2
  # default), plain http:// either way, matching the AWS root's no-ALB
  # fallback shape.
  value = var.lb_enabled ? "https://${var.domain}" : (var.domain != "" ? "http://${var.domain}" : "http://${module.compute.public_ip}.nip.io")
}

output "lb_ip" {
  description = "Global static IP of the HTTPS Load Balancer. Null when lb_enabled=false. Point the domain's DNS A record here for the managed certificate to validate."
  value       = module.compute.lb_ip
}

output "cert_name" {
  description = "Name of the Google-managed SSL certificate resource, for status polling. Null when lb_enabled=false."
  value       = module.compute.cert_name
}

output "instance_name" {
  value = module.compute.instance_name
}

output "instance_id" {
  value = module.compute.instance_id
}

output "db_secret_name" {
  value = module.database.db_secret_name
}

output "db_private_ip" {
  value = module.database.db_private_ip
}

output "app_env_secret_name" {
  value = module.secrets.app_env_secret_name
}

output "storage_bucket" {
  value = module.storage.bucket_name
}

output "storage_hmac_secret_name" {
  value = module.storage.storage_hmac_secret_name
}
