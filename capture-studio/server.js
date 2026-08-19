// Capture Studio — record UI interactions into test cases, compose and run them.
// Usage: npm run studio  →  http://localhost:4700
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./lib/store');
const { RecorderSession } = require('./lib/recorder');
const { runTestCase, listRuns, getRun, deleteRun, runsUsage } = require('./lib/runner');
const { exportSpec } = require('./lib/codegen');

const PORT = process.env.STUDIO_PORT ? Number(process.env.STUDIO_PORT) : 4700;

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/runs', express.static(path.join(__dirname, 'data', 'runs')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

/* ---------------- test cases ---------------- */

app.get('/api/testcases', (req, res) => {
  res.json(store.list());
});

app.get('/api/testcases/:id', (req, res) => {
  const tc = store.get(req.params.id);
  if (!tc) return res.status(404).json({ error: 'Không tìm thấy test case' });
  res.json(tc);
});

app.post('/api/testcases', (req, res) => {
  const { type, name, children } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Nhập tên test case' });
  }
  if (type === 'composite') {
    const ids = Array.isArray(children) ? children : [];
    if (ids.length < 1) return res.status(400).json({ error: 'Chọn ít nhất một test case con' });
    for (const id of ids) {
      if (!store.get(id)) return res.status(400).json({ error: 'Không tìm thấy test case con: ' + id });
    }
  } else {
    // Safety net: an atomic case must open its page before anything else,
    // otherwise every run dies on the first step at about:blank.
    const body = req.body;
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (body.baseUrl && (!steps.length || steps[0].action !== 'goto')) {
      steps.unshift({ id: 'st_goto', action: 'goto', url: body.baseUrl });
      body.steps = steps;
    }
  }
  res.status(201).json(store.create(req.body));
});

app.put('/api/testcases/:id', (req, res) => {
  const tc = store.update(req.params.id, req.body || {});
  if (!tc) return res.status(404).json({ error: 'Không tìm thấy test case' });
  res.json(tc);
});

app.delete('/api/testcases/:id', (req, res) => {
  const tc = store.get(req.params.id);
  if (!tc) return res.status(404).json({ error: 'Không tìm thấy test case' });
  const used = store.referencing(req.params.id);
  if (used.length) {
    return res.status(409).json({
      error: 'Đang được dùng trong: ' + used.map((c) => c.name).join(', ') + '. Gỡ khỏi test case tổng hợp trước.',
    });
  }
  store.remove(req.params.id);
  res.json({ ok: true });
});

/* ---------------- recording ---------------- */

let session = null;

app.post('/api/record/start', async (req, res) => {
  const { url, headless } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Nhập URL bắt đầu bằng http:// hoặc https://' });
  }
  if (session && session.active) {
    return res.status(409).json({ error: 'Đang có phiên ghi khác. Dừng phiên đó trước.' });
  }
  session = new RecorderSession();
  session.on('step', (step) => broadcast({ type: 'record-step', step }));
  session.on('step-updated', (step) => broadcast({ type: 'record-step-updated', step }));
  session.on('steps-sync', (steps) => broadcast({ type: 'record-steps-sync', steps }));
  session.on('mode', (mode) => broadcast({ type: 'record-mode', mode }));
  session.on('warn', (message) => broadcast({ type: 'record-warn', message }));
  session.on('closed', () => broadcast({ type: 'record-stopped', reason: 'browser-closed' }));
  try {
    await session.start(url, { headless: !!headless });
    broadcast({ type: 'record-started', url });
    res.json({ ok: true, url });
  } catch (err) {
    session = null;
    res.status(500).json({ error: String(err.message || err).split('\n')[0] });
  }
});

app.get('/api/record/state', (req, res) => {
  if (!session || !session.active) return res.json({ active: false });
  res.json({ active: true, url: session.url, mode: session.mode, steps: session.steps });
});

app.post('/api/record/mode', async (req, res) => {
  if (!session || !session.active) return res.status(409).json({ error: 'Chưa có phiên ghi' });
  await session.setMode((req.body || {}).mode);
  res.json({ ok: true, mode: session.mode });
});

app.post('/api/record/stop', async (req, res) => {
  if (!session) return res.status(409).json({ error: 'Chưa có phiên ghi' });
  const steps = await session.stop();
  session = null;
  broadcast({ type: 'record-stopped', reason: 'user' });
  res.json({ steps });
});

