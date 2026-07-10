output "bucket_name" {
  value = google_storage_bucket.main.name
}

output "bucket_url" {
  value = google_storage_bucket.main.url
}

output "storage_hmac_secret_name" {
  description = "Fully-qualified Secret Manager resource name holding { access_id, secret } for the bucket's HMAC key — the app node reads this at boot to populate STORAGE_ACCESS_KEY/STORAGE_SECRET_KEY."
  value       = google_secret_manager_secret.storage_hmac.name
}

output "storage_hmac_secret_id" {
  value = google_secret_manager_secret.storage_hmac.secret_id
}
