terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State is local by default (fine for a single external deployment run from
  # one operator's machine). Point this at an S3+DynamoDB backend yourself if
  # you want remote state — deliberately not opinionated here, unlike the
  # internal cc-ha-infra lab which is tied to one account/profile.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Deployment = var.deployment_name
      ManagedBy  = "terraform"
      Component  = "telnyx-contact-center"
    }
  }
}
