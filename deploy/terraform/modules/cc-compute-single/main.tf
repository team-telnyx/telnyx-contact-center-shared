locals {
  name_prefix = var.deployment_name
  common_tags = merge({
    Name       = var.deployment_name
    Deployment = var.deployment_name
    ManagedBy  = "terraform"
    Component  = "telnyx-contact-center"
  }, var.tags)
}

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
# IAM — instance role. SSM + CloudWatch managed policies (fleet ops) plus an
# inline policy scoped tightly to THIS deployment's own secrets/bucket
# prefixes. No ECR permissions anywhere (image delivery is the S3-tarball
# mechanism, see cloud-deploy.mjs) and no wildcard resource ARNs.
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
    # Deploy artifacts are read-only from the instance's perspective — the
    # image tarball is written by the operator's machine, never by the node.
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
# EC2 — single node. user_data prepares the machine (Docker, AWS CLI, zstd,
# SSM/CloudWatch agents, fetches the app/env secret to disk) but does NOT
# start the app container itself — that's triggered explicitly by
# cloud-deploy.mjs via SSM RunCommand once the first image tarball has been
# shipped to S3 (see deploy/cli/lib/cloud-deploy.mjs, task 4.5). This keeps
# "what actually runs on the box" fully driven by the same deploy mechanism
# used for every subsequent `cc update`, rather than having boot-time and
# update-time logic diverge.
# ===========================================================================

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
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
    Name = "${local.name_prefix}-app"
    Role = "app-node"
  })
}

data "aws_region" "current" {}

resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id
  tags     = merge(local.common_tags, { Name = "${local.name_prefix}-eip" })
}

# ===========================================================================
# Optional ALB — single node behind a load balancer (Route53-managed domain +
# ACM certificate path). Same shape as cc-compute-ha's ALB block, just with
# one target per group instead of `count = var.node_count`. Nothing here is
# created when alb_enabled=false.
# ===========================================================================

resource "aws_lb" "main" {
  count              = var.alb_enabled ? 1 : 0
  name               = "${local.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids_for_alb

  # SSE/long-poll: default 60s idle_timeout drops long-lived streams.
  idle_timeout = 300

  enable_deletion_protection = false
  tags                       = merge(local.common_tags, { Name = "${local.name_prefix}-alb" })
}

resource "aws_lb_target_group" "app" {
  count       = var.alb_enabled ? 1 : 0
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

  deregistration_delay = 30

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-tg-app" })
}

resource "aws_lb_target_group_attachment" "app" {
  count            = var.alb_enabled ? 1 : 0
  target_group_arn = aws_lb_target_group.app[0].arn
  target_id        = aws_instance.app.id
  port             = var.app_port
}

resource "aws_lb_target_group" "streaming_ws" {
  count       = var.alb_enabled ? 1 : 0
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

  deregistration_delay = 30

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-tg-ws" })
}

resource "aws_lb_target_group_attachment" "streaming_ws" {
  count            = var.alb_enabled ? 1 : 0
  target_group_arn = aws_lb_target_group.streaming_ws[0].arn
  target_id        = aws_instance.app.id
  port             = var.streaming_ws_port
}

resource "aws_lb_listener" "http" {
  count             = var.alb_enabled ? 1 : 0
  load_balancer_arn = aws_lb.main[0].arn
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
  count             = var.alb_enabled ? 1 : 0
  load_balancer_arn = aws_lb.main[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }
}

resource "aws_lb_listener_rule" "streaming_ws" {
  count        = var.alb_enabled ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.streaming_ws[0].arn
  }

  condition {
    host_header {
      values = [var.streaming_ws_domain_name]
    }
  }
}

# ===========================================================================
# Optional Route53 record — created in the SAME apply/destroy cycle as the
# ALB/EIP it points at, rather than out-of-band via the wizard's own AWS CLI
# calls (route53.mjs's old upsertARecord/upsertAliasRecord). That old
# approach meant `terraform destroy` had no idea this record existed —
# confirmed via a real cc-test3 teardown where the record was still live,
# pointing at now-destroyed infrastructure, after a full `cc destroy` run.
# Modeling it as a real resource here means create/update (this same
# aws_route53_record.app, UPSERT-like via allow_overwrite) AND delete (a
# plain `terraform destroy`) are both handled natively — no separate cleanup
# path to forget.
#
# allow_overwrite = true lets this resource silently take over a record that
# already exists in the zone (e.g. one created by an older wizard version's
# CLI-side upsert, or hand-created by the operator) instead of failing with
# "already exists" — Route53 has no notion of resource ownership the way
# tfstate does, so without this ANY pre-existing record at this exact name
# would block `terraform apply` outright. The wizard's own DNS step
# (runAwsDnsStep) already asks the operator for permission to
# create/overwrite before ever setting dns_zone_id in the first place —
# allow_overwrite here is what makes that consent actually take effect
# instead of erroring.
#
# count-gated on dns_zone_id (not alb_enabled) so this also covers the
# no-ALB single-node case (plain A record -> the instance's EIP).
# ===========================================================================

resource "aws_route53_record" "app" {
  count   = var.dns_zone_id != "" ? 1 : 0
  zone_id = var.dns_zone_id
  name    = var.domain
  type    = "A"

  dynamic "alias" {
    for_each = var.alb_enabled ? [1] : []
    content {
      name                   = aws_lb.main[0].dns_name
      zone_id                = aws_lb.main[0].zone_id
      evaluate_target_health = true
    }
  }

  ttl     = var.alb_enabled ? null : 300
  records = var.alb_enabled ? null : [aws_eip.app.public_ip]

  allow_overwrite = true
}
