#!/usr/bin/env bash
# Recover a platform administrator who lost both the password and the authenticator (and the
# recovery codes) – for example the only administrator, whom nobody else can help in the portal.
#
#   deploy/recover-admin.sh admin@example.org
#
# For an existing, activated and enabled administrator only. In one step the old password stops
# working, the authenticator app, recovery codes and passkeys are removed, every session ends, and
# a single-use password reset link (valid 24 hours) is written only to a private file (folder 0700,
# file 0600; default ~/pacienti-private/recover.txt) – it is never printed, logged or e-mailed.
# Audited as an owner-authorized recovery; the other administrators are told. Hand the link to the
# administrator privately (after making sure it is really them), then delete the file. They choose
# a new password with it and set up two-step sign-in again at the next sign-in.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

EMAIL=${1:-}
[[ $# -eq 1 && $EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || {
  echo "Usage: deploy/recover-admin.sh ADMIN-EMAIL" >&2
  exit 2
}
DIR=${PACIENTI_PRIVATE_DIR:-$HOME/pacienti-private}
OUT=$DIR/recover.txt
[[ -e $OUT ]] && { echo "STOP: $OUT exists. Use or delete the earlier link first." >&2; exit 1; }
install -d -m 700 "$DIR"

# Runs inside the API image as the current user, so the file belongs to you and nobody else.
# On refusal or failure nothing is changed and no file is left behind.
docker compose --env-file .env.vps -f deploy/compose.vps.yml run --rm --no-deps -T \
  --user "$(id -u):$(id -g)" -v "$DIR:/private" \
  api node dist/ops/recover-admin.js "$EMAIL" /private/recover.txt

chmod 600 "$OUT"
echo "Reset link saved to $OUT (readable by you only, valid 24 hours)."
echo "Give it to the administrator privately, then: rm $OUT"
