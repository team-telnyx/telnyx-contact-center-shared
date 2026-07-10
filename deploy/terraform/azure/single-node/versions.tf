terraform {
  required_version = ">= 1.7.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # State is local by default (fine for a single external deployment run
  # from one operator's machine), same choice as the AWS/GCP roots — point
  # this at an Azure Storage Account backend yourself if you want remote
  # state.
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
  # tenant_id / client_id / client_secret are read from ARM_TENANT_ID /
  # ARM_CLIENT_ID / ARM_CLIENT_SECRET env vars — see the
  # azure-infra-provisioning skill's Service Principal section for how the
  # wizard populates these from the AZURE_SERVICE_PRINCIPAL credential blob.
}
