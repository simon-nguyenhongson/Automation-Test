// Runner — executes a test case (atomic or composite) with Playwright and
// reports per-step progress through the emit callback.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const RUNS_DIR = path.join(__dirname, '..', 'data', 'runs');
const STEP_TIMEOUT = 10000;

/** Flatten a test case into ordered segments of executable steps. */
function flatten(tc, getById, trail = []) {
  if (trail.includes(tc.id)) {
    throw new Error('Test case tổng hợp chứa vòng lặp: ' + tc.name);
  }
  if (tc.type === 'atomic') {
    return [{ id: tc.id, name: tc.name, steps: tc.steps || [], params: tc.params || {} }];
  }
  const out = [];
  for (const childId of tc.children || []) {
    const child = getById(childId);
    if (!child) throw new Error('Không tìm thấy test case con: ' + childId);
    out.push(...flatten(child, getById, [...trail, tc.id]));
  }
  return out;
}

/** Substitute {{ten_bien}} placeholders with test-case params. */
function resolveParams(s, params) {
  if (s == null) return s;
  return String(s).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) =>
    params && Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
  );
}

/** Resolve the search scope for a step — main frame, a frameLocator chain
    (same-origin iframes) or a frame found by URL (cross-origin). */
function scopeFor(page, step) {
  if (Array.isArray(step.frames) && step.frames.length) {
    let scope = page;
    for (const f of step.frames) scope = scope.frameLocator(f);
    return scope;
  }
  if (step.frameUrl) {
    const target = String(step.frameUrl).split('#')[0];
    const fr =
      page.frames().find((x) => x.url().split('#')[0] === target) ||
      page.frames().find((x) => x.url().startsWith(target.split('?')[0]));
    if (!fr) throw new Error('Không tìm thấy iframe: ' + step.frameUrl);
    return fr;
  }
  return page;
}

const locFor = (page, step) => (step.selector ? scopeFor(page, step).locator(step.selector).first() : null);

function cleanError(err) {
  const msg = String((err && err.message) || err);
  // Playwright appends a long call log — keep the first meaningful line.
  return msg.split('\n').find((l) => l.trim()) || 'Lỗi không xác định';
}

/** Poll a condition until it holds or the step timeout elapses. */
async function pollTrue(page, fn, message) {
  const deadline = Date.now() + STEP_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch { /* element mid-update — retry */ }
    await page.waitForTimeout(150);
  }
  throw new Error(message);
}

