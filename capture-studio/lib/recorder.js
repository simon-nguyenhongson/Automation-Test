// RecorderSession — drives a headed Chromium, injects page-recorder.js and
// collects the steps the page reports back.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { chromium } = require('playwright');

const PAGE_SCRIPT = fs.readFileSync(path.join(__dirname, 'page-recorder.js'), 'utf8');

class RecorderSession extends EventEmitter {
  constructor() {
    super();
    this.steps = [];
    this.mode = 'action';
    this.active = false;
    this.url = '';
    this._seq = 0;
    this._lastEventAt = 0;
  }

  async start(url, { headless = false } = {}) {
    this.url = url;
    this.active = true;
    this.browser = await chromium.launch({ headless });
    this.context = await this.browser.newContext({ viewport: null });
    await this.context.exposeBinding('__csRecord', (source, step) => this._onStep(step, source.page));
    // In-page toolbar switches mode for the whole session (all pages + studio UI).
    await this.context.exposeBinding('__csModeRequest', (source, mode) => this.setMode(mode));
    await this.context.addInitScript(PAGE_SCRIPT);
    this.context.on('page', (page) => this._wirePage(page));
    this.browser.on('disconnected', () => this._onClosed());

    const page = await this.context.newPage();
    this._recordRaw({ action: 'goto', url });
    this._lastEventAt = Date.now();
    await page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch((err) => this.emit('warn', String(err.message || err).split('\n')[0]));
    return this;
  }

  _wirePage(page) {
    page.on('framenavigated', async (frame) => {
      if (!this.active) return;
      if (frame !== page.mainFrame()) return;
      const u = frame.url();
      if (!u || u === 'about:blank') return;
      // A navigation long after the last recorded action means the user typed
      // a URL — actions that caused navigation replay on their own.
      if (Date.now() - this._lastEventAt > 1500) {
        this._lastEventAt = Date.now();
        this._recordRaw({ action: 'goto', url: u });
      }
      try {
        await page.evaluate((m) => window.__csSetMode && window.__csSetMode(m), this.mode);
      } catch { /* page navigating again */ }
    });
  }

  _onStep(step, page) {
    if (!this.active) return;
    this._lastEventAt = Date.now();
    if (step.action === 'fill') {
      const last = this.steps[this.steps.length - 1];
      if (last && last.action === 'fill' && last.selector === step.selector) {
        last.value = step.value;
        last.secret = step.secret;
        this.emit('step-updated', last);
        return;
      }
    }
    if (step.action === 'dblclick') {
      // The double click arrives after its two single clicks — replace them.
      let removed = 0;
      while (removed < 2) {
        const last = this.steps[this.steps.length - 1];
        if (last && last.action === 'click' && last.selector === step.selector) {
          this.steps.pop();
          removed++;
        } else break;
      }
      this._recordRaw(step);
      if (removed) this.emit('steps-sync', this.steps.slice());
      return;
    }
    if (step.action === 'assert-aria' && page) {
      // The ARIA snapshot template is captured Node-side at record time.
      this._captureAria(step, page);
      return;
    }
    this._recordRaw(step);
  }

  async _captureAria(step, page) {
    try {
      let scope = page;
      if (Array.isArray(step.frames)) {
        for (const f of step.frames) scope = scope.frameLocator(f);
      }
      step.snapshot = await scope.locator(step.selector).first().ariaSnapshot({ timeout: 3000 });
    } catch {
      step.snapshot = '';
    }
    if (!this.active) return;
    this._recordRaw(step);
  }

  _recordRaw(step) {
    const s = { id: 'st_' + ++this._seq, ...step };
    this.steps.push(s);
    this.emit('step', s);
  }

  async setMode(mode) {
    this.mode = mode === 'assert' ? 'assert' : 'action';
    this.emit('mode', this.mode);
    for (const page of this.context ? this.context.pages() : []) {
      try {
        await page.evaluate((m) => window.__csSetMode && window.__csSetMode(m), this.mode);
      } catch { /* closed or navigating */ }
    }
  }

  async stop() {
    this.active = false;
    const steps = this.steps.slice();
    try {
      if (this.browser) await this.browser.close();
    } catch { /* already closed */ }
    return steps;
  }

  _onClosed() {
    if (!this.active) return;
    this.active = false;
    this.emit('closed');
  }
}

module.exports = { RecorderSession };
