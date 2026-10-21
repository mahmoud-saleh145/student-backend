import { isRetryableProviderFailure } from 'src/modules/videos/gumlet-ingest.service';
import { GumletRequestError } from 'src/modules/playback/gumlet-drm.service';

/**
 * Which provider failures may be tried again, and which may not.
 * ---------------------------------------------------------------------------
 *
 * An ACCOUNT-level refusal is not a hiccup. "The uploaded video duration
 * exceeds the storage minutes quota" and "the API key is not valid" are
 * answers, not questions: the same request will be refused identically however
 * many times it is made. Retrying them is not persistence, it is waste - and
 * on a quota, every attempt risks another dead asset at the provider.
 *
 * So those two stop the retry loop, and everything else keeps it.
 */

describe('isRetryableProviderFailure', () => {
  it('refuses to retry an exhausted allowance', () => {
    const error = new Error(
      'The uploaded video duration exceeds the storage minutes quota for your account. ' +
        'Please consider upgrading your account to increase storage minutes quota.',
    );

    expect(isRetryableProviderFailure(error)).toBe(false);
  });

  it('refuses to retry a broken credential', () => {
    expect(isRetryableProviderFailure(new Error('Unauthorized: the API key is not valid'))).toBe(
      false,
    );
  });

  it('retries a timeout', () => {
    const error = new GumletRequestError('Gumlet asset lookup timed out', true, null);
    expect(isRetryableProviderFailure(error)).toBe(true);
  });

  it('retries a 5xx from the provider', () => {
    const error = new GumletRequestError('Gumlet asset lookup failed with HTTP 503', true, 503);
    expect(isRetryableProviderFailure(error)).toBe(true);
  });

  it('does not retry a definitive answer from the provider', () => {
    // A 404 is the provider saying the asset does not exist. Asking again
    // cannot change that.
    const error = new GumletRequestError('Gumlet asset lookup failed with HTTP 404', false, 404);
    expect(isRetryableProviderFailure(error)).toBe(false);
  });

  it('treats an unrecognised error as retryable, because the provider could not be asked', () => {
    expect(isRetryableProviderFailure(new Error('socket hang up'))).toBe(true);
  });
});
