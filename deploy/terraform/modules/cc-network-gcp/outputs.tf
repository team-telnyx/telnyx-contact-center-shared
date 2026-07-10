output "vpc_id" {
  value = google_compute_network.main.id
}

output "vpc_self_link" {
  value = google_compute_network.main.self_link
}

output "subnet_id" {
  value = google_compute_subnetwork.main.id
}

output "subnet_self_link" {
  value = google_compute_subnetwork.main.self_link
}

output "network_tag" {
  description = "Instance network tag the firewall rules target — pass this to the compute module's instance so the rules actually apply to it."
  value       = "${local.name_prefix}-app"
}

output "private_vpc_connection" {
  description = "The google_service_networking_connection resource, exposed so the database module can depend_on it (Cloud SQL private-IP instances fail to create if the peering isn't established yet)."
  value       = google_service_networking_connection.private_services
}
