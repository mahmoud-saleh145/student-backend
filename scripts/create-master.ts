/* eslint-disable no-console */
/**
 * =============================================================================
 * Master account bootstrap
 * =============================================================================
 *
 * Spec §6 and §78: there is exactly ONE Master account and it is created at
 * the infrastructure level, never through a public flow.
 *
 * Why this is a script and not an endpoint
 * ----------------------------------------
 * An HTTP endpoint that creates the platform owner is a privilege-escalation
 * surface that exists forever, even if it is "protected by a setup token".
 * Every such endpoint eventually gets called by someone who should not have.
 * A script requires shell access to the machine that already holds the
 * database credentials — a privilege boundary that is real rather than
 * asserted.
 *
 * The API therefore contains no create-master route at all. Search the
 * codebase for `UserRole.MASTER` and you will find only *authorization*
 * checks, never a creation path.
 *
 * How duplication is prevented
 * ----------------------------
 * Three independent layers, because one is a single point of failure:
 *
 *   1. This script refuses to run if any non-deleted MASTER already exists.
 *   2. `UsersService.create()` rejects `role: MASTER` unconditionally, so no
 *      administrative endpoint can mint one either.
 *   3. The registration DTO whitelists its fields, so a client cannot smuggle
 *      a role in.
 *
 * Usage
 * -----
 *   # interactive (recommended — the password never enters shell history)
 *   npm run bootstrap:master
 *
 *   # non-interactive, for a provisioning pipeline that injects secrets
 *   MASTER_PHONE=01000000000 \
 *   MASTER_FULL_NAME="Platform Owner" \
 *   MASTER_PASSWORD="$(openssl rand -base64 24)" \
 *   npm run bootstrap:master -- --yes
 *
 *   # rotate the existing master's password instead of creating one
 *   npm run bootstrap:master -- --reset-password
 *
 * Verification
 * ------------
 *   psql "$DATABASE_URL" -c 'SELECT id, phone, role, status FROM users WHERE role = '"'"'MASTER'"'"';'
 * should return exactly one row.
 * =============================================================================
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { AccountStatus, PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: Number(process.env.ARGON_MEMORY_COST ?? 19456),
  timeCost: Number(process.env.ARGON_TIME_COST ?? 2),
  parallelism: Number(process.env.ARGON_PARALLELISM ?? 1),
};

// -----------------------------------------------------------------------------
// Validation — deliberately duplicated from the DTOs
//
// This script must not import the Nest application. Booting the container to
// create one row pulls in Redis, storage clients and queue connections that a
// provisioning shell may not have, and a failure in any of them would block
// the bootstrap. The rules below are the same ones RegisterDto enforces.
// -----------------------------------------------------------------------------

const PHONE_RE = /^01[0-2,5]\d{8}$/;

function validatePhone(phone: string): string {
  const normalized = phone.replace(/[\s-]/g, '').replace(/^\+20/, '0');
  if (!PHONE_RE.test(normalized)) {
    throw new Error(
      `"${phone}" is not a valid Egyptian mobile number (expected 01XXXXXXXXX).`,
    );
  }
  return normalized;
}

/**
 * Master passwords are held to a materially higher bar than student ones.
 * This account can read every payment record on the platform.
 */
function validatePassword(password: string): void {
  const problems: string[] = [];
  if (password.length < 16) problems.push('at least 16 characters');
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/\d/.test(password)) problems.push('a digit');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('a symbol');

  const weak = ['password', 'admin', 'master', '123456', 'qwerty', 'letmein'];
  if (weak.some((w) => password.toLowerCase().includes(w))) {
    problems.push('no common word such as "password" or "admin"');
  }

  if (problems.length) {
    throw new Error(`The master password must contain ${problems.join(', ')}.`);
  }
}

function validateName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 3 || trimmed.length > 120) {
    throw new Error('Full name must be between 3 and 120 characters.');
  }
  return trimmed;
}

// -----------------------------------------------------------------------------

async function prompt(question: string, secret = false): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  if (!secret) {
    const answer = await rl.question(question);
    rl.close();
    return answer.trim();
  }

  // Suppress echo so the password does not appear on screen or in a screen
  // share. readline has no built-in masked input, so the output write is
  // intercepted for the duration of the question.
  const output = rl as unknown as { output: NodeJS.WritableStream; _writeToOutput?: (s: string) => void };
  const original = output._writeToOutput;
  output._writeToOutput = function writeMasked(s: string) {
    if (s.includes(question)) original?.call(this, s);
    else original?.call(this, '');
  };

  const answer = await rl.question(question);
  output._writeToOutput = original;
  stdout.write('\n');
  rl.close();
  return answer.trim();
}

async function existingMaster() {
  return prisma.user.findFirst({
    where: { role: UserRole.MASTER, deletedAt: null },
    select: { id: true, phone: true, fullName: true, createdAt: true },
  });
}

// -----------------------------------------------------------------------------

