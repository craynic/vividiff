import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let reviewId: string;
const fixture = () => JSON.parse(readFileSync('.local/e2e-fixture.json', 'utf8'));
async function api(request: any, method: string, params: any = {}) {
  const result = await (
    await request.post('http://127.0.0.1:1431/rpc', { data: { method, params } })
  ).json();
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.result;
}
test('loads grammar and theme resource plugins', async ({ page, request }) => {
  const root = process.cwd();
  await api(request, 'plugin_install', { path: join(root, 'examples/plugins/grammar') });
  await api(request, 'plugin_install', { path: join(root, 'examples/plugins/theme') });
  const f = fixture();
  writeFileSync(join(f.root, 'a.vnote'), 'TODO "before"\n');
  writeFileSync(join(f.root, 'b.vnote'), 'DONE "after"\n');
  await api(request, 'review_create', {
    source: 'files',
    left: join(f.root, 'a.vnote'),
    right: join(f.root, 'b.vnote'),
    title: 'Grammar review',
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Grammar review/ }).click();
  await expect(page.getByRole('button', { name: 'After 1', exact: true })).toBeVisible();
  await expect(
    page.getByText('Some highlight resources were rejected.', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Highlight theme', { exact: true }).selectOption('vivid-ocean');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'After 1', exact: true })).toBeVisible();
  await expect(
    page.getByText('Some highlight resources were rejected.', { exact: true }),
  ).toHaveCount(0);
});
test.describe.serial('real service review workflow', () => {
  test('creates Git review, selects changed lines and saves comments', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New review', exact: true }).first().click();
    await page.getByLabel('Title', { exact: true }).fill('Agent requested review');
    await page.getByLabel('Repository path', { exact: true }).fill(fixture().repo);
    await page.getByRole('button', { name: 'Create review', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Agent requested review' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'After 1', exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(
      page.getByText('Some highlight resources were rejected.', { exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'After 1', exact: true }).click();
    await page.getByLabel('Your feedback').fill('Please explain this change.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Please explain this change.', { exact: true })).toBeVisible();
    reviewId = (await api(request, 'review_list'))[0].id;
    const comments = await api(request, 'review_comments', { reviewId });
    expect(comments.items[0].anchor.selectedText).toContain('after');
    await page.screenshot({ path: 'test-results/review-english.png', fullPage: true });
  });
  test('switches language without losing draft and loads partial language file', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Agent requested review/ }).click();
    await page.getByRole('button', { name: 'File comment', exact: true }).click();
    await page.getByLabel('Your feedback').fill('Draft survives language changes');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Interface language', { exact: true }).selectOption('zh-CN');
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByLabel('你的反馈')).toHaveValue('Draft survives language changes');
    await page.screenshot({ path: 'test-results/review-chinese.png', fullPage: true });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('界面语言', { exact: true }).selectOption('fr');
    await expect(page.getByRole('heading', { name: 'Paramètres', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload languages', exact: true })).toBeVisible();
    await page.getByLabel('Interface language', { exact: true }).selectOption('en');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
  });
  test('retains original comments when refreshing changed working tree', async ({
    page,
    request,
  }) => {
    writeFileSync(join(fixture().repo, 'hello.ts'), 'export const message = "updated again";\n');
    await page.goto('/');
    await page.getByRole('button', { name: /Agent requested review/ }).click();
    await page.getByRole('button', { name: 'Capture / compare', exact: true }).click();
    await expect(page.getByText('Another snapshot', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await page.getByRole('button', { name: 'View original', exact: true }).click();
    await expect(page.getByText('Please explain this change.', { exact: true })).toBeVisible();
    const list = await api(request, 'comparison_list', { reviewId });
    expect(list.length).toBe(2);
  });
  test('completes all-snapshot feedback and persists immutable results', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Agent requested review/ }).click();
    page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Complete review', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reopen review', exact: true })).toBeVisible();
    const result = await api(request, 'review_result', { reviewId });
    expect(result.available).toBe(true);
    expect(result.result.comments).toHaveLength(1);
    expect(result.result.comparisons).toHaveLength(2);
    expect(result.result.comments[0].anchor.context).toContain('after');
    await page.reload();
    await page.getByRole('button', { name: /Agent requested review/ }).click();
    await expect(page.getByRole('button', { name: 'Reopen review', exact: true })).toBeVisible();
  });
});
