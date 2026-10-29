import {
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

/**
 * The one policy for a newly assigned password.
 *
 * Applies wherever an administrator or staff member sets a password: an
 * administrator resetting an account, an administrator creating a staff
 * account, and a staff member changing their own. Sign-in deliberately does
 * not apply it (see LoginDto) — an existing password that predates the policy
 * must keep working until it is next changed.
 *
 * Student registration does not use it yet: RegisterDto keeps its earlier
 * rule, because installed mobile builds cannot explain this stricter one.
 * Move registration onto it once every student client mirrors it.
 *
 *   - 8 to 128 characters.
 *   - A lowercase and an uppercase Latin letter, or an Arabic letter. Arabic
 *     has no case, so one Arabic letter satisfies both.
 *   - A digit, Western (0-9) or Arabic-Indic (٠-٩, ۰-۹).
 *   - Not trivially guessable: not a well-known password, at least five
 *     different characters, and not a number with a letter or two attached
 *     ("Aa123456", "Ab01001234567").
 *
 * The value is never trimmed or normalised: what the user typed is what is
 * hashed, so the same keystrokes always sign in.
 *
 * The dashboard mirrors this rule client-side so a password rejected here is
 * rejected before it is sent. This file is the authority; keep the mirror in
 * step with it.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const LATIN_LOWER = /[a-z]/;
const LATIN_UPPER = /[A-Z]/;
/** A letter in the Arabic script — not its digits or punctuation. */
const ARABIC_LETTER = /(?=\p{L})\p{Script=Arabic}/u;
const DIGIT = /[0-9٠-٩۰-۹]/;
const LETTER = /\p{L}/u;

/**
 * Well-known passwords that pass the composition rules. Compared
 * case-insensitively. Not an attempt at a breach corpus — just the ones a
 * person picks when told "upper, lower and a digit".
 */
const COMMON_PASSWORDS = new Set([
  'password1',
  'password12',
  'password123',
  'password1234',
  'passw0rd',
  'p@ssw0rd',
  'p@ssword1',
  'qwerty123',
  'qwerty1234',
  'qwertyuiop1',
  'welcome1',
  'welcome123',
  'admin123',
  'admin1234',
  'admin@123',
  'abc12345',
  'abc123456',
  'abcd1234',
  'abcde123',
  'iloveyou1',
  'letmein1',
  'student1',
  'student123',
  'teacher1',
  'teacher123',
]);

export type PasswordProblem = 'length' | 'letters' | 'digit' | 'common';

export const PASSWORD_POLICY_MESSAGE =
  'must be 8-128 characters and include an uppercase and a lowercase letter (an Arabic letter counts as both) and a digit';

const MESSAGES: Record<PasswordProblem, string> = {
  length: `must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
  letters: 'must include an uppercase and a lowercase letter (an Arabic letter counts as both)',
  digit: 'must include a digit',
  common: 'is too easy to guess; choose a less common password',
};

/** The first rule the value breaks, or null when it is acceptable. */
export function checkNewPassword(value: unknown): PasswordProblem | null {
  if (typeof value !== 'string') return 'length';
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    return 'length';
  }

  const arabic = ARABIC_LETTER.test(value);
  const hasLower = LATIN_LOWER.test(value) || arabic;
  const hasUpper = LATIN_UPPER.test(value) || arabic;
  if (!hasLower || !hasUpper) return 'letters';
  if (!DIGIT.test(value)) return 'digit';

  if (isGuessable(value)) return 'common';
  return null;
}

function isGuessable(value: string): boolean {
  if (COMMON_PASSWORDS.has(value.toLowerCase())) return true;

  const chars = Array.from(value);
  if (new Set(chars).size < 5) return true;

  const letters = chars.filter((c) => LETTER.test(c)).length;
  const digits = chars.filter((c) => DIGIT.test(c)).length;
  return letters <= 2 && digits >= 6;
}

@ValidatorConstraint({ name: 'newPassword', async: false })
export class NewPasswordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return checkNewPassword(value) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    const problem = checkNewPassword(args.value) ?? 'length';
    return `${args.property} ${MESSAGES[problem]}`;
  }
}

/** Property decorator: the value must satisfy the new-password policy. */
export const IsNewPassword = () => Validate(NewPasswordConstraint);
