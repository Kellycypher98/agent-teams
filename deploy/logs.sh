#!/usr/bin/env bash
# View the bot's logs on the server from your Mac.
#   ./deploy/logs.sh              follow live (Ctrl+C to stop)
#   ./deploy/logs.sh errors       warnings and errors from the last 24h
#   ./deploy/logs.sh today        everything since midnight
#   ./deploy/logs.sh 200          last 200 lines
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/.deploy.env ] && source deploy/.deploy.env
: "${AWS_HOST:?Set AWS_HOST in deploy/.deploy.env}"
: "${AWS_KEY:?Set AWS_KEY in deploy/.deploy.env}"
APP_NAME="${APP_NAME:-agent-team}"
SSH="ssh -i ${AWS_KEY} -o StrictHostKeyChecking=accept-new"
J="journalctl -u ${APP_NAME} -o cat --no-pager"

case "${1:-follow}" in
  follow) ${SSH} -t "${AWS_HOST}" "journalctl -u ${APP_NAME} -o cat -f -n 50" ;;
  errors) ${SSH} "${AWS_HOST}" "${J} --since '24 hours ago' | grep -E ' (WARN|ERROR) |\"level\":\"(warn|error)\"' || echo 'No warnings or errors in the last 24h.'" ;;
  today)  ${SSH} "${AWS_HOST}" "${J} --since today" ;;
  *)      ${SSH} "${AWS_HOST}" "${J} -n ${1}" ;;
esac
