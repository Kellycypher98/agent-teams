#!/usr/bin/env bash
# One-time server setup, run ON the EC2 instance (Ubuntu) by deploy.sh --first.
# The service is named after the folder the code lives in (e.g. ~/slack-agent -> slack-agent).
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="$(basename "${APP_DIR}")"

# Small instances (1 GB, e.g. t3.micro) get OOM-killed during npm install. Add 2 GB swap once.
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  echo "==> Adding 2 GB swap ..."
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Installing Node.js 22, git, build tools ..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential

echo "==> Installing dependencies ..."
cd "${APP_DIR}"
npm ci --omit=dev
mkdir -p data workspace
# Kai may never push to main/master or delete branches from this server (see deploy/git-hooks/pre-push).
git config --global core.hooksPath "${APP_DIR}/deploy/git-hooks"

echo "==> Installing the ${APP_NAME} service ..."
sed "s|__USER__|${USER}|g; s|__DIR__|${APP_DIR}|g" deploy/agent-team.service \
  | sudo tee "/etc/systemd/system/${APP_NAME}.service" >/dev/null
# Keep logs for ~30 days but never more than 200 MB on disk.
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nMaxRetentionSec=30day\n' | sudo tee /etc/systemd/journald.conf.d/agent-team.conf >/dev/null
sudo systemctl restart systemd-journald
sudo systemctl daemon-reload
sudo systemctl enable --now "${APP_NAME}"

echo "==> Done. Logs: journalctl -u ${APP_NAME} -f"
