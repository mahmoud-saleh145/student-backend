/**
 * Split the schema.prisma diff into one patch per commit.
 *
 * schema.prisma carries three unrelated concerns in a single file:
 *   commit 1 (infra)     - `directUrl` on the datasource
 *   commit 2 (academic)  - University.defaultAcademicSystem + Faculty.academicSystemOverride
 *   commit 3 (gumlet)    - Video.drmProvider + the six gumlet* columns
 *
 * `git add -p` would do this interactively. This does it deterministically so
 * the split can be reviewed as files on disk, and so the same patches can be
 * re-applied to the index later without hand-editing.
 *
 * It writes patches under .release-split/ and never touches the working tree,
 * the index, or any commit.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REL = 'prisma/schema.prisma';
const OUT = path.join(process.cwd(), '.release-split');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const diff = git(['diff', '--no-color', '-U3', '--', REL]);
if (!diff.trim()) {
  console.error('no diff for schema.prisma');
  process.exit(1);
}

const lines = diff.split('\n');
const header = [];
let i = 0;
for (; i < lines.length; i++) {
  if (lines[i].startsWith('@@')) break;
  header.push(lines[i]);
}

// Group hunks into commits by their content.
const COMMIT_OF = [
  { id: 1, name: 'infra', test: /directUrl|env\("DIRECT_URL"\)|Migrations bypass the pooler|advisory lock/i },
  { id: 2, name: 'academic', test: /defaultAcademicSystem|academicSystemOverride/i },
  { id: 3, name: 'gumlet', test: /drmProvider|gumlet/i },
];

const hunks = [];
let current = null;
for (; i < lines.length; i++) {
  const l = lines[i];
  if (l.startsWith('@@')) {
    current = [l];
    hunks.push(current);
  } else if (current) {
    if (l === '' && i === lines.length - 1) continue; // trailing newline
    current.push(l);
  }
}

const assign = (h) => {
  const body = h.join('\n');
  const hits = COMMIT_OF.filter((c) => c.test.test(body));
  if (hits.length === 0) throw new Error(`unclassified hunk:\n${h[0]}\n${body.slice(0, 400)}`);
  if (hits.length > 1)
    throw new Error(`hunk spans multiple commits:\n${h[0]}\n${body.slice(0, 400)}`);
  return hits[0];
};

const groups = { 1: [], 2: [], 3: [] };
for (const h of hunks) groups[assign(h).id].push(h);

fs.mkdirSync(OUT, { recursive: true });

console.log('=== schema.prisma hunk classification ===');
for (const h of hunks) {
  const c = assign(h);
  const added = h.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = h.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  console.log(`  commit ${c.id} (${c.name.padEnd(9)}) ${h[0].trim()}  +${added} -${removed}`);
}

for (const c of COMMIT_OF) {
  const hs = groups[c.id];
  const patch = [...header, ...hs.flat()].join('\n') + '\n';
  const file = path.join(OUT, `schema-commit${c.id}-${c.name}.patch`);
  fs.writeFileSync(file, patch);
  console.log(`\nwrote ${path.relative(process.cwd(), file)}  (${hs.length} hunk(s), ${patch.length} bytes)`);
}

// Sanity: applying 1 then 2 then 3 must reproduce the working-tree file exactly.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-split-'));
fs.mkdirSync(path.join(tmp, 'prisma'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'prisma', 'schema.prisma'), git(['show', `HEAD:${REL}`]));

for (const c of COMMIT_OF) {
  execFileSync('git', ['apply', '--unsafe-paths', '-p1', path.join(OUT, `schema-commit${c.id}-${c.name}.patch`)], {
    cwd: tmp,
  });
  console.log(`  applied commit ${c.id} patch cleanly`);
}

const rebuilt = fs.readFileSync(path.join(tmp, 'prisma', 'schema.prisma'), 'utf8');
const actual = fs.readFileSync(path.join(process.cwd(), REL), 'utf8');
const same = rebuilt.replace(/\r\n/g, '\n') === actual.replace(/\r\n/g, '\n');
console.log(`\nsequential application reproduces working tree exactly: ${same ? 'YES' : 'NO - STOP'}`);
if (!same) process.exit(2);
fs.rmSync(tmp, { recursive: true, force: true });