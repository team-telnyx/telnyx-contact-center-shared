output "instance_ids" {
  value = aws_instance.app[*].id
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "alb_zone_id" {
  value = aws_lb.main.zone_id
}

output "app_target_group_arn" {
  value = aws_lb_target_group.app.arn
}

output "streaming_ws_target_group_arn" {
  value = aws_lb_target_group.streaming_ws.arn
}

output "iam_role_arn" {
  value = aws_iam_role.app.arn
}
