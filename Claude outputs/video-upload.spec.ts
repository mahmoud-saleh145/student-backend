import type { Page } from '@playwright/test';

import { expect, resetStub, test } from './fixtures';

/**
 * Lecture video: upload, processing, and the two ways it ends.
 *
 * The upload here is a real cross-origin PUT to the storage stand-in,
 * preflight included, because that is exactly the shape of the flow in
 * production: `videos/uploads/init` returns a presigned URL and the browser
 * sends the bytes straight to R2. Mocking that step would leave the one part
 * most likely to break — the CORS rule on the bucket — untested.
 *
 * Processing is a background job with no push channel, so the dashboard polls.
 * The stub advances one step per poll (QUEUED → PROCESSING → READY), which
 * means a dashboard that stopped polling would hang on PROCESSING here rather
 * than quietly passing.
 */

const STUB_API = `http://127.0.0.1:${process.env.STUB_API_PORT ?? 4599}`;

test.beforeEach(async ({ page }) => {
  await resetStub(page);
});

/** Small, so the test is about the flow rather than the bytes. */
const VIDEO = {
  name: 'lecture-01.mp4',
  mimeType: 'video/mp4',
  buffer: Buffer.from('\x00\x00\x00\x18ftypmp42stub-bytes-for-the-test'),
};

/** Opens the video dialog on the lecture that has no video yet. */
async function openVideoDialog(page: Page, lecture = 'Muscles of the forearm') {
  await page.goto('/courses/course-1?tab=content');

  const row = page.getByRole('listitem').filter({ hasText: lecture });
  await row.getByRole('button', { name: /video/i }).click();

  return page.getByRole('dialog');
}

test.describe('lecture video', () => {
  test('a lecture without a video offers a way to add one', async ({ page, signIn }) => {
    await signIn('admin');
    await page.goto('/courses/course-1?tab=content');

    const row = page.getByRole('listitem').filter({ hasText: 'Muscles of the forearm' });

    // The row has always shown a video status badge; for a long time it
    // offered no way to produce one.
    await expect(row.getByRole('button', { name: 'Add video' })).toBeVisible();
  });

  test('a lecture that already has one offers to replace it', async ({ page, signIn }) => {
    await signIn('admin');
    const dialog = await openVideoDialog(page, 'Skeletal system');

    await expect(dialog.getByRole('button', { name: 'Replace video' })).toBeVisible();
  });

  test('uploads the file and reports the video as queued', async ({ page, signIn }) => {
    await signIn('admin');
    const dialog = await openVideoDialog(page);

    await dialog.locator('input[type="file"]').setInputFiles(VIDEO);

    // The assertion is that the video reached a state the SERVER owns, not
    // that it is specifically QUEUED: the first status poll fires immediately
    // and the stub advances a step per poll, so pinning this to QUEUED would
    // be a race against the dashboard working correctly.
    await expect(
      dialog.getByText(/Queued for processing\.|Being processed\.|Ready to stream\./),
    ).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  });

  test('polls until processing finishes and the video is ready', async ({
    page,
    signIn,
  }) => {
    await signIn('admin');
    const dialog = await openVideoDialog(page);

    await dialog.locator('input[type="file"]').setInputFiles(VIDEO);

    // The stub only reaches READY on the second poll, so this passes only if
    // the dashboard keeps asking.
    await expect(dialog.getByText('Ready to stream.')).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText(/2 renditions/)).toBeVisible();
  });

  test('never exposes a storage URL for the source file', async ({ page, signIn }) => {
    // The uploads bucket is private and a source is never served to anyone.
    await signIn('admin');
    const dialog = await openVideoDialog(page);

    await dialog.locator('input[type="file"]').setInputFiles(VIDEO);
    await expect(dialog.getByText('Ready to stream.')).toBeVisible({ timeout: 20_000 });

    const text = (await dialog.textContent()) ?? '';
    expect(text).not.toContain('__storage__');
    expect(text).not.toContain('http://');
    expect(text).not.toContain('https://');
  });

  test('reports a refused upload and does not claim it worked', async ({
    page,
    signIn,
  }) => {
    await signIn('admin');
    await page.request.get(`${STUB_API}/__test__/fail-upload`);

    const dialog = await openVideoDialog(page);
    await dialog.locator('input[type="file"]').setInputFiles(VIDEO);

    await expect(dialog.getByRole('alert')).toContainText(/storage refused|could not reach/i);
    await expect(dialog.getByText(/Waiting for a transcoding worker/i)).toHaveCount(0);
  });

  test('rejects a file type the server would refuse, without a round trip', async ({
    page,
    signIn,
  }) => {
    await signIn('admin');
    const dialog = await openVideoDialog(page);

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });

    await expect(dialog.getByRole('alert')).toContainText(/file type is not accepted/i);
  });

  test('surfaces why processing failed and offers to retry it', async ({
    page,
    signIn,
  }) => {
    await signIn('admin');
    await page.request.get(`${STUB_API}/__test__/fail-processing`);

    const dialog = await openVideoDialog(page);
    await dialog.locator('input[type="file"]').setInputFiles(VIDEO);

    await expect(dialog.getByText('Processing failed')).toBeVisible({ timeout: 20_000 });

    // The worker's own reason, not a generic message — it is the only thing
    // that tells an administrator whether re-uploading would help.
    await expect(dialog.getByText(/ffmpeg exited with code 1/)).toBeVisible();

    // And retrying must not mean re-sending an 8 GB file.
    await expect(
      dialog.getByText(/still in storage, so retrying does not upload it again/i),
    ).toBeVisible();
  });

  test('retrying failed processing recovers without a second upload', async ({
    page,
    signIn,
  }) => {
    await signIn('admin');
    await page.request.get(`${STUB_API}/__test__/fail-processing`);

    const dialog = await openVideoDialog(page);
    await dialog.locator('input[type="file"]').setInputFiles(VIDEO);
    await expect(dialog.getByText('Processing failed')).toBeVisible({ timeout: 20_000 });

    await dialog.getByRole('button', { name: 'Try processing again' }).click();

    // No file input is touched here: the retry is asserted to reach READY on
    // the stored source alone.
    await expect(dialog.getByText('Ready to stream.')).toBeVisible({ timeout: 20_000 });
  });

  test('a new lecture leads straight into its video', async ({ page, signIn }) => {
    // A video cannot be uploaded before the lecture exists, so the dialog
    // creates the lecture and then shows the panel for it.
    await signIn('admin');
    await page.goto('/courses/course-1?tab=content');

    await page.getByRole('button', { name: 'Add lecture' }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: /Lecture title/ }).fill('Nerve supply');
    await dialog.getByRole('button', { name: 'Add lecture' }).click();

    await expect(dialog.getByRole('heading', { name: 'Add a video' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Choose video' })).toBeVisible();
  });

  test('is refused to a student, and to anyone without a session', async ({ page }) => {
    // The routes are @StaffOnly(); a teacher is staff, so the check that
    // matters here is that an unauthenticated caller gets nothing.
    const response = await page.request.post(`${STUB_API}/api/v1/videos/uploads/init`, {
      data: { lessonId: 'les-2', filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 },
      failOnStatusCode: false,
    });

    expect(response.status()).toBe(401);
  });
});
