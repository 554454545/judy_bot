#!/usr/bin/env bash
# publish-artifact: upload a file to Cloudflare R2 and print the public link
set -euo pipefail
umask 077
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bot_root="$(cd -- "$script_dir/../../../../../.." && pwd -P)"

ENV_FILE="${bot_root}/.pi/agent/config/r2-upload/env"
[ -f "$ENV_FILE" ] || { echo "ERROR: no $ENV_FILE — run the setup in SKILL.md first" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${R2_ACCOUNT_ID:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_BUCKET:?}" "${R2_PUBLIC_BASE:?}"

FILE="${1:?usage: publish.sh <file> [remote-key]}"
KEY="${2:-$(basename "$FILE")}"
[ -f "$FILE" ] || { echo "ERROR: not a file: $FILE" >&2; exit 1; }

# rclone env-based remote (no conf file, always fresh credentials)
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_REGION=auto

rclone --config "${bot_root}/.pi/agent/config/rclone/rclone.conf" copyto "$FILE" "r2:${R2_BUCKET}/${KEY}" --no-check-dest
echo "${R2_PUBLIC_BASE}/${KEY}"
