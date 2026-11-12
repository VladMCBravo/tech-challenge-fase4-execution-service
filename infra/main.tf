terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Repositório ECR exclusivo do microsserviço Execution Service
resource "aws_ecr_repository" "execution_service" {
  name                 = "${var.project_name}-execution-service"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Banco de Dados NoSQL Isolado (Compatível com MongoDB - execution_db) — Database per Service
resource "aws_docdb_cluster" "execution_db" {
  cluster_identifier      = "${var.project_name}-execution-docdb"
  engine                  = "docdb"
  master_username         = var.db_username
  master_password         = var.db_password
  skip_final_snapshot     = true
  storage_encrypted       = true
  backup_retention_period         = 7
  enabled_cloudwatch_logs_exports = ["audit", "profiler"]

  tags = {
    Project     = var.project_name
    Service     = "execution-service"
    Environment = var.environment
  }
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.execution_service.repository_url
  description = "URL do repositório ECR do Execution Service"
}

output "execution_db_endpoint" {
  value       = aws_docdb_cluster.execution_db.endpoint
  description = "Endpoint do banco NoSQL isolado (execution_db)"
}
