output "app_env_secret_arn" {
  value = aws_secretsmanager_secret.app_env.arn
}

output "app_env_secret_name" {
  value = aws_secretsmanager_secret.app_env.name
}