async function resetPassword(): Promise<void> {
  const master = await existingMaster();
  if (!master) {
    throw new Error('No master account exists yet. Run without --reset-password.');
  }

  console.log(`\nRotating the password for ${master.fullName} (${master.phone}).\n`);

  const password =
    process.env.MASTER_PASSWORD ?? (await prompt('New master password: ', true));
  validatePassword(password);

  const confirm = process.env.MASTER_PASSWORD ?? (await prompt('Confirm: ', true));
  if (password !== confirm) throw new Error('Passwords do not match.');

  const passwordHash = await argon2.hash(password, ARGON_OPTIONS);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: master.id },
      data: {
        passwordHash,
        // Invalidates every refresh token issued before now, so a stolen
        // session cannot survive the rotation.
        credentialsChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    await tx.session.updateMany({
      where: { userId: master.id, status: 'ACTIVE' },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedReason: 'Master password rotated via bootstrap script',
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: master.id,
        actorRole: UserRole.MASTER,
        action: 'PASSWORD_RESET',
        entity: 'User',
        entityId: master.id,
        note: 'Rotated out of band via scripts/create-master.ts',
      },
    });
  });

  console.log('\n✓ Master password rotated. All existing master sessions were revoked.\n');
}

async function createMaster(assumeYes: boolean): Promise<void> {
  const existing = await existingMaster();
  if (existing) {
    console.error(
      [
        '',
        '✗ A master account already exists — refusing to create a second one.',
        '',
        `    id      ${existing.id}`,
        `    name    ${existing.fullName}`,
        `    phone   ${existing.phone}`,
        `    created ${existing.createdAt.toISOString()}`,
        '',
        'To change its password:      npm run bootstrap:master -- --reset-password',
        'To replace it entirely:      disable the old row first, deliberately, in psql.',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    [
      '',
      '─────────────────────────────────────────────',
      ' EduPlatform — master account bootstrap',
      '─────────────────────────────────────────────',
      '',
      'This creates the single platform-owner account. It cannot be created',
      'through the API, and this script will refuse to run a second time.',
      '',
    ].join('\n'),
  );

  const phone = validatePhone(
    process.env.MASTER_PHONE ?? (await prompt('Phone (01XXXXXXXXX): ')),
  );

  const clash = await prisma.user.findUnique({ where: { phone } });
  if (clash) {
    throw new Error(
      `Phone ${phone} already belongs to a ${clash.role} account. Use a different number.`,
    );
  }

  const fullName = validateName(
    process.env.MASTER_FULL_NAME ?? process.env.MASTER_NAME ?? (await prompt('Full name: ')),
  );

  const email = process.env.MASTER_EMAIL ?? (await prompt('Email (optional): '));

  const password =
    process.env.MASTER_PASSWORD ?? (await prompt('Password (min 16 chars): ', true));
  validatePassword(password);

  if (!process.env.MASTER_PASSWORD) {
    const confirm = await prompt('Confirm password: ', true);
    if (password !== confirm) throw new Error('Passwords do not match.');
  }

  if (!assumeYes && !process.env.MASTER_PASSWORD) {
    console.log(`\nAbout to create MASTER "${fullName}" with phone ${phone}.`);
    const ok = await prompt('Type "create" to confirm: ');
    if (ok !== 'create') {
      console.log('Aborted.');
      return;
    }
  }

  const passwordHash = await argon2.hash(password, ARGON_OPTIONS);

  const master = await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction. Two operators running this
    // simultaneously on a fresh database is unlikely but not impossible, and
    // the consequence — two masters — is exactly what the spec forbids.
    const racing = await tx.user.findFirst({
      where: { role: UserRole.MASTER, deletedAt: null },
      select: { id: true },
    });
    if (racing) throw new Error('A master account was created concurrently. Aborting.');

    const created = await tx.user.create({
      data: {
        phone,
        fullName,
        email: email && email.length > 3 ? email.toLowerCase() : null,
        passwordHash,
        role: UserRole.MASTER,
        status: AccountStatus.ACTIVE,
        locale: 'en',
      },
      select: { id: true, phone: true, fullName: true },
    });

    await tx.auditLog.create({
      data: {
        actorId: created.id,
        actorRole: UserRole.MASTER,
        action: 'CREATE',
        entity: 'User',
        entityId: created.id,
        after: { role: 'MASTER', phone: created.phone },
        note: 'Master account bootstrapped via scripts/create-master.ts',
      },
    });

    return created;
  });

  console.log(
    [
      '',
      '✓ Master account created.',
      '',
      `    id     ${master.id}`,
      `    phone  ${master.phone}`,
      `    name   ${master.fullName}`,
      '',
      'Next steps:',
      '  1. Store the password in your password manager. It cannot be recovered.',
      '  2. Sign in from the admin dashboard and confirm the role reads MASTER.',
      '  3. If MASTER_PASSWORD was passed as an environment variable, clear it',
      '     from your shell history and your CI secret store if it was one-shot.',
      '',
    ].join('\n'),
  );
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'Usage: npm run bootstrap:master [-- options]',
        '',
        '  --yes               skip the interactive confirmation',
        '  --reset-password    rotate the existing master password instead',
        '  --help              show this message',
        '',
        'Environment overrides: MASTER_PHONE, MASTER_FULL_NAME, MASTER_EMAIL, MASTER_PASSWORD',
      ].join('\n'),
    );
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Load your .env before running this.');
  }

  if (args.includes('--reset-password')) {
    await resetPassword();
    return;
  }

  await createMaster(args.includes('--yes'));
}

main()
  .catch((error: unknown) => {
    console.error(`\n✗ ${(error as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
