locals {
  name_prefix = var.deployment_name
  common_tags = merge({
    Name       = var.deployment_name
    Deployment = var.deployment_name
    ManagedBy  = "terraform"
    Component  = "telnyx-contact-center"
  }, var.tags)
}

data "aws_region" "current" {}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

# ===========================================================================
# IAM — instance role, same shape as cc-compute-single plus ALB
# register/deregister/describe-health scoped to THIS deployment's own target
# groups (needed for the rolling-deploy drain/re-register algorithm in
# cloud-deploy.mjs — see plan §4a). Still no ECR permissions anywhere.
# ===========================================================================

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name_prefix}-app-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = merge(local.common_tags, { Name = "${local.name_prefix}-app-role" })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "cw_agent" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

data "aws_iam_policy_document" "app_inline" {
  statement {
    sid       = "ReadDbSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.db_secret_arn]
  }
  statement {
    sid       = "ReadAppEnvSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.app_env_secret_arn]
  }
  statement {
    sid     = "S3MediaAndLogsObjects"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [
      "${var.storage_bucket_arn}/media/*",
      "${var.storage_bucket_arn}/logs/*",
    ]
  }
  statement {
    sid       = "S3DeployArtifactsReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${var.storage_bucket_arn}/deploy-artifacts/*"]
  }
  statement {
    sid       = "S3ListBucketScopedToOwnPrefixes"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [var.storage_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["media/*", "logs/*", "deploy-artifacts/*"]
    }
  }
  statement {
    sid       = "AlbDescribeTargetHealth"
    actions   = ["elasticloadbalancing:DescribeTargetHealth"]
    resources = ["*"] # DescribeTargetHealth has no resource-level scoping in IAM
  }
  statement {
    sid     = "AlbRollingDeployTargetRegistration"
    actions = ["elasticloadbalancing:DeregisterTargets", "elasticloadbalancing:RegisterTargets"]
    resources = [
      aws_lb_target_group.app.arn,
      aws_lb_target_group.streaming_ws.arn,
    ]
  }
}

resource "aws_iam_role_policy" "app_inline" {
  name   = "${local.name_prefix}-app-inline"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app_inline.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name_prefix}-app-profile"
  role = aws_iam_role.app.name
}

# ===========================================================================
# EC2 — N app nodes, spread across the public subnets passed in (no EIP per
# node — the ALB is the single public entry point; nodes still get an
# auto-assigned public IP from the subnet's map_public_ip_on_launch=true for
# outbound SSM/S3/Secrets Manager/apt reachability).
# ===========================================================================

resource "aws_instance" "app" {
  count                       = var.node_count
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = var.public_subnet_ids[count.index % length(var.public_subnet_ids)]
  vpc_security_group_ids      = [var.app_security_group_id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  key_name                    = var.key_name != "" ? var.key_name : null
  user_data_replace_on_change = true

  user_data = base64encode(templatefile("${path.module}/templates/user_data.sh.tpl", {
    region                  = data.aws_region.current.name
    app_port                = var.app_port
    streaming_ws_port       = var.streaming_ws_port
    app_env_secret          = var.app_env_secret_arn
    db_secret               = var.db_secret_arn
    storage_bucket          = var.storage_bucket_name
    storage_region          = data.aws_region.current.name
    node_index              = count.index
    portainer_agent_enabled = var.portainer_agent_enabled
    portainer_agent_port    = var.portainer_agent_port
  }))

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  lifecycle {
    ignore_changes = [
      key_name,
      user_data,
      user_data_base64,
    ]
  }

  depends_on = [
    aws_iam_role_policy.app_inline,
    aws_iam_role_policy_attachment.ssm,
    aws_iam_role_policy_attachment.cw_agent,
  ]

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-app-${count.index}"
    Role = "app-node"
  })
}

# ===========================================================================
# ALB — HTTPS, SSE/WebSocket-aware (long idle_timeout), two target groups
# (app + streaming-ws), TLS via the ACM cert the wizard/acm.mjs resolved
# before this module is applied (see plan §4c/§4d — Telnyx bootstrap and ACM
# validation run before provisioning for cloud targets).
# ===========================================================================

resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids

  # SSE/long-poll: default 60s idle_timeout drops long-lived streams.
  idle_timeout = 300

  enable_deletion_protection = false
  tags                       = merge(local.common_tags, { Name = "${local.name_prefix}-alb" })
}

resource "aws_lb_target_group" "app" {
  name        = "${local.name_prefix}-tg-app"
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  health_check {
    enabled             = true
    path                = "/api/health"
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Stickiness OFF: SSE fan-out isn't guaranteed cross-node yet (see the CC HA
  # status audit — lib/sse.js is still process-local), but keeping ALB
  # cookies OFF avoids a worse failure mode: a browser pinned to a target
  # being recreated during a rolling deploy would otherwise see 502s.
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 3600
    enabled         = false
  }

  deregistration_delay = 30

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-tg-app" })
}

resource "aws_lb_target_group_attachment" "app" {
  count            = var.node_count
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app[count.index].id
  port             = var.app_port
}

resource "aws_lb_target_group" "streaming_ws" {
  name        = "${local.name_prefix}-tg-ws"
  port        = var.streaming_ws_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  health_check {
    enabled             = true
    path                = "/api/health"
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  stickiness {
    type            = "lb_cookie"
    cookie_duration = 3600
    enabled         = false
  }

  deregistration_delay = 30

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-tg-ws" })
}

resource "aws_lb_target_group_attachment" "streaming_ws" {
  count            = var.node_count
  target_group_arn = aws_lb_target_group.streaming_ws.arn
  target_id        = aws_instance.app[count.index].id
  port             = var.streaming_ws_port
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# Streaming WebSocket sidecar routed by a dedicated host header (the app's
# NEXT_PUBLIC_STREAMING_PORT convention needs its own hostname since it's a
# separate port/protocol upgrade target, not a path on the same host).
resource "aws_lb_listener_rule" "streaming_ws" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.streaming_ws.arn
  }

  condition {
    host_header {
      values = [var.streaming_ws_domain_name]
    }
  }
}

# ===========================================================================
# Optional Route53 record — see cc-compute-single's main.tf for the full
# rationale. HA is always ALB-fronted, so always an alias record. Same
# allow_overwrite = true reasoning applies (takes over any pre-existing
# record at this name instead of failing "already exists").
# ===========================================================================

resource "aws_route53_record" "app" {
  count   = var.dns_zone_id != "" ? 1 : 0
  zone_id = var.dns_zone_id
  name    = var.domain
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }

  allow_overwrite = true
}
