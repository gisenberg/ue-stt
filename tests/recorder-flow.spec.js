import { expect, test } from '@playwright/test';

test('dark browser flow supports selection, markdown rename, and refinement', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Whisper Recorder' })).toBeVisible();
  await expect(page.getByText('Browser test Homelab CLI ready')).toBeVisible();
  await expect(page.getByLabel('Speech-to-text model')).toHaveValue('homelab');
  await page.getByLabel('Speech-to-text model').selectOption('local');
  await expect(page.getByText('Browser test Local Whisper ready')).toBeVisible();
  await page.getByLabel('Speech-to-text model').selectOption('homelab');
  await expect(page.getByRole('button', { name: /Sample microphone note/ })).toBeVisible();
  await expect(page.locator('.shell')).toHaveCSS('background-color', 'rgb(15, 17, 16)');

  await expect(page.locator('.markdownPreview')).toContainText('Sample microphone note');
  await expect(page.getByRole('button', { name: 'Retranscribe' })).toBeVisible();
  await page.getByTitle('Rename markdown file').click();
  await page.getByLabel('Markdown file name').fill('Renamed meeting notes');
  await page.getByTitle('Save markdown file name').click();

  await expect(page.getByRole('button', { name: /Renamed meeting notes/ })).toBeVisible();
  await expect(page.locator('.paneHeader')).toContainText('Renamed-meeting-notes.md');
  await expect(page.getByRole('heading', { name: 'Renamed meeting notes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Transcript' })).toBeVisible();
  await expect(page.locator('.toolbarActions').getByTitle('Show markdown file in Finder')).toHaveCount(0);
  await expect(page.locator('.toolbarActions').getByTitle('Open markdown file with Code')).toHaveCount(0);
  await expect(page.locator('.toolbarActions').getByTitle('Copy markdown path')).toHaveCount(0);
  await expect(page.locator('.paneHeader').getByTitle('Show markdown file in Finder')).toBeVisible();
  await expect(page.locator('.paneHeader').getByTitle('Open markdown file with Code')).toBeVisible();
  await expect(page.locator('.paneHeader').getByTitle('Copy markdown path')).toBeVisible();
  await page.getByTitle('Rename recording').click();
  await page.getByLabel('Recording name').fill('Navigation renamed talk');
  await page.getByTitle('Save recording name').click();
  await expect(page.getByRole('button', { name: /Navigation renamed talk/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Navigation renamed talk' })).toBeVisible();
  await page.getByRole('button', { name: 'Retranscribe' }).click();
  await expect(page.getByRole('button', { name: /Navigation renamed talk/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Navigation renamed talk' })).toBeVisible();

  await page.getByRole('tab', { name: 'Refined' }).click();
  await expect(page.getByLabel('Refinement prompt')).toHaveCount(0);
  await page.getByRole('button', { name: /Refinement Prompt/ }).click();
  await expect(page.getByLabel('Refinement prompt')).toContainText('Unreal Engine 5.8');
  await page.getByLabel('Refinement prompt').fill('Persisted Unreal Engine 5.8 refinement prompt');
  await expect(page.getByText('Refinement Prompt · Saved')).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Refined' }).click();
  await page.getByRole('button', { name: /Refinement Prompt/ }).click();
  await expect(page.getByLabel('Refinement prompt')).toHaveValue('Persisted Unreal Engine 5.8 refinement prompt');
  await page.getByRole('button', { name: 'Refine', exact: true }).click();
  await expect(page.getByRole('button', { name: /Navigation renamed talk/ })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /Refined 1/ })).toBeVisible();
  await expect(page.locator('.paneHeader')).toContainText('Navigation-renamed-talk_REFINED.md');
  await expect(page.getByText(/Refinement Prompt Used/)).toBeVisible();
  await expect(page.getByLabel('Refinement prompt')).toHaveCount(0);
  await expect(page.locator('.markdownPreview')).toContainText('Executive Bullets');
  await expect(page.getByRole('heading', { name: 'Executive Bullets' })).toBeVisible();
});

test('transcript and refined panes scroll when markdown overflows', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const longBody = Array.from({ length: 180 }, (_, index) => `Line ${index + 1}: detailed Unreal Engine note.`).join('\n');
    const recording = {
      id: 'sample-recording',
      title: 'Sample microphone note',
      createdAt: '2026-06-17T12:00:00.000Z',
      durationMs: 64000,
      model: 'homelab stt large-v3',
      audioFile: 'sample-recording.webm',
      markdownFile: 'sample-recording.md',
      text: longBody,
      transcribed: true,
      refinements: [
        {
          id: 'sample-recording-refined',
          title: 'Sample microphone note REFINED',
          createdAt: '2026-06-17T12:01:00.000Z',
          markdownFile: 'sample-recording_REFINED.md',
          prompt: 'Refine for Unreal Engine 5.8.'
        }
      ]
    };

    window.localStorage.setItem('ue-stt-browser-recordings', JSON.stringify([recording]));
    window.localStorage.setItem(
      'ue-stt-browser-markdown:sample-recording',
      `# Sample microphone note\n\n## Transcript\n\n${longBody}\n`
    );
    window.localStorage.setItem(
      'ue-stt-browser-markdown:sample-recording-refined',
      `# Sample microphone note REFINED\n\n## Executive Bullets\n\n${longBody}\n`
    );
  });
  await page.reload();

  const transcript = page.locator('.markdownBody');
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await transcript.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop > 0)).toBe(true);

  await page.getByRole('tab', { name: /Refined/ }).click();
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await transcript.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop > 0)).toBe(true);
});
