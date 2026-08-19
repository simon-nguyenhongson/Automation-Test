// Runner — executes a test case (atomic or composite) with Playwright and
// reports per-step progress through the emit callback.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const RUNS_DIR = path.join(__dirname, '..', 'data', 'runs');
const STEP_TIMEOUT = 10000;

/** Flatten a test case into ordered segments of executable steps. */
function flatten(tc, getById, trail = []) {
  if (trail.includes(tc.id)) {
    throw new Error('Test case tổng hợp chứa vòng lặp: ' + tc.name);
  }
  if (tc.type === 'atomic') {
    return [{ id: tc.id, name: tc.name, steps: tc.steps || [] }];
  }
  const out = [];
  for (const childId of tc.children || []) {
    const child = getById(childId);
    if (!child) throw new Error('Không tìm thấy test case con: ' + childId);
    out.push(...flatten(child, getById, [...trail, tc.id]));
  }
  return out;
}

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

async function execStep(page, step) {
  const loc = step.selector ? page.locator(step.selector).first() : null;
  switch (step.action) {
    case 'goto':
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      return;
    case 'click':
      await loc.click({ timeout: STEP_TIMEOUT });
      return;
    case 'hover':
      await loc.hover({ timeout: STEP_TIMEOUT });
      return;
    case 'fill':
      await loc.fill(step.value != null ? String(step.value) : '', { timeout: STEP_TIMEOUT });
      return;
    case 'press':
      if (loc) await loc.press(step.key, { timeout: STEP_TIMEOUT });
      else await page.keyboard.press(step.key);
      return;
    case 'select':
      await loc.selectOption(step.value, { timeout: STEP_TIMEOUT });
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
      const expected = String(step.value != null ? step.value : '');
      const deadline = Date.now() + STEP_TIMEOUT;
      let last = '';
      while (Date.now() < deadline) {
        last = await loc.inputValue().catch(() => '');
        if (last === expected) return;
        await page.waitForTimeout(150);
      }
      throw new Error(`Giá trị không khớp — mong đợi "${expected}", thực tế "${last.slice(0, 60)}"`);
    }
    case 'assert-text': {
      await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      const deadline = Date.now() + STEP_TIMEOUT;
      let last = '';
      while (Date.now() < deadline) {
        last = (await loc.innerText().catch(() => '')) || '';
        if (last.replace(/\s+/g, ' ').includes(step.text)) return;
        await page.waitForTimeout(200);
      }
      throw new Error(
        `Không thấy văn bản "${step.text}" — thực tế: "${last.replace(/\s+/g, ' ').slice(0, 80)}"`
      );
    }
    default:
      throw new Error('Loại bước không hỗ trợ: ' + step.action);
  }
}

async function runTestCase(tc, getById, { headless = false, emit = () => {} } = {}) {
  const segments = flatten(tc, getById); // throws before anything launches
  const runId = 'run_' + Date.now().toString(36);
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
          await execStep(page, step);
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

function deleteRun(id) {
  const dir = path.join(RUNS_DIR, safeRunId(id));
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = { runTestCase, flatten, listRuns, getRun, deleteRun };
