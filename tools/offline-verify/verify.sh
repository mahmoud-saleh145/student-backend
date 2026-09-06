#!/usr/bin/env bash
#
# Offline verification harness.
#
# Runs the project's real business logic without installing node_modules, by
# compiling the pure modules against small hand-written stubs for the two
# runtime packages they touch (@prisma/client's enums, @nestjs/common's
# decorators). It exists because the environment this integration ran in had
# the npm registry blocked, and "we could not verify anything" was not an
# acceptable outcome.
#
# It is NOT a replacement for `npm test`. It cannot exercise HTTP, guards,
# interceptors, or Prisma query building. What it does cover:
#
#   run-access-matrix.js   every course-status x enrollment-state combination
#                          through the real CourseAccessService.decide()
#   run-shape-contract.js  the real serializers, output diffed against the
#                          mobile app's TypeScript interfaces
#   run-media-origin.js    real media URL signing, verification and tamper
#                          rejection
#   run-device-headers.js  the real middleware against the exact headers the
#                          mobile client sends
#   run-e2e-flow.js        the student flow against a live PostgreSQL, feeding
#                          real rows into the real decision logic
#
# Requirements: node, tsc (npm i -g typescript), and for the e2e flow a
# PostgreSQL reachable per scripts/dev-infra.sh.
#
#   ./tools/offline-verify/verify.sh          # all suites
#   ./tools/offline-verify/verify.sh logic    # skip the database suite
#
set -uo pipefail
cd "$(dirname "$0")"

export NODE_PATH="$PWD/stubs"

command -v tsc >/dev/null 2>&1 || { echo "tsc not found: npm i -g typescript" >&2; exit 1; }

echo "── compiling the modules under test"
# tsc reports type errors caused by the stubs (untyped modules resolve to
# namespaces). Emit anyway: the JavaScript it produces is the real logic.
tsc -p tsconfig.harness.json >/dev/null 2>&1 || true
[ -d out/src ] || { echo "compilation produced no output" >&2; exit 1; }

fail=0
run() {
  echo
  echo "══ $1"
  if node "$1"; then :; else fail=1; fi
}

run run-access-matrix.js
run run-shape-contract.js
run run-media-origin.js
run run-device-headers.js

if [ "${1:-all}" != "logic" ]; then
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    echo
    echo "══ loading seed.sql into edu_platform"
    psql -h 127.0.0.1 -U edu -d edu_platform -q -v ON_ERROR_STOP=1 -f seed.sql >/dev/null
    run run-e2e-flow.js
  else
    echo
    echo "!! PostgreSQL not reachable — skipping the database suite."
    echo "   Start it with: ./scripts/dev-infra.sh start"
  fi
fi

echo
[ "$fail" -eq 0 ] && echo "ALL SUITES PASSED" || echo "SOME SUITES FAILED"
exit "$fail"
