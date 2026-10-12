import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function openFixture(page: Page, request: APIRequestContext, title: string) {
  const fixture = JSON.parse(readFileSync('.local/e2e-fixture.json', 'utf8'));
  const left = join(fixture.root, title + '-before.ts'),
    right = join(fixture.root, title + '-after.ts');
  const before = Array.from({ length: 240 }, (_, i) => '// original line ' + (i + 1));
  const after = [...before];
  after[5] = '// ' + 'veryLongContent'.repeat(400);
  after[6] = '// replacement line 7';
  after[70] = '// replacement line 71';
  after[160] = '// replacement line 161';
  writeFileSync(left, before.join('\n') + '\n');
  writeFileSync(right, after.join('\n') + '\n');
  const response = await request.post('http://127.0.0.1:1431/rpc', {
    data: { method: 'review_create', params: { source: 'files', left, right, title } },
  });
  const result = await response.json();
  expect(result.error).toBeUndefined();
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('button', { name: 'After 6', exact: true })).toBeVisible({
    timeout: 30000,
  });
  return result.result.id as string;
}

test('resizes file list and shows exact added/deleted line counts', async ({ page, request }) => {
  await openFixture(page, request, 'Width and counts');
  const entry = page.locator('.file-entry.active');
  await expect(entry.locator('.stat-added')).toHaveText('+4');
  await expect(entry.locator('.stat-deleted')).toHaveText('−4');
  const panel = page.locator('.files-panel');
  const original = (await panel.boundingBox())!.width;
  const handle = page.getByRole('separator', { name: 'Resize file list' });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 123, box.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(original + 100);
  const resized = (await panel.boundingBox())!.width;
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeCloseTo(resized - 10, 0);
  await page.reload();
  await page.getByRole('button', { name: /Width and counts/ }).click();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeCloseTo(resized - 10, 0);
});

test('expands unchanged rows from top, bottom and all, retaining comment anchors', async ({
  page,
  request,
}) => {
  const reviewId = await openFixture(page, request, 'Expand context');
  const pane = page.locator('.diff-pane-left');
  const gap = (source: number) =>
    pane.locator('.diff-row[data-source-index="' + source + '"] .gap');
  await expect(gap(10).getByText('57 unchanged lines', { exact: true })).toBeVisible();
  await gap(10).getByRole('button', { name: 'Expand top 10', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Before 11', exact: true })).toBeVisible();
  await expect(gap(20).getByText('47 unchanged lines', { exact: true })).toBeVisible();
  await gap(20).getByRole('button', { name: 'Expand bottom 10', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Before 58', exact: true })).toBeVisible();
  // Scroll the remaining gap into view before expanding it.
  await gap(20).getByRole('button', { name: 'Expand all', exact: true }).click();
  await expect(gap(20)).toHaveCount(0);
  const line = pane.getByRole('button', { name: 'Before 21', exact: true });
  await line.click();
  await page.getByLabel('Your feedback').fill('Comment on expanded context');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Comment on expanded context', { exact: true })).toBeVisible();
  const result = await (
    await request.post('http://127.0.0.1:1431/rpc', {
      data: { method: 'review_comments', params: { reviewId } },
    })
  ).json();
  expect(result.result.items[0].anchor.startLine).toBe(21);
  expect(result.result.items[0].anchor.selectedText).toBe('// original line 21');
  await page.getByRole('button', { name: 'Unified', exact: true }).click();
  await expect(
    page.locator('.diff-pane-unified .diff-row[data-source-index="20"] .gap'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Side by side', exact: true }).click();
  await expect(page.locator('.diff-pane-left .diff-row[data-source-index="20"] .gap')).toHaveCount(
    0,
  );
});

test('navigates whole hunks, scrolls and highlights in both layouts', async ({ page, request }) => {
  await openFixture(page, request, 'Hunk navigation');
  await page.getByRole('checkbox', { name: 'Hide unchanged lines' }).uncheck();
  const next = page.getByRole('button', { name: 'Next change', exact: true });
  const prev = page.getByRole('button', { name: 'Previous change', exact: true });
  await next.click();
  await expect(page.locator('.change-position')).toHaveText('Change 1 / 3');
  await expect(page.locator('.diff-pane-left .active-change')).toHaveCount(2);
  await next.click();
  await expect(page.locator('.change-position')).toHaveText('Change 2 / 3');
  await expect(page.locator('.diff-pane-right .active-change')).toHaveAttribute(
    'data-source-index',
    '70',
  );
  await expect
    .poll(() => page.locator('.diff-pane-left').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1000);
  await expect(page.getByRole('button', { name: 'After 71', exact: true })).toBeVisible();
  await next.click();
  await expect(page.locator('.change-position')).toHaveText('Change 3 / 3');
  await prev.click();
  await expect(page.locator('.change-position')).toHaveText('Change 2 / 3');
  await page.getByRole('button', { name: 'Unified', exact: true }).click();
  await next.click();
  await expect(page.locator('.change-position')).toHaveText('Change 3 / 3');
  await expect(page.locator('.diff-pane-unified .active-change')).toHaveCount(2);
  await next.click();
  await expect(page.locator('.change-position')).toHaveText('Change 1 / 3');
  await prev.click();
  await expect(page.locator('.change-position')).toHaveText('Change 3 / 3');
});

test('keeps split divider centered with independent horizontal and synced vertical scrolling', async ({
  page,
  request,
}) => {
  await openFixture(page, request, 'Stable split');
  const left = page.locator('.diff-pane-left'),
    right = page.locator('.diff-pane-right');
  const a = (await left.boundingBox())!,
    b = (await right.boundingBox())!;
  expect(Math.abs(a.width - b.width)).toBeLessThan(2);
  expect(Math.abs(a.x + a.width - b.x)).toBeLessThan(2);
  expect(await right.evaluate((el) => el.scrollWidth)).toBeGreaterThan(b.width * 5);
  await right.evaluate((el) => {
    el.scrollLeft = 1800;
  });
  expect(await left.evaluate((el) => el.scrollLeft)).toBe(0);
  const after = (await right.boundingBox())!;
  expect(after.x).toBeCloseTo(b.x, 0);
  expect(after.width).toBeCloseTo(b.width, 0);
  await page.getByRole('checkbox', { name: 'Hide unchanged lines' }).uncheck();
  await right.evaluate((el) => {
    el.scrollTop = 3000;
  });
  await expect.poll(() => left.evaluate((el) => el.scrollTop)).toBe(3000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
  await page.setViewportSize({ width: 1100, height: 850 });
  await expect
    .poll(async () =>
      Math.abs((await left.boundingBox())!.width - (await right.boundingBox())!.width),
    )
    .toBeLessThan(2);
  await page.screenshot({ path: 'test-results/split-resize.png', fullPage: true });
});
