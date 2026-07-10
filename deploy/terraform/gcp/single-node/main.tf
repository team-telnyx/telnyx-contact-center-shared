module "network" {
  source = "../../modules/cc-network-gcp"

  project_id              = var.project_id
  region                  = var.region
  deployment_name         = var.deployment_name
  admin_ssh_source_ranges = var.admin_ssh_source_ranges
  portainer_agent_enabled = var.portainer_agent_enabled
  portainer_agent_port    = var.portainer_agent_port
  portainer_server_cidrs  = var.portainer_server_cidrs
  lb_enabled              = var.lb_enabled
}

module "database" {
  source = "../../modules/cc-database-gcp"

  project_id        = var.project_id
  region            = var.region
  deployment_name   = var.deployment_name
  vpc_id            = module.network.vpc_self_link
  db_tier           = var.db_tier
  db_disk_size_gb   = var.db_disk_size_gb
  skip_final_backup = var.db_skip_final_backup

  # Cloud SQL private-IP instance creation requires the VPC peering
  # (google_service_networking_connection) to already exist — this
  # dependency crosses modules (vpc_id is a plain string, not a resource
  # reference), so Terraform can't infer it automatically. See
  # cc-database-gcp/main.tf's header comment for the full explanation.
  depends_on = [module.network]
}

module "storage" {
  source = "../../modules/cc-storage-gcp"

  project_id      = var.project_id
  deployment_name = var.deployment_name
  location        = var.region
  domain          = var.domain
}

module "secrets" {
  source = "../../modules/cc-secrets-gcp"

  project_id      = var.project_id
  deployment_name = var.deployment_name
}

module "compute" {
  source = "../../modules/cc-compute-single-gcp"

  project_id               = var.project_id
  region                   = var.region
  zone                     = var.zone
  deployment_name          = var.deployment_name
  vpc_self_link            = module.network.vpc_self_link
  subnet_self_link         = module.network.subnet_self_link
  network_tag              = module.network.network_tag
  machine_type             = var.machine_type
  root_volume_size_gb      = var.root_volume_size_gb
  db_secret_name           = module.database.db_secret_name
  app_env_secret_name      = module.secrets.app_env_secret_name
  storage_hmac_secret_name = module.storage.storage_hmac_secret_name
  storage_bucket_name      = module.storage.bucket_name
  portainer_agent_enabled  = var.portainer_agent_enabled
  portainer_agent_port     = var.portainer_agent_port
  lb_enabled               = var.lb_enabled
  domain                   = var.domain
  dns_managed_zone         = var.dns_managed_zone

  # The compute module's startup-script reads the storage HMAC secret's
  # LATEST version at boot (`gcloud secrets versions access latest`), but
  # `storage_hmac_secret_name` above (module.storage.storage_hmac_secret_name)
  # only resolves to the SECRET CONTAINER resource
  # (google_secret_manager_secret.storage_hmac.name) — it does not reference
  # google_secret_manager_secret_version.storage_hmac, the resource that
  # actually writes the HMAC key material. On a fresh `terraform apply`,
  # Terraform can therefore start the instance as soon as the (empty)
  # secret container exists, racing the version write; the startup script's
  # `latest` read then returns nothing, and it writes empty
  # STORAGE_ACCESS_KEY/STORAGE_SECRET_KEY into /opt/cc/node.env for the
  # first deploy. An explicit module-level depends_on forces every resource
  # in module.storage (including the secret version) to finish before any
  # compute resource is created, closing that race.
  depends_on = [module.storage]
}
