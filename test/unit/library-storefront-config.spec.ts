import { libraryConfig, parseStorefrontFlag } from '../../src/config/configuration';

/**
 * LIBRARY_STOREFRONT_ENABLED (decision G1): only the exact string `true` opens
 * the storefront; every other value — including the ones the shared `bool()`
 * helper would accept, like `1` — is OFF. An invalid value must never stop the
 * API from booting (env.validation.ts declares it as an optional string).
 */
describe('LIBRARY_STOREFRONT_ENABLED parsing (S1/S2)', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['uppercase TRUE', 'TRUE'],
    ['mixed case True', 'True'],
    ['1', '1'],
    ['yes', 'yes'],
    ['on', 'on'],
    ['leading space', ' true'],
    ['trailing space', 'true '],
    ['false', 'false'],
    ['boolean true (not a string)', true],
  ])('%s is OFF', (_name, value) => {
    expect(parseStorefrontFlag(value)).toBe(false);
  });

  it('only the exact string "true" is ON', () => {
    expect(parseStorefrontFlag('true')).toBe(true);
  });

  describe('read through the config namespace', () => {
    const original = process.env.LIBRARY_STOREFRONT_ENABLED;
    afterEach(() => {
      if (original === undefined) delete process.env.LIBRARY_STOREFRONT_ENABLED;
      else process.env.LIBRARY_STOREFRONT_ENABLED = original;
    });

    it('is OFF when the variable is absent', () => {
      delete process.env.LIBRARY_STOREFRONT_ENABLED;
      expect(libraryConfig().storefrontEnabled).toBe(false);
    });

    it('is OFF for "1"', () => {
      process.env.LIBRARY_STOREFRONT_ENABLED = '1';
      expect(libraryConfig().storefrontEnabled).toBe(false);
    });

    it('is ON for "true"', () => {
      process.env.LIBRARY_STOREFRONT_ENABLED = 'true';
      expect(libraryConfig().storefrontEnabled).toBe(true);
    });
  });
});
