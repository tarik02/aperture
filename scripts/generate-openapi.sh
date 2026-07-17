#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
go -C tools tool oapi-codegen --config ../api/oapi-codegen.yaml ../api/openapi.yaml
