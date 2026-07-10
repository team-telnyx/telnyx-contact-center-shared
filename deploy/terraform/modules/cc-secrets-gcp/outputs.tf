output "app_env_secret_name" {
  value = google_secret_manager_secret.app_env.name
}

output "app_env_secret_id" {
  value = google_secret_manager_secret.app_env.secret_id
}
