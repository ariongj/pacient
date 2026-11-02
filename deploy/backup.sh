#!/usr/bin/env bash
# Consistent, encrypted PostgreSQL backup for Pacient with retention.
#
#   DATABASE_URL=postgres://… BACKUP_AGE_RECIPIENT=age1… deploy/backup.sh
#   PACIENT_COMPOSE=deploy/compose.vps.yml BACKUP_AGE_RECIPIENT=age1… deploy/backup.sh
#
# Settings (environment):
#   DATABASE_URL          database to dump with the local pg_dump, or
#   PACIENT_COMPOSE       compose file whose `db` service is dumped with `docker compose exec`
#   BACKUP_DIR            where dumps are written (default /var/backups/pacient)
#   BACKUP_RETENTION_DAYS delete dumps older than this (default 14)
#   BACKUP_AGE_RECIPIENT  age public key; the dump is encrypted to it (strongly recommended: the
#                         server that makes backups then cannot read them). Required unless
#                         BACKUP_ALLOW_UNENCRYPTED=1 (development only).
#
# Output: pacient-<UTC timestamp>.dump[.age] plus a .sha256 checksum. Exit code is non-zero on any
# failure so a scheduler (cron/systemd timer) can alert. Verify restores regularly with
# deploy/restore-verify.sh – a backup that was never restored is not a backup.
set -euo pipefail
umask 077

BACKUP_DIR=${BACKUP_DIR:-/var/backups/pacient}
RETENTION=${BACKUP_RETENTION_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BASE="$BACKUP_DIR/pacient-$STAMP.dump"

if [[ -z "${BACKUP_AGE_RECIPIENT:-}" && "${BACKUP_ALLOW_UNENCRYPTED:-0}" != 1 ]]; then
  echo "Refusing to write an unencrypted backup of health data. Set BACKUP_AGE_RECIPIENT." >&2
  exit 2
fi
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && ! command -v age >/dev/null; then
  echo "age is not installed (https://age-encryption.org)." >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"

dump() {
  # --format=custom: compressed, restorable selectively with pg_restore. A single pg_dump runs in
  # one repeatable-read snapshot, so the dump is consistent while the API keeps running.
  if [[ -n "${PACIENT_COMPOSE:-}" ]]; then
    docker compose -f "$PACIENT_COMPOSE" exec -T db \
      pg_dump --format=custom --compress=6 --no-owner --no-privileges -U pacient -d pacient
  elif [[ -n "${DATABASE_URL:-}" ]]; then
    pg_dump --format=custom --compress=6 --no-owner --no-privileges --dbname="$DATABASE_URL"
  else
    echo "Set DATABASE_URL or PACIENT_COMPOSE." >&2
    return 2
  fi
}

TMP="$BASE.partial"
trap 'rm -f "$TMP"' EXIT
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  OUT="$BASE.age"
  dump | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" >"$TMP"
else
  OUT="$BASE"
  dump >"$TMP"
fi
# A truncated dump must never look like a good one: only complete files get their final name.
[[ -s "$TMP" ]] || { echo "Backup is empty." >&2; exit 1; }
mv "$TMP" "$OUT"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$OUT")" >"$(basename "$OUT").sha256")

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'pacient-*.dump*' -mtime +"$RETENTION" -print -delete

echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
