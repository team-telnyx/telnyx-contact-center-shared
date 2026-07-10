output "instance_name" {
  value = google_compute_instance.app.name
}

output "instance_id" {
  value = google_compute_instance.app.instance_id
}

output "public_ip" {
  value = google_compute_instance.app.network_interface[0].access_config[0].nat_ip
}

output "service_account_email" {
  value = google_service_account.app.email
}

output "lb_ip" {
  description = "Global static IP of the HTTPS Load Balancer's forwarding rules. Null when lb_enabled=false. This is the address the operator must point the domain's DNS A record at for the managed certificate to validate."
  value       = var.lb_enabled ? google_compute_global_address.lb[0].address : null
}

output "cert_name" {
  description = "Name of the google_compute_managed_ssl_certificate resource, for status polling (gcloud compute ssl-certificates describe). Null when lb_enabled=false."
  value       = var.lb_enabled ? google_compute_managed_ssl_certificate.app[0].name : null
}
