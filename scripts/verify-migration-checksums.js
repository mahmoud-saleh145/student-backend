const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = new PrismaClient();
const DIR = path.join(process.cwd(), 'prisma', 'migrations');

(async () => {
  const applied = await db.$queryRawUnsafe(
    `SELECT migration_name, checksum FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  const byName = new Map(applied.map((r) => [r.migration_name, r.checksum]));

  const dirs = fs
    .readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  let mismatches = 0;
  let checked = 0;
  const phantom = [];

  console.log('=== checksum verification: every applied migration ===');
  console.log('   (raw = file bytes as-is; LF-normalised = CRLF folded to LF)');
  for (const name of dirs) {
    const expected = byName.get(name);
    if (!expected) continue; // pending, not yet applied
    checked++;
    const file = path.join(DIR, name, 'migration.sql');
    const raw = fs.readFileSync(file);
    const actual = crypto.createHash('sha256').update(raw).digest('hex');

    // A Windows working tree can rewrite LF as CRLF. Prisma hashes the raw
    // bytes, so a line-ending-only difference looks like drift even though the
    // SQL is byte-identical. Folding CRLF back to LF separates that case from a
    // genuine content change.
    const lf = crypto
      .createHash('sha256')
      .update(raw.toString('utf8').replace(/\r\n/g, '\n'))
      .digest('hex');

    const hasCrlf = raw.includes(0x0d);

    if (actual === expected) {
      console.log(`  MATCH        ${name}`);
    } else if (lf === expected) {
      phantom.push(name);
      console.log(`  EOL-ONLY     ${name}  (CRLF in working tree; SQL identical)`);
    } else {
      mismatches++;
      console.log(`  MISMATCH     ${name}`);
      console.log(`      production : ${expected}`);
      console.log(`      on disk    : ${actual}`);
      console.log(`      LF-normalised: ${lf}`);
    }
    void hasCrlf;
  }

  console.log(`\n  applied migrations checked : ${checked}`);
  console.log(`  real content mismatches    : ${mismatches}`);
  console.log(`  line-ending-only differences: ${phantom.length}`);
  console.log(
    `  ${mismatches === 0 ? '=> NO REAL DRIFT. Production SQL is semantically identical to the working tree.' : '=> REAL DRIFT. Stop.'}`,
  );

  // Which migrations exist locally but are pending
  const pending = dirs.filter((n) => !byName.has(n));
  console.log(`\n  pending (not in production): ${pending.length}`);
  for (const p of pending) console.log(`    ${p}`);

  await db.$disconnect();
})();