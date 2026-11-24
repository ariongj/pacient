#!/usr/bin/env bash
# Invite the first account – once, on a new installation: the platform administrator, who then
# invites the Ministry and the facility directors from the admin portal.
#
#   deploy/first-admin.sh owner@example.org            platform administrator (default)
#   deploy/first-admin.sh official@example.org MINISTRY  a Ministry official instead
#   deploy/first-admin.sh --existing-installation owner@example.org
#                                                       platform administrator for an installation
#                                                       that has accounts but no administrator
#
# Refuses if any account exists – with --existing-installation, if an active platform
# administrator exists (or another account uses the address). The single-use activation link
# (valid 72 hours) is written only to a private file (folder 0700, file 0600; default
# ~/pacienti-private/invite.txt) – it is never printed, logged or e-mailed. Hand it to the owner
# privately, then delete the file. The owner chooses the password on the activation page and must
# set up two-step sign-in.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODE=()
if [[ ${1:-} == --existing-installation ]]; then
  MODE=(--existing-installation)
  shift
fi
EMAIL=${1:-}
ROLE=${2:-ADMIN}
[[ $EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ && $ROLE =~ ^(ADMIN|MINISTRY)$ ]] &&
  [[ ${#MODE[@]} -eq 0 || $ROLE == ADMIN ]] || {
  echo "Usage: deploy/first-admin.sh OWNER-EMAIL [ADMIN|MINISTRY]" >&2
  echo "       deploy/first-admin.sh --existing-installation OWNER-EMAIL" >&2
  exit 2
}
DIR=${PACIENTI_PRIVATE_DIR:-$HOME/pacienti-private}
OUT=$DIR/invite.txt
[[ -e $OUT ]] && { echo "STOP: $OUT exists. Use or delete the earlier invitation first." >&2; exit 1; }
install -d -m 700 "$DIR"

# Runs inside the API image as the current user, so the file belongs to you and nobody else.
# On failure nothing is created and no file is left behind.
docker compose --env-file .env.vps -f deploy/compose.vps.yml run --rm --no-deps -T \
  --user "$(id -u):$(id -g)" -v "$DIR:/private" \
  api node dist/ops/bootstrap-admin.js "$EMAIL" /private/invite.txt "$ROLE" ${MODE[@]+"${MODE[@]}"}

chmod 600 "$OUT"
echo "Invitation saved to $OUT (readable by you only)."
echo "Send the link inside it to the owner privately, then: rm $OUT"
