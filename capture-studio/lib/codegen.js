// Codegen — turns a test case into a Playwright spec under tests/generated/.
const fs = require('fs');
const path = require('path');
const { flatten, resolveParams } = require('./runner');

const OUT_DIR = path.join(__dirname, '..', '..', 'tests', 'generated');

function q(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
}

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Locator expression honouring the step's iframe context. */
function locExpr(step, { all = false } = {}) {
  let base = 'page';
  if (Array.isArray(step.frames) && step.frames.length) {
    base = 'page' + step.frames.map((f) => `.frameLocator(${q(f)})`).join('');
  } else if (step.frameUrl) {
    base = `page.frame({ url: ${q(step.frameUrl)} })!`;
  }
  return `${base}.locator(${q(step.selector || '')})${all ? '' : '.first()'}`;
}

function stepCode(step, params) {
  const P = (s) => resolveParams(s, params);
  const loc = locExpr(step);
  switch (step.action) {
    case 'goto':
      return `await page.goto(${q(P(step.url))});`;
    case 'reload':
      return `await page.reload();`;
    case 'back':
      return `await page.goBack();`;
    case 'wait':
      return `await page.waitForTimeout(${Number(step.ms) || 1000});`;
    case 'click':
      return `await ${loc}.click();`;
    case 'dblclick':
      return `await ${loc}.dblclick();`;
    case 'hover':
      return `await ${loc}.hover();`;
    case 'fill':
      return `await ${loc}.fill(${q(step.value != null ? P(step.value) : '')});`;
    case 'press':
      return step.selector
        ? `await ${loc}.press(${q(step.key)});`
        : `await page.keyboard.press(${q(step.key)});`;
    case 'select':
      return `await ${loc}.selectOption(${q(P(step.value))});`;
    case 'check':
      return `await ${loc}.check();`;
    case 'uncheck':
      return `await ${loc}.uncheck();`;
    case 'assert-visible':
      return `await expect(${loc}).toBeVisible();`;
    case 'assert-hidden':
      return `await expect(${loc}).toBeHidden();`;
    case 'assert-enabled':
      return `await expect(${loc}).toBeEnabled();`;
    case 'assert-disabled':
      return `await expect(${loc}).toBeDisabled();`;
    case 'assert-checked':
      return `await expect(${loc}).toBeChecked();`;
    case 'assert-unchecked':
      return `await expect(${loc}).not.toBeChecked();`;
    case 'assert-value':
      return `await expect(${loc}).toHaveValue(${q(P(step.value != null ? step.value : ''))});`;
    case 'assert-text':
      return `await expect(${loc}).toContainText(${q(P(step.text))});`;
    case 'assert-not-text':
      return `await expect(${loc}).not.toContainText(${q(P(step.text))});`;
    case 'assert-selected':
      return `await expect(${loc}.locator('option:checked')).toHaveText(${q(P(step.text))});`;
    case 'assert-attr':
      return `await expect(${loc}).toHaveAttribute(${q(step.name)}, ${q(P(step.value))});`;
    case 'assert-count':
      return `await expect(${locExpr(step, { all: true })}).toHaveCount(${Number(step.count) || 0});`;
    case 'assert-url':
      return `await expect(page).toHaveURL(new RegExp(${q(reEsc(P(step.text)))}));`;
    case 'assert-title':
      return `await expect(page).toHaveTitle(new RegExp(${q(reEsc(P(step.text)))}));`;
    case 'assert-aria':
      return `await expect(${loc}).toMatchAriaSnapshot(${q(step.snapshot || '')});`;
    default:
      return `// bước không hỗ trợ: ${step.action}`;
  }
}

function slugify(name, id) {
  const ascii = String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return (ascii || 'test-case') + '-' + id.replace(/^tc_/, '');
}

function generate(tc, getById) {
  const segments = flatten(tc, getById);
  const lines = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`// Sinh tự động từ Capture Studio — ${tc.id}`);
  lines.push(`test(${q(tc.name)}, async ({ page }) => {`);
  if (tc.type === 'composite') {
    for (const seg of segments) {
      lines.push(`  await test.step(${q(seg.name)}, async () => {`);
      for (const step of seg.steps) lines.push('    ' + stepCode(step, seg.params));
      lines.push('  });');
    }
  } else {
    const seg = segments[0];
    for (const step of seg ? seg.steps : []) lines.push('  ' + stepCode(step, seg.params));
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function exportSpec(tc, getById) {
  const code = generate(tc, getById);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, slugify(tc.name, tc.id) + '.spec.ts');
  fs.writeFileSync(file, code);
  return { file: path.relative(path.join(OUT_DIR, '..', '..'), file), code };
}

module.exports = { exportSpec, generate };
