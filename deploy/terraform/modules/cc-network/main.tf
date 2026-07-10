locals {
  name_prefix = var.deployment_name
  common_tags = merge({
    Name       = var.deployment_name
    Deployment = var.deployment_name
    ManagedBy  = "terraform"
    Component  = "telnyx-contact-center"
  }, var.tags)
}

# ===========================================================================
# VPC — one dedicated VPC per deployment, no sharing with anything else on
# the user's AWS account.
# ===========================================================================

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-vpc" })
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.common_tags, { Name = "${local.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-public-${var.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.azs[count.index]

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-private-${var.azs[count.index]}"
    Tier = "private"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
  tags = merge(local.common_tags, { Name = "${local.name_prefix}-rt-public" })
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# NAT is off by default (see variables.tf) — RDS in private subnets doesn't
# need outbound internet, and app nodes live in public subnets reaching
# SSM/S3/Secrets Manager directly via IAM + public endpoints.
resource "aws_eip" "nat" {
  count  = var.enable_nat ? 1 : 0
  domain = "vpc"
  tags   = merge(local.common_tags, { Name = "${local.name_prefix}-nat-eip" })
}

resource "aws_nat_gateway" "nat" {
  count         = var.enable_nat ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = merge(local.common_tags, { Name = "${local.name_prefix}-nat" })
  depends_on    = [aws_internet_gateway.igw]
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  dynamic "route" {
    for_each = var.enable_nat ? [1] : []
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = aws_nat_gateway.nat[0].id
    }
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-rt-private" })
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ===========================================================================
# SECURITY GROUPS
# ===========================================================================

# ALB SG only exists when alb_enabled=true — "ha" topology always sets this;
# "single" topology sets it only when the wizard resolved a Route53-managed
# domain + ACM certificate for this deployment (see plan's HTTPS rewrite).
# When alb_enabled=false, there is NO on-instance TLS termination anymore —
# Caddy/Let's-Encrypt-on-the-app-node was removed. The app node is reached
# either over plain HTTP directly (only sensible for demos/nip.io) or the
# operator's own external DNS+reverse-proxy/CDN handles HTTPS in front of it.
resource "aws_security_group" "alb" {
  count       = var.alb_enabled ? 1 : 0
  name        = "${local.name_prefix}-alb-sg"
  description = "ALB ingress 80/443 from the internet"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(local.common_tags, { Name = "${local.name_prefix}-alb-sg" })
}

# App nodes. With an ALB in front (alb_enabled=true, either topology): only
# the ALB SG can reach app_port/streaming_ws_port — nothing else is open on
# 80/443/the app ports directly. Without an ALB (alb_enabled=false,
# single-node without a Route53+ACM domain): the app ports themselves are
# opened directly to the internet as plain HTTP — there is no on-instance
# TLS termination (Caddy was removed; see module header). This is the
# no-ALB / external-DNS path: the operator's own reverse proxy or CDN is
# responsible for HTTPS if they need it.
resource "aws_security_group" "app" {
  name        = "${local.name_prefix}-app-sg"
  description = "App node ingress; egress unrestricted"
  vpc_id      = aws_vpc.main.id

  dynamic "ingress" {
    for_each = !var.alb_enabled ? [1] : []
    content {
      description = "App HTTP port, direct (no ALB/TLS in front)"
      from_port   = var.app_port
      to_port     = var.app_port
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
  dynamic "ingress" {
    for_each = !var.alb_enabled ? [1] : []
    content {
      description = "Streaming WebSocket port, direct (no ALB/TLS in front)"
      from_port   = var.streaming_ws_port
      to_port     = var.streaming_ws_port
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
  dynamic "ingress" {
    for_each = var.alb_enabled ? [1] : []
    content {
      description     = "App port from ALB"
      from_port       = var.app_port
      to_port         = var.app_port
      protocol        = "tcp"
      security_groups = [aws_security_group.alb[0].id]
    }
  }
  dynamic "ingress" {
    for_each = var.alb_enabled ? [1] : []
    content {
      description     = "Streaming WebSocket port from ALB"
      from_port       = var.streaming_ws_port
      to_port         = var.streaming_ws_port
      protocol        = "tcp"
      security_groups = [aws_security_group.alb[0].id]
    }
  }
  dynamic "ingress" {
    for_each = length(var.admin_ssh_cidrs) > 0 ? [1] : []
    content {
      description = "SSH from AWS EC2 Instance Connect range (auto-resolved per region; SSM is also always available)"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.admin_ssh_cidrs
    }
  }
  dynamic "ingress" {
    for_each = var.portainer_agent_enabled && length(var.portainer_server_cidrs) > 0 ? [1] : []
    content {
      description = "Portainer agent from the users own Portainer server"
      from_port   = var.portainer_agent_port
      to_port     = var.portainer_agent_port
      protocol    = "tcp"
      cidr_blocks = var.portainer_server_cidrs
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(local.common_tags, { Name = "${local.name_prefix}-app-sg" })
}

# RDS: 5432 only from app nodes. No public admin CIDR list by default (unlike
# the internal cc-ha-infra lab) — external users manage their DB via the app
# or SSM port-forwarding, not a publicly reachable endpoint.
resource "aws_security_group" "rds" {
  name        = "${local.name_prefix}-rds-sg"
  description = "RDS Postgres: 5432 only from app nodes"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from app nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(local.common_tags, { Name = "${local.name_prefix}-rds-sg" })
}