async function execStep(page, step, params) {
  const P = (s) => resolveParams(s, params);
  const loc = locFor(page, step);
  switch (step.action) {
    case 'goto':
      await page.goto(P(step.url), { waitUntil: 'domcontentloaded', timeout: 20000 });
      return;
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      return;
    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
      return;
    case 'wait':
      await page.waitForTimeout(Math.min(Number(step.ms) || 1000, 60000));
      return;
    case 'click':
      await loc.click({ timeout: STEP_TIMEOUT });
      return;
    case 'dblclick':
      await loc.dblclick({ timeout: STEP_TIMEOUT });
      return;
    case 'hover':
      await loc.hover({ timeout: STEP_TIMEOUT });
      return;
    case 'fill':
      await loc.fill(step.value != null ? P(step.value) : '', { timeout: STEP_TIMEOUT });
      return;
    case 'press':
      if (loc) await loc.press(step.key, { timeout: STEP_TIMEOUT });
      else await page.keyboard.press(step.key);
      return;
    case 'select':
      await loc.selectOption(P(step.value), { timeout: STEP_TIMEOUT });
      return;
    case 'check':
      await loc.setChecked(true, { timeout: STEP_TIMEOUT });
      return;
    case 'uncheck':
      await loc.setChecked(false, { timeout: STEP_TIMEOUT });
      return;
    case 'assert-visible':
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      return;
    case 'assert-hidden':
      await loc.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
      return;
    case 'assert-enabled':
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      await pollTrue(
        page,
        async () => (await loc.isEnabled()) && (await loc.getAttribute('aria-disabled')) !== 'true',
        'Phần tử không ở trạng thái bật — đang bị vô hiệu'
      );
      return;
    case 'assert-disabled':
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      await pollTrue(
        page,
        async () => (await loc.isDisabled()) || (await loc.getAttribute('aria-disabled')) === 'true',
        'Phần tử không bị vô hiệu — đang bật'
      );
      return;
    case 'assert-checked':
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      await pollTrue(page, () => loc.isChecked(), 'Ô chưa được tích');
      return;
    case 'assert-unchecked':
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      await pollTrue(page, async () => !(await loc.isChecked()), 'Ô đang được tích');
      return;
    case 'assert-value': {
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      const expected = String(step.value != null ? P(step.value) : '');
      const deadline = Date.now() + STEP_TIMEOUT;
      let last = '';
      while (Date.now() < deadline) {
        last = await loc.inputValue().catch(() => '');
        if (last === expected) return;
        await page.waitForTimeout(150);
      }
      throw new Error(`Giá trị không khớp — mong đợi "${expected}", thực tế "${last.slice(0, 60)}"`);
    }
    case 'assert-selected': {
      // Compare the option label the user sees, not the hidden value.
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      const expected = P(step.text);
      const deadline = Date.now() + STEP_TIMEOUT;
      let last = '';
      while (Date.now() < deadline) {
        last = await loc
          .evaluate((el) => {
            const opt = el.selectedOptions ? el.selectedOptions[0] : null;
            return opt ? String(opt.label || opt.text || '').trim() : '';
          })
          .catch(() => '');
        if (last === expected) return;
        await page.waitForTimeout(150);
      }
      throw new Error(`Lựa chọn không khớp — mong đợi "${expected}", thực tế "${last.slice(0, 60)}"`);
    }
    case 'assert-not-text': {
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      await page.waitForTimeout(300); // let the UI settle
      const bad = P(step.text);
      const now = ((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
      if (now.includes(bad)) {
        throw new Error(`Văn bản "${bad}" vẫn đang hiển thị`);
      }
      return;
    }
    case 'assert-attr': {
      await loc.waitFor({ state: 'attached', timeout: STEP_TIMEOUT });
      const expected = String(P(step.value));
      await pollTrue(
        page,
        async () => (await loc.getAttribute(step.name)) === expected,
        `Thuộc tính ${step.name} không khớp — mong đợi "${expected}"`
      );
      return;
    }
    case 'assert-count': {
      const scope = scopeFor(page, step);
      const expected = Number(step.count);
      const deadline = Date.now() + STEP_TIMEOUT;
      let last = -1;
      while (Date.now() < deadline) {
        last = await scope.locator(step.selector).count().catch(() => -1);
        if (last === expected) return;
        await page.waitForTimeout(150);
      }
      throw new Error(`Số phần tử không khớp — mong đợi ${expected}, thực tế ${last}`);
    }
    case 'assert-url':
      await pollTrue(page, () => page.url().includes(P(step.text)), `URL không chứa "${P(step.text)}" — thực tế: ${page.url()}`);
      return;
    case 'assert-title': {
      const expected = P(step.text);
      await pollTrue(
        page,
        async () => (await page.title()).includes(expected),
        `Tiêu đề trang không chứa "${expected}"`
      );
      return;
    }
    case 'assert-aria': {
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      const norm = (s) =>
        String(s || '')
          .split('\n')
          .map((l) => l.trimEnd())
          .filter(Boolean)
          .join('\n');
      const expected = norm(step.snapshot);
      const deadline = Date.now() + STEP_TIMEOUT;
      let last = '';
      while (Date.now() < deadline) {
        last = norm(await loc.ariaSnapshot().catch(() => ''));
        if (last === expected) return;
        await page.waitForTimeout(300);
      }
      throw new Error('Cấu trúc ARIA của vùng không khớp bản đã ghi');
    }
    case 'assert-text': {
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      const expected = P(step.text);
      const deadline = Date.now() + STEP_TIMEOUT;
      let last = '';
      while (Date.now() < deadline) {
        last = (await loc.innerText().catch(() => '')) || '';
        if (last.replace(/\s+/g, ' ').includes(expected)) return;
        await page.waitForTimeout(200);
      }
      throw new Error(
        `Không thấy văn bản "${expected}" — thực tế: "${last.replace(/\s+/g, ' ').slice(0, 80)}"`
      );
    }
    default:
      throw new Error('Loại bước không hỗ trợ: ' + step.action);
  }
}

async function runTestCase(tc, getById, { headless = false, emit = () => {} } = {}) {
  const segments = flatten(tc, getById); // throws before anything launches
  // Random suffix — parallel runs can start within the same millisecond.
  const runId = 'run_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const startedAt = Date.now();

  emit({
    type: 'run-started',
    runId,
    tcId: tc.id,
    name: tc.name,
    segments: segments.map((s) => ({ id: s.id, name: s.name, steps: s.steps })),
  });

  const total = segments.reduce((n, s) => n + s.steps.length, 0);
  const dir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });

  // Full run record — steps are copied so the evidence stays intact even if
  // the test case is edited or deleted later.
  const record = {
    runId,
    tcId: tc.id,
    tcName: tc.name,
    tcType: tc.type,
    headless: !!headless,
    status: 'failed',
    passed: 0,
    failed: 0,
    skipped: 0,
    total,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    error: null,
    segments: segments.map((s) => ({
      id: s.id,
      name: s.name,
      steps: s.steps.map((st) => ({ ...st, status: null, error: null, shot: null })),
    })),
  };

  // Evidence after every step — pass and fail alike.
  async function snap(page, si, i) {
    try {
      const file = `seg${si}-step${i}.png`;
      await page.screenshot({ path: path.join(dir, file), timeout: 5000 });
      return `/runs/${runId}/${file}`;
    } catch {
      return null;
    }
  }

  let passed = 0;
  let failed = 0;
  let browser = null;

  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: headless ? { width: 1440, height: 900 } : null });
    const page = await context.newPage();

    outer: for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      emit({ type: 'run-segment', runId, segIndex: si, segId: seg.id, name: seg.name });
      for (let i = 0; i < seg.steps.length; i++) {
        const step = seg.steps[i];
        const rec = record.segments[si].steps[i];
        emit({ type: 'run-step', runId, segIndex: si, stepIndex: i, stepId: step.id, status: 'running' });
        try {
          await execStep(page, step, seg.params);
          passed++;
          rec.status = 'passed';
          rec.shot = await snap(page, si, i);
          emit({ type: 'run-step', runId, segIndex: si, stepIndex: i, stepId: step.id, status: 'passed', shot: rec.shot });
        } catch (err) {
          failed++;
          rec.status = 'failed';
          rec.error = cleanError(err);
          rec.shot = await snap(page, si, i);
          emit({
            type: 'run-step',
            runId,
            segIndex: si,
            stepIndex: i,
            stepId: step.id,
            status: 'failed',
            error: rec.error,
            shot: rec.shot,
          });
          break outer;
        }
      }
    }
  } catch (err) {
    // Browser died mid-run (user closed the window, launch failure…)
    if (!failed) failed = 1;
    record.error = cleanError(err);
    emit({ type: 'run-error', runId, error: record.error });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const status = failed ? 'failed' : 'passed';
  record.status = status;
  record.passed = passed;
  record.failed = failed;
  record.skipped = Math.max(0, total - passed - failed);
  record.durationMs = Date.now() - startedAt;
  try {
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(record, null, 2));
  } catch { /* history is best-effort */ }

  const summary = {
    runId,
    status,
    passed,
    failed,
    skipped: record.skipped,
    total,
    durationMs: record.durationMs,
    at: new Date().toISOString(),
  };
  emit({ type: 'run-done', ...summary });
  return summary;
}

/* ---------------- run history ---------------- */

function safeRunId(id) {
  if (!/^run_[a-z0-9]+$/.test(id)) throw new Error('Mã lượt chạy không hợp lệ');
  return id;
}

function listRuns() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((d) => /^run_[a-z0-9]+$/.test(d))
    .map((d) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, d, 'run.json'), 'utf8'));
        const { segments, ...summary } = r;
        return summary;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 200);
}

function getRun(id) {
  const file = path.join(RUNS_DIR, safeRunId(id), 'run.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    }
  } catch { /* best-effort */ }
  return total;
}

/** Deletes the whole run folder — evidence images included. Returns freed bytes. */
function deleteRun(id) {
  const dir = path.join(RUNS_DIR, safeRunId(id));
  if (!fs.existsSync(dir)) return null;
  const freed = dirSize(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return freed;
}

/** Total disk usage of all run artifacts. */
function runsUsage() {
  return fs.existsSync(RUNS_DIR) ? dirSize(RUNS_DIR) : 0;
}

module.exports = { runTestCase, flatten, listRuns, getRun, deleteRun, runsUsage, resolveParams };
