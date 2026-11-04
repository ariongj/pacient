#!/usr/bin/env bash
# Point-in-time recovery for the Pacient compose deployment (pgBackRest, stanza "pacient").
#
#   deploy/pitr/pitr.sh init                         create the stanza, check archiving, full backup
#   deploy/pitr/pitr.sh backup [full|diff|incr]      base backup (default: diff)
#   deploy/pitr/pitr.sh info                         backups and WAL archive range (recovery window)
#   deploy/pitr/pitr.sh check                        archiving works and the newest WAL is recent
#   deploy/pitr/pitr.sh verify-restore "<time>"      restore a COPY to <time> and check it (safe)
#   deploy/pitr/pitr.sh restore-to-time "<time>"     restore the LIVE database to <time> (destructive)
#
# <time> is a PostgreSQL timestamp with zone, e.g. "2026-11-04 14:30:00+01" or
# "2026-11-04T13:30:00Z". It must lie inside the window shown by `info`.
#
# Settings (environment):
#   PACIENT_COMPOSE   base compose file (default deploy/compose.vps.yml)
#   PITR_COMPOSE      PITR override (default deploy/compose.pitr.yml)
#   PITR_MAX_WAL_AGE  `check`: newest archived WAL must be younger than this many seconds (900)
#   PITR_CONFIRM      must be "RESTORE-LIVE" for restore-to-time (no interactive prompt in cron)
#   PITR_KEEP_VERIFY  verify-restore: keep the scratch volume for inspection when set to 1
#
# Exit code is non-zero on any failure so a scheduler can alert.
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
BASE=${PACIENT_COMPOSE:-$ROOT/deploy/compose.vps.yml}
PITR=${PITR_COMPOSE:-$ROOT/deploy/compose.pitr.yml}
STANZA=pacient
MAX_WAL_AGE=${PITR_MAX_WAL_AGE:-900}

compose() { docker compose -f "$BASE" -f "$PITR" "$@"; }
# pgBackRest inside the running db container, as the postgres OS user.
pgbr() { compose exec -T --user postgres db pgbackrest --stanza="$STANZA" "$@"; }
# pgBackRest in a one-off db container (the database must be stopped or a different data dir used).
pgbr_offline() {
  local extra=("$@")
  compose run --rm --no-deps -T --user postgres --entrypoint pgbackrest db --stanza="$STANZA" "${extra[@]}"
}
psql_db() { compose exec -T db psql -v ON_ERROR_STOP=1 -U pacient -d pacient -Atc "$1"; }

die() {
  echo "pitr: $*" >&2
  exit 1
}

