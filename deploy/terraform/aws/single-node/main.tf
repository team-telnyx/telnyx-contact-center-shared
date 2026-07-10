module "network" {
  source = "../../modules/cc-network"

  deployment_name = var.deployment_name
  # RDS's DB subnet group hard-requires subnets in >= 2 AZs regardless of
  # multi_az (AWS API rejects a single-AZ subnet group outright — see
  # DBSubnetGroupDoesNotCoverEnoughAZs), even for a single-node deployment
  # with multi_az=false. The EC2 instance itself only ever uses the FIRST
  # public subnet (see below); the second AZ's subnets exist solely to
  # satisfy this RDS constraint.
  azs                     = slice(data.aws_availability_zones.available.names, 0, 2)
  topology                = "single"
  alb_enabled             = var.alb_enabled
  admin_ssh_cidrs         = var.admin_ssh_cidrs
  portainer_agent_enabled = var.portainer_agent_enabled
  portainer_agent_port    = var.portainer_agent_port
  portainer_server_cidrs  = var.portainer_server_cidrs
}

data "aws_availability_zones" "available" {
  state = "available"
}

module "database" {
  source = "../../modules/cc-database"

  deployment_name       = var.deployment_name
  vpc_id                = module.network.vpc_id
  private_subnet_ids    = module.network.private_subnet_ids
  rds_security_group_id = module.network.rds_security_group_id
  db_instance_class     = var.db_instance_class
  db_allocated_storage  = var.db_allocated_storage
  db_multi_az           = false
  skip_final_snapshot   = var.db_skip_final_snapshot
}

module "storage" {
  source = "../../modules/cc-storage"

  deployment_name = var.deployment_name
  domain          = var.domain
}

module "secrets" {
  source = "../../modules/cc-secrets"

  deployment_name = var.deployment_name
}

module "compute" {
  source = "../../modules/cc-compute-single"

  deployment_name           = var.deployment_name
  vpc_id                    = module.network.vpc_id
  subnet_id                 = module.network.public_subnet_ids[0]
  public_subnet_ids_for_alb = module.network.public_subnet_ids
  app_security_group_id     = module.network.app_security_group_id
  instance_type             = var.instance_type
  root_volume_size          = var.root_volume_size
  db_secret_arn             = module.database.db_secret_arn
  app_env_secret_arn        = module.secrets.app_env_secret_arn
  storage_bucket_arn        = module.storage.bucket_arn
  storage_bucket_name       = module.storage.bucket_name
  portainer_agent_enabled   = var.portainer_agent_enabled
  portainer_agent_port      = var.portainer_agent_port
  alb_enabled               = var.alb_enabled
  alb_security_group_id     = module.network.alb_security_group_id
  acm_certificate_arn       = var.acm_certificate_arn
  streaming_ws_domain_name  = var.streaming_ws_domain_name
  domain                    = var.domain
  dns_zone_id               = var.dns_zone_id
}
