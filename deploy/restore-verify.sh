#!/usr/bin/env bash
# Proves a backup can be restored: restores it into a throw-away database, checks the schema and
# the data, prints a report and drops the database again. Never touches the live database.
#
#   ADMIN_DATABASE_URL=postgres://postgres@localhost/postgres \
#   BACKUP_AGE_IDENTITY=/secure/backup-key.txt deploy/restore-verify.sh /var/backups/pacient/pacient-….dump.age
#
# Settings (environment):
#   ADMIN_DATABASE_URL   a role allowed to CREATE/DROP DATABASE on the verification server (use a
#                        separate server from production where possible)
#   BACKUP_AGE_IDENTITY  age private key file, for .age backups
#   KEEP_RESTORED=1      keep the scratch database for inspection
set -euo pipefail

FILE=${1:?Usage: restore-verify.sh <backup file>}
ADMIN=${ADMIN_DATABASE_URL:?Set ADMIN_DATABASE_URL}
[[ -f "$FILE" ]] || { echo "No such file: $FILE" >&2; exit 2; }

if [[ -f "$FILE.sha256" ]]; then
  (cd "$(dirname "$FILE")" && sha256sum --check --quiet "$(basename "$FILE").sha256")
  echo "✓ checksum matches"
fi

SCRATCH="pacient_restore_check_$(date -u +%Y%m%d%H%M%S)"
WORK=$(mktemp -d)
cleanup() {
  rm -rf "$WORK"
  if [[ "${KEEP_RESTORED:-0}" != 1 ]]; then
    psql -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$SCRATCH\"" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

DUMP="$WORK/backup.dump"
if [[ "$FILE" == *.age ]]; then
  age --decrypt --identity "${BACKUP_AGE_IDENTITY:?Set BACKUP_AGE_IDENTITY for .age backups}" \
    --output "$DUMP" "$FILE"
else
  cp "$FILE" "$DUMP"
fi

pg_restore --list "$DUMP" >/dev/null
echo "✓ archive is readable"

psql -q "$ADMIN" -c "CREATE DATABASE \"$SCRATCH\""
TARGET=$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/"+sys.argv[2])))' "$ADMIN" "$SCRATCH")
START=$(date +%s)
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$TARGET" "$DUMP"
echo "✓ restored into $SCRATCH in $(($(date +%s) - START)) s"

q() { psql -X -A -t -q "$TARGET" -c "$1"; }

MIGRATIONS=$(q "SELECT count(*) FROM drizzle.__drizzle_migrations")
LAST=$(q "SELECT to_timestamp(max(created_at) / 1000) FROM drizzle.__drizzle_migrations")
echo "✓ $MIGRATIONS migrations applied (latest $LAST)"

FAIL=0
for t in users facilities patients encounters lab_results audit_logs; do
  n=$(q "SELECT count(*) FROM $t")
  printf '  %-14s %8s rows\n' "$t" "$n"
  if [[ "$t" =~ ^(users|facilities|audit_logs)$ && "$n" -eq 0 ]]; then
    echo "✗ $t is empty – this does not look like a Pacient database" >&2
    FAIL=1
  fi
done

# The audit log must still be append-only after a restore.
TRIGGERS=$(q "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal")
if [[ "$TRIGGERS" -lt 1 ]]; then
  echo "✗ audit log protection triggers are missing" >&2
  FAIL=1
else
  echo "✓ audit log is append-only ($TRIGGERS protection triggers)"
fi
LATEST_AUDIT=$(q "SELECT max(occurred_at) FROM audit_logs")
echo "  newest audit entry: $LATEST_AUDIT (recovery point)"

if [[ $FAIL -ne 0 ]]; then
  echo "RESTORE VERIFICATION FAILED" >&2
  exit 1
fi
echo "RESTORE VERIFIED"
