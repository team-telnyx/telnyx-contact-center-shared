output "db_private_ip" {
  value = google_sql_database_instance.main.private_ip_address
}

output "db_instance_name" {
  value = google_sql_database_instance.main.name
}

output "db_connection_name" {
  description = "Cloud SQL's <project>:<region>:<instance> connection name — not used by the app directly (it connects over the private IP), but useful for `gcloud sql connect`/Cloud SQL Auth Proxy debugging."
  value       = google_sql_database_instance.main.connection_name
}

output "db_secret_id" {
  value = google_secret_manager_secret.db.secret_id
}

output "db_secret_name" {
  description = "Fully-qualified Secret Manager resource name (projects/.../secrets/...) — the GCP equivalent of the AWS root's db_secret_arn, in the shape `gcloud secrets versions access` and the app node's IAM binding both expect."
  value       = google_secret_manager_secret.db.name
}