validate_time() {
  [[ "${1:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[T\ ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$ ]] ||
    die "give the target time with a zone, e.g. \"2026-11-04 14:30:00+01\" (got: ${1:-nothing})"
}

wait_healthy() {
  local id i
  id=$(compose ps -q db)
  for i in $(seq 1 120); do
    [[ "$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)" == healthy ]] && return 0
    sleep 2
  done
  die "database did not become healthy"
}

cmd_init() {
  pgbr stanza-create
  pgbr check
  pgbr --type=full backup
  pgbr info
}

cmd_backup() {
  local type=${1:-diff}
  [[ "$type" =~ ^(full|diff|incr)$ ]] || die "backup type must be full, diff or incr"
  pgbr --type="$type" backup
  pgbr expire
}

cmd_info() { pgbr info; }

cmd_check() {
  # pgBackRest's own check forces a WAL switch and waits until that segment is in the repository.
  pgbr check
  local age failed
  age=$(psql_db "SELECT coalesce(extract(epoch FROM now() - last_archived_time)::int, -1) FROM pg_stat_archiver")
  failed=$(psql_db "SELECT extract(epoch FROM now() - last_failed_time)::int FROM pg_stat_archiver WHERE last_failed_time > coalesce(last_archived_time, 'epoch')")
  [[ -z "$failed" ]] || die "the last WAL archive attempt failed ${failed}s ago (see pg_stat_archiver)"
  [[ "$age" -ge 0 && "$age" -le "$MAX_WAL_AGE" ]] ||
    die "last archived WAL is ${age}s old (limit ${MAX_WAL_AGE}s)"
  echo "pitr: archiving OK (last WAL archived ${age}s ago)"
}

# Restores a copy into a scratch volume, starts it read-only at the target and checks it, without
# touching the live database. Use it for the monthly restore test and before a live restore.
cmd_verify_restore() {
  local target=${1:-}
  validate_time "$target"
  local stamp vol name dir=/var/lib/postgresql/restore
  stamp=$(date -u +%Y%m%dt%H%M%Sz)
  vol="pacienti-pitr-verify-$stamp"
  name="pacienti-pitr-verify-$stamp"
  cleanup() {
    docker rm -f "$name" >/dev/null 2>&1 || true
    if [[ "${PITR_KEEP_VERIFY:-0}" != 1 ]]; then docker volume rm "$vol" >/dev/null 2>&1 || true; fi
  }
  trap cleanup EXIT

  echo "pitr: restoring a copy to $target into volume $vol"
  compose run --rm --no-deps -T --user root -v "$vol:$dir" --entrypoint sh db \
    -c "chown postgres:postgres $dir && chmod 0700 $dir"
  compose run --rm --no-deps -T --user postgres -v "$vol:$dir" --entrypoint pgbackrest db \
    --stanza="$STANZA" --pg1-path="$dir" --type=time --target="$target" \
    --target-action=pause restore

  # Start the copy without archiving, no published ports, paused at the target (read-only).
  compose run -d --no-deps --name "$name" -e PGDATA="$dir" -v "$vol:$dir" db \
    postgres -c archive_mode=off -c hot_standby=on >/dev/null
  local i ready=
  for i in $(seq 1 180); do
    if docker exec "$name" psql -U pacient -d pacient -Atc \
      "SELECT pg_is_in_recovery() AND pg_get_wal_replay_pause_state() = 'paused'" 2>/dev/null | grep -q t; then
      ready=1
      break
    fi
    sleep 2
  done
  [[ -n "$ready" ]] || die "the restored copy did not reach the target (see: docker logs $name)"

  local q="docker exec $name psql -v ON_ERROR_STOP=1 -U pacient -d pacient -Atc"
  local migrations newest_audit patients
  migrations=$($q "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo "?")
  patients=$($q "SELECT count(*) FROM patients")
  newest_audit=$($q "SELECT max(occurred_at) FROM audit_logs")
  echo "pitr: copy restored and consistent"
  echo "  target time        : $target"
  echo "  newest audit entry : $newest_audit (must not be after the target)"
  echo "  migrations applied : $migrations"
  echo "  patients           : $patients"
  $q "SELECT CASE WHEN max(occurred_at) <= '$target'::timestamptz THEN 'ok' ELSE 'after target' END FROM audit_logs" |
    grep -qx ok || die "the copy contains audit entries after the target time"
  if [[ "${PITR_KEEP_VERIFY:-0}" == 1 ]]; then
    echo "  kept volume        : $vol (container $name stopped; remove both when done)"
    docker stop "$name" >/dev/null
  fi
}

# Destructive: rewinds the LIVE database to the target time. Everything committed after it is
# no longer in the database (it stays in the repository on the old timeline, so you can restore
# forward again). Follow docs/DOWNTIME.md: declare downtime first, record on paper, back-enter.
cmd_restore_to_time() {
  local target=${1:-}
  validate_time "$target"
  [[ "${PITR_CONFIRM:-}" == RESTORE-LIVE ]] ||
    die "this rewinds the live database to $target. Run verify-restore first, then re-run with PITR_CONFIRM=RESTORE-LIVE"

  echo "pitr: 1/6 safety point – archive current WAL and take an incremental backup of the present state"
  if compose ps --status running -q db | grep -q .; then
    pgbr check || echo "pitr: warning: check failed; continuing with the archived state" >&2
    pgbr --type=incr backup || echo "pitr: warning: safety backup failed" >&2
  fi

  echo "pitr: 2/6 stopping api and database"
  compose stop api || true
  compose stop db

  echo "pitr: 3/6 restoring to $target (delta restore into the existing volume)"
  pgbr_offline --delta --type=time --target="$target" --target-action=promote restore

  echo "pitr: 4/6 starting the database (replays WAL to the target, then promotes a new timeline)"
  compose up -d --no-deps db
  wait_healthy
  for _ in $(seq 1 180); do
    [[ "$(psql_db 'SELECT pg_is_in_recovery()')" == f ]] && break
    sleep 2
  done
  [[ "$(psql_db 'SELECT pg_is_in_recovery()')" == f ]] || die "database is still in recovery"
  echo "  newest audit entry : $(psql_db 'SELECT max(occurred_at) FROM audit_logs')"

  echo "pitr: 5/6 full backup of the new timeline"
  pgbr --type=full backup

  echo "pitr: 6/6 starting the api"
  compose up -d api
  echo "pitr: done. Tell staff which period must be back-entered from paper (after $target)."
}

case "${1:-}" in
  init) cmd_init ;;
  backup) cmd_backup "${2:-diff}" ;;
  info) cmd_info ;;
  check) cmd_check ;;
  verify-restore) cmd_verify_restore "${2:-}" ;;
  restore-to-time) cmd_restore_to_time "${2:-}" ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
