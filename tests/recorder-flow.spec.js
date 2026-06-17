import { expect, test } from '@playwright/test';

test('dark browser flow supports selection, markdown rename, and refinement', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Whisper Recorder' })).toBeVisible();
  await expect(page.getByText('Browser test Homelab STT ready')).toBeVisible();
  await expect(page.getByRole('button', { name: /Sample microphone note/ })).toBeVisible();
  await expect(page.locator('.shell')).toHaveCSS('background-color', 'rgb(15, 17, 16)');

  await expect(page.locator('.markdownPane pre')).toContainText('Sample microphone note');
  await expect(page.getByRole('button', { name: 'Retranscribe' })).toBeVisible();
  await page.getByTitle('Rename markdown file').click();
  await page.getByLabel('Markdown file name').fill('Renamed meeting notes');
  await page.getByTitle('Save markdown file name').click();

  await expect(page.getByRole('button', { name: /Renamed meeting notes/ })).toBeVisible();
  await expect(page.locator('.paneHeader')).toContainText('Renamed-meeting-notes.md');
  await expect(page.locator('.markdownPane pre')).toContainText('# Renamed meeting notes');

  await expect(page.getByLabel('Refinement prompt')).toContainText('Unreal Engine 5.8');
  await page.getByLabel('Refinement prompt').fill('Persisted Unreal Engine 5.8 refinement prompt');
  await expect(page.getByText('Refinement Prompt · Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Refinement prompt')).toHaveValue('Persisted Unreal Engine 5.8 refinement prompt');
  await page.getByRole('button', { name: 'Refine' }).click();
  await expect(page.getByRole('button', { name: /Renamed meeting notes REFINED/ })).toBeVisible();
  await expect(page.locator('.paneHeader')).toContainText('Renamed-meeting-notes_REFINED.md');
  await expect(page.locator('.markdownPane pre')).toContainText('## Executive Bullets');
});
