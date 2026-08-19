// Codegen — turns a test case into a Playwright spec under tests/generated/.
const fs = require('fs');
const path = require('path');
const { flatten } = require('./runner');

const OUT_DIR = path.join(__dirname, '..', '..', 'tests', 'generated');

function q(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
}

function stepCode(step) {
  const loc = `page.locator(${q(step.selector || '')}).first()`;
  switch (step.action) {
    case 'goto':
      return `await page.goto(${q(step.url)});`;
    case 'click':
      return `await ${loc}.click();`;
    case 'hover':
      return `await ${loc}.hover();`;
    case 'fill':
      return `await ${loc}.fill(${q(step.value != null ? step.value : '')});`;
    case 'press':
      return step.selector
        ? `await ${loc}.press(${q(step.key)});`
        : `await page.keyboard.press(${q(step.key)});`;
    case 'select':
      return `await ${loc}.selectOption(${q(step.value)});`;
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
      return `await expect(${loc}).toHaveValue(${q(step.value != null ? step.value : '')});`;
    case 'assert-text':
      return `await expect(${loc}).toContainText(${q(step.text)});`;
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
      for (const step of seg.steps) lines.push('    ' + stepCode(step));
      lines.push('  });');
    }
  } else {
    for (const step of segments[0] ? segments[0].steps : []) lines.push('  ' + stepCode(step));
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
