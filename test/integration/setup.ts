/**
 * Integration-test bootstrap.
 *
 * These tests talk to a **real PostgreSQL and a real Redis**, because the
 * things they verify — Serializable transaction behaviour under a concurrent
 * redemption, unique-index enforcement, cascade rules — are precisely the
 * things a mocked Prisma client cannot tell you anything about. A test double
 * will happily let you redeem a one-time code twice.
 *
 * Bring the dependencies up with:
 *
 *     docker compose up -d postgres redis
 *     DATABASE_URL=postgresql://edu:edu@localhost:5432/edu_test \
 *       npx prisma migrate deploy
 *     npm run test:e2e
 *
 * The suite refuses to run against a database whose name does not end in
 * `_test`. Every test truncates tables, and pointing that at a development
 * database with real work in it is a bad afternoon.
 */

import { execSync } from 'node:child_process';

const url = process.env.DATABASE_URL ?? '';

if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Integration tests need a real database — see test/integration/setup.ts.',
  );
}

const databaseName = url.split('/').pop()?.split('?')[0] ?? '';

if (!databaseName.endsWith('_test')) {
  throw new Error(
    `Refusing to run integration tests against "${databaseName}". ` +
      'The database name must end in "_test" — these tests truncate tables.',
  );
}

// Keep hashing cheap; these tests create dozens of users and argon2 at
// production settings would dominate the runtime.
process.env.ARGON_MEMORY_COST = '8192';
process.env.ARGON_TIME_COST = '1';
process.env.NODE_ENV = 'test';
process.env.RUN_WORKERS = 'false';

// Deterministic secrets so token assertions are reproducible. None of these
// are, or resemble, production values.
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-characters-long';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters-long';
process.env.JWT_PLAYBACK_SECRET ??= 'test-playback-secret-at-least-32-characters!!';
process.env.HLS_KEY_ROOT ??= 'test-hls-key-root-at-least-32-characters-long';
process.env.MEDIA_SIGNING_KEY ??= 'test-media-signing-key-at-least-32-chars!!';
process.env.DATABASE_URL ??= url;

beforeAll(() => {
  // Applying migrations here rather than in a shell step means a developer who
  // runs a single test file still gets a correctly-shaped schema.
  try {
    execSync('npx prisma migrate deploy', {
      stdio: 'pipe',
      env: process.env,
    });
  } catch (e) {
    throw new Error(
      `Could not apply migrations to the test database: ${(e as Error).message}`,
    );
  }
});
