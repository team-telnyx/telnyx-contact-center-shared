output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}

output "rds_security_group_id" {
  value = aws_security_group.rds.id
}

output "alb_security_group_id" {
  description = "Null when alb_enabled=false (no ALB — direct app-port access, no on-instance TLS)."
  value       = var.alb_enabled ? aws_security_group.alb[0].id : null
}
