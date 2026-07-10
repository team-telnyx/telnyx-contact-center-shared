output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = aws_eip.app.public_ip
}

output "iam_role_arn" {
  value = aws_iam_role.app.arn
}

output "alb_dns_name" {
  description = "Null when alb_enabled=false."
  value       = var.alb_enabled ? aws_lb.main[0].dns_name : null
}

output "alb_zone_id" {
  description = "ALB's own Route53 hosted zone id (needed for an ALIAS record) — null when alb_enabled=false."
  value       = var.alb_enabled ? aws_lb.main[0].zone_id : null
}

output "app_target_group_arn" {
  description = "Null when alb_enabled=false."
  value       = var.alb_enabled ? aws_lb_target_group.app[0].arn : null
}

output "streaming_ws_target_group_arn" {
  description = "Null when alb_enabled=false."
  value       = var.alb_enabled ? aws_lb_target_group.streaming_ws[0].arn : null
}
