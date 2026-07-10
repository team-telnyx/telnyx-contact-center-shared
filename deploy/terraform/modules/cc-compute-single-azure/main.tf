locals {
  name_prefix = var.deployment_name
  common_tags = merge({
    deployment = var.deployment_name
    managed-by = "terraform"
    component  = "telnyx-contact-center"
  }, var.tags)
}

# ===========================================================================
# IDENTITY — User-Assigned Managed Identity, attached to the VM, scoped
# tightly to THIS deployment's own Key Vault secrets + Storage container via
# role assignments below (no wildcard grants, no access to other
# deployments' resources in the same resource group). Mirrors the AWS
# root's per-deployment IAM instance role and the GCP root's per-deployment
# Service Account exactly. User-assigned (not system-assigned) so the same
# identity resource can be referenced by both the VM AND (when lb_enabled)
# the Application Gateway's Key Vault certificate reference without a
# circular VM<->identity dependency.
# ===========================================================================

resource "azurerm_user_assigned_identity" "app" {
  name                = "${local.name_prefix}-app-identity"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.common_tags
}

resource "azurerm_role_assignment" "app_kv_secrets_user" {
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# Scoped to exactly this deployment's own Storage Account (not
# subscription-wide Storage Blob Data Contributor) — same "own resources
# only" tightness the AWS root's inline S3 policy and the GCP root's bucket
# IAM member have.
resource "azurerm_role_assignment" "app_storage_blob_contributor" {
  scope                = var.storage_account_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ===========================================================================
# VM — cloud-init prepares the machine (Docker, az CLI, secrets fetch) but
# does NOT start the app container itself — that's triggered explicitly by
# deploy/cli/lib/azure-cloud.mjs over `az vm run-command invoke` once the
# first image tarball has been shipped to Blob Storage (mirrors the AWS
# root's SSM RunCommand mechanism and the GCP root's IAP-tunneled SSH
# command — see cc-compute-single's/cc-compute-single-gcp's main.tf headers
# for the shared rationale of keeping boot-time and update-time logic from
# diverging).
# ===========================================================================

resource "azurerm_public_ip" "app" {
  name                = "${local.name_prefix}-app-pip"
  resource_group_name = var.resource_group_name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.common_tags
}

resource "azurerm_network_interface" "app" {
  name                = "${local.name_prefix}-app-nic"
  resource_group_name = var.resource_group_name
  location            = var.location

  ip_configuration {
    name                          = "internal"
    subnet_id                     = var.app_subnet_id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.app.id
  }

  tags = local.common_tags
}

resource "azurerm_linux_virtual_machine" "app" {
  name                = "${local.name_prefix}-app"
  resource_group_name = var.resource_group_name
  location            = var.location
  size                = var.vm_size

  network_interface_ids = [azurerm_network_interface.app.id]

  # No SSH key material provisioned by default (disable_password_authentication
  # still requires an admin_ssh_key block to be SYNTACTICALLY present, so a
  # throwaway key is generated here but the wizard's primary remote-exec path
  # is `az vm run-command invoke`, which needs no SSH access at all — same
  # "no SSH keys, ever" posture as the AWS/GCP roots. The generated key's
  # private half is never surfaced as a Terraform output).
  disable_password_authentication = true
  admin_username                  = "ccadmin"
  admin_ssh_key {
    username   = "ccadmin"
    public_key = tls_private_key.vm_throwaway.public_key_openssh
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
    disk_size_gb         = var.os_disk_size_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  custom_data = base64encode(templatefile("${path.module}/templates/cloud-init.sh.tpl", {
    app_port                              = var.app_port
    streaming_ws_port                     = var.streaming_ws_port
    managed_identity_client_id            = azurerm_user_assigned_identity.app.client_id
    key_vault_name                        = var.key_vault_name
    app_env_secret_name                   = var.app_env_secret_name
    storage_connection_string_secret_name = var.storage_connection_string_secret_name
    storage_account_name                  = var.storage_account_name
    storage_container_name                = var.storage_container_name
    portainer_agent_enabled               = var.portainer_agent_enabled
    portainer_agent_port                  = var.portainer_agent_port
  }))

  tags = merge(local.common_tags, { name = "${local.name_prefix}-app" })

  depends_on = [
    azurerm_role_assignment.app_kv_secrets_user,
    azurerm_role_assignment.app_storage_blob_contributor,
  ]
}

# Throwaway key pair purely to satisfy admin_ssh_key's syntactic
# requirement — see the VM resource's comment above. Never used for actual
# access; `az vm run-command invoke` is the real remote-exec path.
resource "tls_private_key" "vm_throwaway" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

# ===========================================================================
# Application Gateway v2 (Phase 3) — Azure equivalent of the AWS root's
# ALB+ACM path and the GCP root's HTTPS Load Balancer + managed certificate.
# Entirely `count`-gated on var.lb_enabled, same shape as the AWS/GCP
# modules' alb_enabled/lb_enabled gates — nothing here exists when
# lb_enabled=false (Phase 1/2 default, plain HTTP directly on the
# instance's public IP).
#
# Structural difference from AWS ACM / GCP managed certs: Application
# Gateway does not issue/manage its own certificate the way ACM or Google's
# managed-cert resource do. It reads a certificate FROM Key Vault via its
# own identity, so the operator (or a separate process) must first import a
# real certificate into the shared Key Vault before the gateway can
# terminate TLS. This is a real, unavoidable gap relative to AWS/GCP's
# fully-automated cert issuance — documented here rather than papered over:
# a future iteration could automate issuance via Key Vault's own
# integration with a CA, but that is out of scope for Phase 3 parity and
# must be called out explicitly to the wizard operator (see the wizard's
# runAzureLbStep, once written, which should surface this requirement
# up-front rather than let `terraform apply` fail opaquely on a
# non-existent certificate reference).
# ===========================================================================

resource "azurerm_subnet" "appgw" {
  count                = var.lb_enabled ? 1 : 0
  name                 = "${local.name_prefix}-appgw-subnet"
  resource_group_name  = var.resource_group_name
  virtual_network_name = element(split("/", var.vnet_id), length(split("/", var.vnet_id)) - 1)
  address_prefixes     = [var.appgw_subnet_cidr]
}

resource "azurerm_public_ip" "appgw" {
  count               = var.lb_enabled ? 1 : 0
  name                = "${local.name_prefix}-appgw-pip"
  resource_group_name = var.resource_group_name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.common_tags
}

# Application Gateway needs its OWN identity (distinct from the VM's) with
# read access to the Key Vault certificate — granted the narrower
# "Key Vault Secrets User" + "Key Vault Certificate User" pairing rather
# than reusing the VM's identity, so a compromised app process can never
# read the TLS private key material via the same identity.
resource "azurerm_user_assigned_identity" "appgw" {
  count               = var.lb_enabled ? 1 : 0
  name                = "${local.name_prefix}-appgw-identity"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.common_tags
}

resource "azurerm_role_assignment" "appgw_kv_cert_user" {
  count                = var.lb_enabled ? 1 : 0
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.appgw[0].principal_id
}

resource "azurerm_application_gateway" "app" {
  count               = var.lb_enabled ? 1 : 0
  name                = "${local.name_prefix}-appgw"
  resource_group_name = var.resource_group_name
  location            = var.location

  sku {
    name     = "Standard_v2"
    tier     = "Standard_v2"
    capacity = 1
  }

  # By default Application Gateway buffers the ENTIRE backend response
  # before forwarding anything to the client (see
  # https://learn.microsoft.com/en-us/azure/application-gateway/proxy-buffers
  # and https://learn.microsoft.com/en-us/azure/application-gateway/use-server-sent-events).
  # For a never-ending stream (SSE: /api/user/status-stream,
  # /api/contact-center/agent/stream, /api/contact-center/monitor/stream)
  # there IS no "end of response", so with buffering on the client never
  # receives a single byte — EventSource connects but "connected"/
  # "new_interaction"/etc. never arrive, which is why the Interactions
  # card stays stuck on "Waiting for a call..." even though WebRTC calls
  # ring fine (WebRTC goes directly through the Telnyx SDK, bypassing this
  # gateway entirely). response_buffering_enabled=false makes the
  # gateway stream bytes through as they arrive from the backend instead.
  # request_buffering_enabled is left true (default) since it only
  # affects uploads, not this bug. The backend_http_settings.request_timeout
  # of 300s below already comfortably exceeds the SSE ping interval (15s),
  # which the same MS doc calls out as the other prerequisite for SSE.
  global {
    request_buffering_enabled  = true
    response_buffering_enabled = false
  }

  gateway_ip_configuration {
    name      = "appgw-ip-config"
    subnet_id = azurerm_subnet.appgw[0].id
  }

  frontend_port {
    name = "https-port"
    port = 443
  }

  frontend_ip_configuration {
    name                 = "appgw-frontend-ip"
    public_ip_address_id = azurerm_public_ip.appgw[0].id
  }

  backend_address_pool {
    name         = "app-backend-pool"
    ip_addresses = [azurerm_network_interface.app.private_ip_address]
  }

  backend_http_settings {
    name                  = "app-http-settings"
    cookie_based_affinity = "Disabled"
    port                  = var.app_port
    protocol              = "Http"
    request_timeout       = 300 # matches the AWS ALB idle_timeout / GCP backend timeout_sec=300 (SSE/long-poll streams)
    probe_name            = "app-health-probe"
  }

  probe {
    name                = "app-health-probe"
    protocol            = "Http"
    path                = "/api/health"
    host                = "127.0.0.1"
    interval            = 10
    timeout             = 5
    unhealthy_threshold = 3
  }

  # ---------------------------------------------------------------------
  # Streaming WebSocket backend — Azure equivalent of the AWS root's
  # aws_lb_target_group.streaming_ws + aws_lb_listener_rule.streaming_ws
  # (host-header routing) and the GCP root's backend_service.streaming_ws +
  # url_map host_rule/path_matcher pair. The wizard/provisionAzureInfra
  # already sets WS_BASE_URL=wss://ws.${domain} whenever lb_enabled=true
  # (see azure-cloud.mjs) and the operator is told DNS for BOTH
  # ${domain} and ws.${domain} is "managed automatically" — but until this
  # fix the gateway had only ONE backend_http_settings/routing_rule pair,
  # so every hostname (including ws.<domain>) forwarded to var.app_port
  # (3000) instead of var.streaming_ws_port (3001), silently breaking
  # WebRTC/AI streaming and the hardphone bridge the moment lb_enabled=true
  # was used. Same VM, same private IP — only the destination PORT and the
  # listener's host_name differ, so this reuses app-backend-pool rather
  # than declaring a second pool.
  #
  # Application Gateway routes by hostname via SEPARATE "multi-site"
  # listeners bound to the same frontend IP/port (443), each with its own
  # `host_name` — there is no host-header match INSIDE a single listener's
  # rule the way GCP's url_map host_rule works. Both listeners share the
  # one ssl_certificate imported into Key Vault (must cover both hostnames
  # — a SAN/wildcard cert — same requirement runAzureLbStep already prints
  # to the operator for the primary domain).
  # ---------------------------------------------------------------------

  backend_http_settings {
    name                  = "ws-http-settings"
    cookie_based_affinity = "Disabled"
    port                  = var.streaming_ws_port
    protocol              = "Http"
    request_timeout       = 300 # long-lived WebSocket connections need the same generous timeout as the app backend
    probe_name            = "ws-health-probe"
  }

  probe {
    name                = "ws-health-probe"
    protocol            = "Http"
    path                = "/api/health"
    host                = "127.0.0.1"
    port                = var.streaming_ws_port
    interval            = 10
    timeout             = 5
    unhealthy_threshold = 3
  }

  # Certificate MUST already exist in the shared Key Vault under this exact
  # secret name before `terraform apply` — see this section's header
  # comment. The wizard is responsible for surfacing that requirement to
  # the operator before reaching this step.
  ssl_certificate {
    name                = "${local.name_prefix}-tls-cert"
    key_vault_secret_id = "https://${var.key_vault_name}.vault.azure.net/secrets/${local.name_prefix}-tls-cert"
  }

  http_listener {
    name                           = "https-listener"
    frontend_ip_configuration_name = "appgw-frontend-ip"
    frontend_port_name             = "https-port"
    protocol                       = "Https"
    ssl_certificate_name           = "${local.name_prefix}-tls-cert"
    host_name                      = var.domain
  }

  http_listener {
    name                           = "https-listener-ws"
    frontend_ip_configuration_name = "appgw-frontend-ip"
    frontend_port_name             = "https-port"
    protocol                       = "Https"
    ssl_certificate_name           = "${local.name_prefix}-tls-cert"
    host_name                      = "ws.${var.domain}"
  }

  request_routing_rule {
    name                       = "app-routing-rule"
    rule_type                  = "Basic"
    priority                   = 100
    http_listener_name         = "https-listener"
    backend_address_pool_name  = "app-backend-pool"
    backend_http_settings_name = "app-http-settings"
  }

  request_routing_rule {
    name                       = "ws-routing-rule"
    rule_type                  = "Basic"
    priority                   = 90
    http_listener_name         = "https-listener-ws"
    backend_address_pool_name  = "app-backend-pool"
    backend_http_settings_name = "ws-http-settings"
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.appgw[0].id]
  }

  tags = local.common_tags

  depends_on = [azurerm_role_assignment.appgw_kv_cert_user]
}

# ===========================================================================
# Optional Azure DNS record — Azure equivalent of the AWS root's
# aws_route53_record.app / GCP root's google_dns_record_set. count-gated on
# BOTH lb_enabled (there is no stable, Terraform-managed public IP to point
# a record at otherwise) AND a non-empty dns_zone_name (the operator's
# explicit consent, resolved by the wizard's DNS step, mirroring AWS's
# dns_zone_id/dnsManaged gate and GCP's dns_managed_zone gate exactly).
#
# Azure DNS record-sets are addressed by their RELATIVE name within the
# zone ("@" for the zone apex, otherwise the subdomain label) — unlike
# Route53/Cloud DNS, which both accept the full fqdn directly. var.domain
# is the deployment's full domain (e.g. "cc.example.com"), and
# var.dns_zone_name is the matched Azure DNS zone's name (e.g.
# "example.com", found via the wizard's suffix-matching in azure-dns.mjs's
# findZoneForDomain). Hardcoding "@" here was WRONG whenever domain is a
# subdomain of the zone rather than the zone's own apex — it would
# create/overwrite the zone's apex A record instead of the deployment's
# actual hostname, silently leaving the app unpointed and potentially
# clobbering an unrelated existing apex record. Compute the relative label
# the same way azure-dns.mjs's findRecordForHost/CLI path already does:
# strip the zone suffix (plus separating dot) from the full domain, or "@"
# only when they're equal (domain IS the zone apex).
#
# Also creates the ws.<domain> A record pointing at the same Application
# Gateway IP — the AWS root's aws_lb_listener_rule.streaming_ws and the GCP
# root's google_dns_record_set.app_ws both already have a dedicated
# ws.<domain> DNS target; this Azure root was missing it even though the
# wizard's runAzureLbStep/azure-cloud.mjs already advertise
# WS_BASE_URL=wss://ws.<domain> to the app and tell the operator DNS is
# "managed automatically" for both hosts (see wizard.mjs's Azure DNS
# opt-in prompt, which explicitly promises "${domain} and ws.${domain}").
# ===========================================================================

locals {
  # "@" when domain equals the zone name exactly (the deployment domain IS
  # the zone apex); otherwise the subdomain label with the zone suffix (and
  # its separating dot) stripped off.
  dns_relative_name = var.domain == var.dns_zone_name ? "@" : trimsuffix(var.domain, ".${var.dns_zone_name}")
}

resource "azurerm_dns_a_record" "app" {
  count               = (var.lb_enabled && var.dns_zone_name != "") ? 1 : 0
  name                = local.dns_relative_name
  zone_name           = var.dns_zone_name
  resource_group_name = var.dns_zone_resource_group
  ttl                 = 300
  records             = [azurerm_public_ip.appgw[0].ip_address]
}

resource "azurerm_dns_a_record" "app_ws" {
  count               = (var.lb_enabled && var.dns_zone_name != "") ? 1 : 0
  name                = local.dns_relative_name == "@" ? "ws" : "ws.${local.dns_relative_name}"
  zone_name           = var.dns_zone_name
  resource_group_name = var.dns_zone_resource_group
  ttl                 = 300
  records             = [azurerm_public_ip.appgw[0].ip_address]
}

