terraform {
  required_version = ">= 1.7.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State is local by default (fine for a single external deployment run from
  # one operator's machine), same choice as the AWS roots — point this at a
  # GCS backend yourself if you want remote state.
}

provider "google" {
  project = var.project_id
  region  = var.region
}