/* ---------------- running ---------------- */

let running = false;

app.post('/api/run/:id', async (req, res) => {
  const tc = store.get(req.params.id);
  if (!tc) return res.status(404).json({ error: 'Không tìm thấy test case' });
  if (running) return res.status(409).json({ error: 'Đang có lượt chạy khác. Chờ xong rồi chạy tiếp.' });
  running = true;
  const headless = !!(req.body || {}).headless;
  try {
    const summary = await runTestCase(tc, store.get, { headless, emit: broadcast });
    store.update(tc.id, {
      lastRun: { status: summary.status, at: summary.at, passed: summary.passed, total: summary.total },
    });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err).split('\n')[0] });
  } finally {
    running = false;
  }
});

/* ---------------- run history ---------------- */

app.get('/api/runs', (req, res) => {
  res.json(listRuns());
});

app.get('/api/runs-usage', (req, res) => {
  res.json({ bytes: runsUsage() });
});

// Bulk delete — removes each run folder with all evidence images.
app.post('/api/runs/delete', (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  let deleted = 0;
  let freedBytes = 0;
  for (const id of ids) {
    try {
      const freed = deleteRun(id);
      if (freed !== null) {
        deleted++;
        freedBytes += freed;
      }
    } catch { /* skip invalid ids */ }
  }
  res.json({ deleted, freedBytes });
});

app.get('/api/runs/:id', (req, res) => {
  try {
    const run = getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Không tìm thấy lượt chạy' });
    res.json(run);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.delete('/api/runs/:id', (req, res) => {
  try {
    const freed = deleteRun(req.params.id);
    if (freed === null) return res.status(404).json({ error: 'Không tìm thấy lượt chạy' });
    res.json({ ok: true, freedBytes: freed });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

/* ---------------- batch run ---------------- */

app.post('/api/run-batch', async (req, res) => {
  const { ids, headless, parallel } = req.body || {};
  const list = (Array.isArray(ids) ? ids : []).filter((id) => store.get(id));
  if (!list.length) return res.status(400).json({ error: 'Chọn ít nhất một test case' });
  if (running) return res.status(409).json({ error: 'Đang có lượt chạy khác. Chờ xong rồi chạy tiếp.' });
  running = true;
  const names = list.map((id) => store.get(id).name);
  broadcast({ type: 'batch-started', ids: list, names, total: list.length, parallel: !!parallel });
  const results = [];
  let done = 0;

  const runOne = async (id) => {
    const tc = store.get(id);
    if (!tc) return;
    try {
      const summary = await runTestCase(tc, store.get, { headless: !!headless, emit: broadcast });
      store.update(tc.id, {
        lastRun: { status: summary.status, at: summary.at, passed: summary.passed, total: summary.total },
      });
      results.push({ tcId: id, name: tc.name, ...summary });
    } catch (err) {
      // One broken test case must not sink the whole batch.
      results.push({ tcId: id, name: tc.name, status: 'failed', error: String(err.message || err).split('\n')[0] });
    }
    broadcast({ type: 'batch-progress', done: ++done, total: list.length });
  };

  try {
    if (parallel) {
      const POOL = 4; // browsers at once — enough parallelism without drowning the machine
      const queue = list.slice();
      await Promise.all(
        Array.from({ length: Math.min(POOL, queue.length) }, async () => {
          while (queue.length) await runOne(queue.shift());
        })
      );
    } else {
      for (const id of list) await runOne(id);
    }
    broadcast({ type: 'batch-done', results });
    res.json({ results });
  } catch (err) {
    broadcast({ type: 'batch-done', results });
    res.status(500).json({ error: String(err.message || err).split('\n')[0] });
  } finally {
    running = false;
  }
});

/* ---------------- export ---------------- */

app.post('/api/export/:id', (req, res) => {
  const tc = store.get(req.params.id);
  if (!tc) return res.status(404).json({ error: 'Không tìm thấy test case' });
  try {
    res.json(exportSpec(tc, store.get));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err).split('\n')[0] });
  }
});

server.listen(PORT, () => {
  console.log(`Capture Studio chạy tại http://localhost:${PORT}`);
});
