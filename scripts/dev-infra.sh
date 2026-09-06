#!/usr/bin/env bash
#
# Local infrastructure without Docker.
#
# docker-compose.yml is the normal path and stays supported. This script exists
# because the integration environment had PostgreSQL 16 and Redis 7 installed
# natively but no Docker daemon, and because a native setup is often faster and
# less fragile on a developer laptop than a container stack.
#
# It is idempotent: running it twice is safe.
#
#   ./scripts/dev-infra.sh start     # start postgres + redis, create databases
#   ./scripts/dev-infra.sh stop
#   ./scripts/dev-infra.sh status
#   ./scripts/dev-infra.sh reset     # DESTROYS the data directory and re-creates
#
# Requires: postgresql-16, redis-server. On Debian/Ubuntu:
#   sudo apt-get install -y postgresql-16 redis-server
#
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/var/lib/postgresql/edudata}"
PGPORT="${PGPORT:-5432}"
PGLOG="${PGLOG:-/var/log/postgresql/edu.log}"
REDIS_DIR="${REDIS_DIR:-/var/lib/redis-edu}"
REDIS_PORT="${REDIS_PORT:-6379}"

DB_USER="${DB_USER:-edu}"
DB_PASS="${DB_PASS:-edu_dev_password}"
DB_MAIN="${DB_MAIN:-edu_platform}"
DB_TEST="${DB_TEST:-edu_test}"

# PostgreSQL refuses to run as root, so everything server-side runs as the
# `postgres` system user created by the package.
as_postgres() { su postgres -c "$1"; }

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }
}

start_postgres() {
  need "$PG_BIN/pg_ctl"

  if [ ! -d "$PGDATA/base" ]; then
    echo "→ initialising PostgreSQL cluster at $PGDATA"
    mkdir -p "$PGDATA" "$(dirname "$PGLOG")"
    chown -R postgres:postgres "$PGDATA" "$(dirname "$PGLOG")"
    # trust auth on loopback only: this cluster is never exposed off-host.
    as_postgres "$PG_BIN/initdb -D $PGDATA -U postgres --auth=trust --encoding=UTF8 --locale=C" >/dev/null
  fi

  if as_postgres "$PG_BIN/pg_ctl -D $PGDATA status" >/dev/null 2>&1; then
    echo "→ PostgreSQL already running"
  else
    echo "→ starting PostgreSQL on :$PGPORT"
    chown -R postgres:postgres "$(dirname "$PGLOG")" 2>/dev/null || true
    as_postgres "$PG_BIN/pg_ctl -D $PGDATA -l $PGLOG -o '-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1' start" >/dev/null
  fi

  for _ in $(seq 1 30); do
    pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1 && break
    sleep 1
  done
  pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1 || {
    echo "PostgreSQL did not come up; see $PGLOG" >&2; exit 1; }
}

create_databases() {
  # SUPERUSER on the app role is a local-development convenience: it lets the
  # integration tests TRUNCATE every table and lets a DBA-only extension like
  # pg_trgm be created without switching roles. Production uses a plain owner.
  psql -h 127.0.0.1 -p "$PGPORT" -U postgres -tc \
    "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -q -c \
      "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS' SUPERUSER;"

  for db in "$DB_MAIN" "$DB_TEST"; do
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -tc \
      "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || \
      psql -h 127.0.0.1 -p "$PGPORT" -U postgres -q -c "CREATE DATABASE $db OWNER $DB_USER;"
  done
  echo "→ databases ready: $DB_MAIN, $DB_TEST"
}

start_redis() {
  need redis-server
  if redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    echo "→ Redis already running"
    return
  fi
  echo "→ starting Redis on :$REDIS_PORT"
  mkdir -p "$REDIS_DIR"
  # appendonly keeps queued BullMQ jobs across a restart. Playback concurrency
  # keys are short-lived, so losing those is harmless.
  redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --daemonize yes \
    --appendonly yes --dir "$REDIS_DIR" --logfile "$REDIS_DIR/redis.log"
  for _ in $(seq 1 20); do
    redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping >/dev/null 2>&1 && break
    sleep 1
  done
}

case "${1:-start}" in
  start)
    start_postgres
    create_databases
    start_redis
    echo
    echo "PostgreSQL  127.0.0.1:$PGPORT   ($DB_MAIN, $DB_TEST)"
    echo "Redis       127.0.0.1:$REDIS_PORT"
    echo
    echo "Next:  npm run prisma:deploy && npm run seed && npm run bootstrap:master"
    ;;
  stop)
    as_postgres "$PG_BIN/pg_ctl -D $PGDATA stop -m fast" >/dev/null 2>&1 && echo "→ PostgreSQL stopped" || echo "→ PostgreSQL was not running"
    redis-cli -h 127.0.0.1 -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 && echo "→ Redis stopped" || echo "→ Redis was not running"
    ;;
  status)
    pg_isready -h 127.0.0.1 -p "$PGPORT" || true
    redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null || echo "redis: down"
    ;;
  reset)
    echo "This DESTROYS $PGDATA and every database in it."
    read -r -p 'Type "reset" to confirm: ' answer
    [ "$answer" = "reset" ] || { echo "aborted"; exit 1; }
    as_postgres "$PG_BIN/pg_ctl -D $PGDATA stop -m immediate" >/dev/null 2>&1 || true
    rm -rf "$PGDATA"
    start_postgres
    create_databases
    ;;
  *)
    echo "usage: $0 {start|stop|status|reset}" >&2
    exit 1
    ;;
esac
