#!/usr/bin/env bash
# Push your local code to the server and restart the bot. Run FROM your Mac:
#   ./deploy/deploy.sh            (first time:  ./deploy/deploy.sh --first)
# Settings live in deploy/.deploy.env:
#   AWS_HOST=ubuntu@<your-ec2-public-ip>
#   AWS_KEY=~/.ssh/agent-team.pem
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/.deploy.env ] && source deploy/.deploy.env
: "${AWS_HOST:?Set AWS_HOST in deploy/.deploy.env, e.g. ubuntu@3.120.1.2}"
: "${AWS_KEY:?Set AWS_KEY in deploy/.deploy.env, e.g. ~/.ssh/agent-team.pem}"
SSH="ssh -i ${AWS_KEY} -o StrictHostKeyChecking=accept-new"

echo "==> Uploading code to ${AWS_HOST} ..."
# data/ and workspace/ live on the server and are never overwritten from your Mac.
rsync -az --delete -e "${SSH}" \
  --exclude node_modules --exclude data --exclude workspace \
  --exclude .DS_Store --exclude '*.zip' --exclude '*.xlsx' --exclude deploy/.deploy.env \
  ./ "${AWS_HOST}:~/agent-team/"
${SSH} "${AWS_HOST}" 'chmod 600 ~/agent-team/.env'

if [ "${1:-}" = "--first" ]; then
  ${SSH} -t "${AWS_HOST}" 'bash ~/agent-team/deploy/bootstrap.sh'
else
  ${SSH} "${AWS_HOST}" 'cd ~/agent-team && npm ci --omit=dev --silent && sudo systemctl restart agent-team'
fi

echo "==> Deployed. Live logs:  ${SSH} ${AWS_HOST} 'journalctl -u agent-team -f'"
