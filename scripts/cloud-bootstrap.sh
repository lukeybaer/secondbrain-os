#!/usr/bin/env bash
# Amy mobile cloud-session bootstrap (v1).
#
# Runs at the start of every Claude Code web/mobile cloud session so a phone
# session behaves like Amy: read-only AWS access and secondbrain memory + #learn.
#
# Wired via the claude.ai/code environment "setup script" field (the ONLY copy
# of this pointer; all real logic lives here in the repo so one edit updates
# every surface):
#
#     git clone https://github.com/ExampleCoyExampleCo/SecondBrain "$HOME/secondbrain" 2>/dev/null || \
#       git -C "$HOME/secondbrain" pull --ff-only
#     bash "$HOME/secondbrain/scripts/cloud-bootstrap.sh"
#
# Required environment variables (set in the claude.ai environment config):
#   AMY_BOOTSTRAP_AWS_ACCESS_KEY_ID      key for the assume-only IAM user
#   AMY_BOOTSTRAP_AWS_SECRET_ACCESS_KEY  its secret
#   AMY_SANDBOX_ROLE_ARN                 arn of the read-only role to assume
#   AMY_SANDBOX_EXTERNAL_ID              external id required by the role trust
#   AWS_REGION                           defaults to us-east-1 if unset
#
# Security model (Codex-reviewed): the bootstrap key can do NOTHING except
# sts:AssumeRole into a short-lived (1h) read-only role. No secrets read, no
# writes, no deploy from the sandbox. Deploys happen only through the GitHub
# Actions workflow that ExampleCo approves; deploy credentials never enter a sandbox.
#
# v1 scope: read-only AWS + memory + #learn.
# Phase 2 (not yet): EC2 SSM shell, full 13-hook port, cross-repo Amy-identity
# injection into non-secondbrain repos, per-repo scoped write/deploy roles.
set -uo pipefail
log() { echo "[amy-bootstrap] $*"; }

# --- 1. AWS read-only access via assume-role ------------------------------
if [ -n "${AMY_BOOTSTRAP_AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AMY_SANDBOX_ROLE_ARN:-}" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    log "installing awscli..."
    if curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
        && (cd /tmp && unzip -q -o awscliv2.zip) \
        && /tmp/aws/install -i "$HOME/.local/aws-cli" -b "$HOME/.local/bin" >/dev/null 2>&1; then
      export PATH="$HOME/.local/bin:$PATH"
    elif command -v pip >/dev/null 2>&1 && pip install --quiet awscli; then
      : # pip fallback
    else
      log "WARNING: awscli install failed; AWS access unavailable this session"
    fi
  fi

  if command -v aws >/dev/null 2>&1; then
    mkdir -p "$HOME/.aws"
    umask 077
    cat > "$HOME/.aws/credentials" <<EOF
[amy-bootstrap]
aws_access_key_id = ${AMY_BOOTSTRAP_AWS_ACCESS_KEY_ID}
aws_secret_access_key = ${AMY_BOOTSTRAP_AWS_SECRET_ACCESS_KEY}
EOF
    cat > "$HOME/.aws/config" <<EOF
[default]
role_arn = ${AMY_SANDBOX_ROLE_ARN}
source_profile = amy-bootstrap
external_id = ${AMY_SANDBOX_EXTERNAL_ID:-}
region = ${AWS_REGION:-us-east-1}
EOF
    if AWS_ARN=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null); then
      log "AWS read-only ready: ${AWS_ARN}"
    else
      log "WARNING: assume-role failed; check the AMY_BOOTSTRAP_AWS_* env vars and role trust"
    fi
  fi
else
  log "no AMY_BOOTSTRAP_AWS_* env vars set; skipping AWS setup"
fi

# --- 2. secondbrain memory at the standard path ---------------------------
SB="${SECONDBRAIN_DIR:-$HOME/secondbrain}"
if [ -d "$SB/memory" ]; then
  mkdir -p "$HOME/.claude"
  ln -sfn "$SB/memory" "$HOME/.claude/memory"
  log "memory linked: ~/.claude/memory -> $SB/memory"
  if [ -f "$SB/memory/MEMORY.md" ]; then
    log "Amy Tier 1 present. READ FIRST: ~/.claude/memory/MEMORY.md, then AMY.md, AMY_REQUIREMENTS.md, AMY_FOUNDATION_REFLECTION.md before acting."
  fi
else
  log "secondbrain memory not found at $SB/memory (clone step may have failed)"
fi

log "bootstrap complete (v1: read-only AWS + memory; EC2 shell and full hooks are phase 2)"
