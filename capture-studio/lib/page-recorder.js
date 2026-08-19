// Injected into every recorded page (and every frame) via context.addInitScript.
// Captures user actions, builds a stable selector, and reports each step
// through the exposed binding window.__csRecord(step).
//
// Overlay UI (toolbar, glass pane, picker) lives only in the top window.
// Steps recorded inside same-origin iframes carry a `frames` chain of iframe
// selectors; cross-origin frames fall back to `frameUrl`.
(() => {
  if (window.__csInstalled) return;
  window.__csInstalled = true;

  const topWin = window === window.top;
  let mode = 'action'; // 'action' | 'assert'

  /* ---------------- frame context ---------------- */

  let frameInfoCache;
  function frameInfo() {
    if (frameInfoCache !== undefined) return frameInfoCache;
    if (topWin) return (frameInfoCache = null);
    try {
      const chain = [];
      let w = window;
      while (w !== w.top) {
        const fe = w.frameElement; // throws when the parent is cross-origin
        if (!fe) return (frameInfoCache = { frameUrl: location.href });
        chain.unshift(buildSelector(fe, fe.ownerDocument));
        w = w.parent;
      }
      frameInfoCache = { frames: chain };
    } catch {
      frameInfoCache = { frameUrl: location.href };
    }
    return frameInfoCache;
  }

  const send = (step) => {
    const fi = frameInfo();
    if (fi && !step.frames && !step.frameUrl) Object.assign(step, fi);
    try { window.__csRecord(step); } catch { /* binding gone — session ended */ }
  };

  /* ---------------- selector engine (document-scoped) ---------------- */

  const cssEsc = (v) =>
    window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  const attrEsc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const unique = (sel, doc) => {
    try { return doc.querySelectorAll(sel).length === 1; } catch { return false; }
  };

  // Framework-generated ids change on every render — never anchor on them.
  function isGeneratedId(id) {
    return (
      /^_?[rR]_[\w-]+_?$/.test(id) ||
      /:/.test(id) ||
      /^(radix|headlessui|react-aria|mui|downshift|floating-ui|ember|aria)[-_:]/i.test(id) ||
      /\d{4,}/.test(id)
    );
  }

  function bySpecialAttr(el, doc) {
    for (const a of ['data-testid', 'data-test', 'data-qa']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) {
        const s = `[${a}="${attrEsc(v)}"]`;
        if (unique(s, doc)) return s;
      }
    }
    return null;
  }

  function byId(el, doc) {
    if (!el.id || isGeneratedId(el.id)) return null;
    const s = '#' + cssEsc(el.id);
    return unique(s, doc) ? s : null;
  }

  function byName(el, doc) {
    const v = el.getAttribute && el.getAttribute('name');
    if (!v) return null;
    const s = `${el.tagName.toLowerCase()}[name="${attrEsc(v)}"]`;
    return unique(s, doc) ? s : null;
  }

  function segment(el) {
    let seg = el.tagName.toLowerCase();
    const p = el.parentElement;
    if (p) {
      const same = Array.from(p.children).filter((c) => c.tagName === el.tagName);
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return seg;
  }

  function cssPath(el, doc) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n.tagName !== 'HTML') {
      const anchor = bySpecialAttr(n, doc) || byId(n, doc);
      if (anchor) {
        parts.unshift(anchor);
        break;
      }
      parts.unshift(segment(n));
      if (unique(parts.join(' > '), doc)) break;
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  function buildSelector(el, doc) {
    doc = doc || el.ownerDocument || document;
    return bySpecialAttr(el, doc) || byId(el, doc) || byName(el, doc) || cssPath(el, doc);
  }

  /* ---------------- labels & state ---------------- */

  function labelOf(el) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return (
        el.getAttribute('placeholder') ||
        el.getAttribute('aria-label') ||
        el.getAttribute('name') ||
        el.getAttribute('type') ||
        tag.toLowerCase()
      );
    }
    const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
    if (t) return t.slice(0, 60);
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      tag.toLowerCase()
    );
  }

  function readState(el) {
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    let disabled = false;
    try {
      disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.matches(':disabled'));
    } catch { /* :disabled unsupported on this node */ }
    const isCheck = tag === 'INPUT' && (type === 'checkbox' || type === 'radio');
    const isForm = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return {
      disabled,
      text: text || null,
      value: isForm && !isCheck ? String(el.value != null ? el.value : '') : null,
      checked: isCheck ? !!el.checked : null,
    };
  }

  /* ---------------- target normalisation ---------------- */

  const INTERACTIVE =
    'button, a[href], input, select, textarea, label, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
    '[role="option"], [role="checkbox"], [contenteditable="true"]';

  function actionTarget(raw) {
    let el = raw;
    for (let i = 0; el && i < 4; i++) {
      if (el.matches && el.matches(INTERACTIVE)) return el;
      el = el.parentElement;
    }
    return raw;
  }

  const TEXT_INPUT_TYPES = /^(text|search|email|url|tel|password|number|date|time|datetime-local|month|week)$/;

  function isTextEntry(el) {
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
    if (el.tagName !== 'INPUT') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.test(type);
  }

  /* ---------------- overlay (top window only) ---------------- */

  const Z_GLASS = 2147483644;
  const Z_BOX = 2147483646;
  const Z_TOP = 2147483647;
  const FONT = '12px/18px Inter, -apple-system, sans-serif';

  let hoverBox = null;
  let banner = null;
  let glass = null;
  let picker = null;
  let toolbar = null;
  let btnAction = null;
  let btnAssert = null;

  function ensureOverlay() {
    if (!topWin) return;
    if (hoverBox || !document.documentElement) return;
    hoverBox = document.createElement('div');
    Object.assign(hoverBox.style, {
      position: 'fixed',
      zIndex: Z_BOX,
      pointerEvents: 'none',
      border: '2px solid #155EEF',
      borderRadius: '4px',
      background: 'rgba(21, 94, 239, 0.08)',
      display: 'none',
    });

    banner = document.createElement('div');
    banner.textContent = 'Chế độ kiểm tra — bấm vào phần tử để chọn bước kiểm tra';
    Object.assign(banner.style, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: Z_TOP,
      pointerEvents: 'none',
      background: '#101828',
      color: '#FFFFFF',
      font: '500 ' + FONT,
      padding: '6px 12px',
      borderRadius: '8px',
      display: 'none',
      boxShadow: '0px 4px 8px -2px rgba(16, 24, 40, 0.10)',
    });

    glass = document.createElement('div');
    Object.assign(glass.style, {
      position: 'fixed',
      inset: '0',
      zIndex: Z_GLASS,
      display: 'none',
      cursor: 'crosshair',
      background: 'transparent',
    });
    glass.addEventListener('mousemove', (e) => {
      const hit = deepElementAt(e.clientX, e.clientY);
      if (hit) moveHoverBox(actionTarget(hit.el), hit.ox, hit.oy);
    });
    glass.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hit = deepElementAt(e.clientX, e.clientY);
      closePicker();
      if (hit) openPicker({ ...hit, el: actionTarget(hit.el) }, e.clientX, e.clientY);
    });

    // Floating toolbar — the mode switch lives where the user's hands are.
    toolbar = document.createElement('div');
    toolbar.setAttribute('data-cs-toolbar', '');
    Object.assign(toolbar.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      zIndex: Z_TOP,
      display: 'flex',
      alignItems: 'center',
      gap: '2px',
      background: '#FFFFFF',
      border: '1px solid #EAECF0',
      borderRadius: '8px',
      boxShadow: '0px 12px 16px -4px rgba(16,24,40,0.08), 0px 4px 6px -2px rgba(16,24,40,0.03)',
      padding: '4px',
    });
    const dot = document.createElement('span');
    Object.assign(dot.style, {
      width: '8px',
      height: '8px',
      borderRadius: '9999px',
      background: '#F04438',
      margin: '0 8px',
      flex: 'none',
    });
    const mkBtn = (label, m) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.type = 'button';
      Object.assign(b.style, {
        font: '500 ' + FONT,
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid transparent',
        cursor: 'pointer',
        background: '#FFFFFF',
        color: '#344054',
      });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        requestMode(m);
      });
      return b;
    };
    btnAction = mkBtn('Thao tác', 'action');
    btnAssert = mkBtn('Kiểm tra', 'assert');
    toolbar.appendChild(dot);
    toolbar.appendChild(btnAction);
    toolbar.appendChild(btnAssert);

    document.documentElement.appendChild(glass);
    document.documentElement.appendChild(hoverBox);
    document.documentElement.appendChild(banner);
    document.documentElement.appendChild(toolbar);
  }

  function styleModeBtn(b, active) {
    b.style.background = active ? '#EFF4FF' : '#FFFFFF';
    b.style.color = active ? '#004EEB' : '#344054';
    b.style.borderColor = active ? '#B2CCFF' : 'transparent';
  }

  function requestMode(m) {
    mode = m === 'assert' ? 'assert' : 'action';
    updateOverlay();
    try {
      if (window.__csModeRequest) window.__csModeRequest(mode);
    } catch { /* binding gone */ }
  }

  /** Element under the glass, descending into same-origin iframes.
      Returns { el, doc, frames, ox, oy } — ox/oy are the viewport offsets of
      the containing frame, for positioning top-window overlays. */
  function deepElementAt(x, y) {
    if (!glass) return null;
    glass.style.pointerEvents = 'none';
    let el = document.elementFromPoint(x, y);
    glass.style.pointerEvents = 'auto';
    if (!el || el === glass || el === banner || el === hoverBox) return null;
    if (picker && picker.contains(el)) return null;
    if (toolbar && toolbar.contains(el)) return null;

    let doc = document;
    const frames = [];
    let ox = 0;
    let oy = 0;
    let px = x;
    let py = y;
    while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
      let innerDoc = null;
      try { innerDoc = el.contentDocument; } catch { innerDoc = null; }
      if (!innerDoc) break; // cross-origin — assert on the iframe element itself
      frames.push(buildSelector(el, doc));
      const r = el.getBoundingClientRect();
      ox += r.left;
      oy += r.top;
      px -= r.left;
      py -= r.top;
      doc = innerDoc;
      el = doc.elementFromPoint(px, py);
    }
    // Nodes from iframe documents live in another realm — instanceof Element
    // against this window's constructor is always false there.
    if (!el || el.nodeType !== 1) return null;
    return { el, doc, frames, ox, oy };
  }

  function updateOverlay() {
    ensureOverlay();
    if (!banner) return;
    const on = mode === 'assert';
    banner.style.display = on ? 'block' : 'none';
    glass.style.display = on ? 'block' : 'none';
    styleModeBtn(btnAction, !on);
    styleModeBtn(btnAssert, on);
    if (!on) {
      if (hoverBox) hoverBox.style.display = 'none';
      closePicker();
    }
  }

  function moveHoverBox(el, ox = 0, oy = 0) {
    ensureOverlay();
    if (!hoverBox || !el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    Object.assign(hoverBox.style, {
      display: 'block',
      left: r.left + ox - 2 + 'px',
      top: r.top + oy - 2 + 'px',
      width: r.width + 'px',
      height: r.height + 'px',
    });
  }

  function flash(el, ox = 0, oy = 0) {
    ensureOverlay();
    if (!hoverBox) return;
    moveHoverBox(el, ox, oy);
    hoverBox.style.borderColor = 'rgb(23, 178, 106)';
    setTimeout(() => { hoverBox.style.borderColor = '#155EEF'; }, 400);
  }

  /* ---------------- assertion picker ---------------- */

  function closePicker() {
    if (picker) {
      picker.remove();
      picker = null;
    }
  }

  const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function pickerItem(labelHtml, onPick) {
    const item = document.createElement('div');
    item.innerHTML = labelHtml;
    Object.assign(item.style, {
      padding: '7px 10px',
      borderRadius: '6px',
      cursor: 'pointer',
      font: '400 ' + FONT,
      color: '#101828',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
    item.addEventListener('mouseenter', () => (item.style.background = '#F9FAFB'));
    item.addEventListener('mouseleave', () => (item.style.background = 'transparent'));
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPick();
    });
    return item;
  }

  function pickerHeader(text) {
    const h = document.createElement('div');
    h.textContent = text;
    Object.assign(h.style, {
      padding: '4px 10px 6px',
      font: '600 11px/16px Inter, -apple-system, sans-serif',
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: '#667085',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: '300px',
    });
    return h;
  }

  function pickerDivider() {
    const d = document.createElement('div');
    Object.assign(d.style, { height: '1px', background: '#EAECF0', margin: '4px 0' });
    return d;
  }

  const mono = (s) =>
    `<span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#667085">${String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')}</span>`;
  const current = '<span style="color:#17B26A;font-weight:500"> · hiện tại</span>';

  function positionPicker(x, y) {
    const w = picker.offsetWidth;
    const h = picker.offsetHeight;
    picker.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    picker.style.top = Math.max(8, Math.min(y + 8, window.innerHeight - h - 8)) + 'px';
  }

  function openPicker(ctx, x, y) {
    ensureOverlay();
    const { el, doc, frames, ox, oy } = ctx;
    const selector = buildSelector(el, doc);
    const label = labelOf(el);
    const st = readState(el);
    const frameExtra = frames && frames.length ? { frames } : {};

    picker = document.createElement('div');
    picker.setAttribute('data-cs-picker', '');
    Object.assign(picker.style, {
      position: 'fixed',
      zIndex: Z_TOP,
      minWidth: '250px',
      maxWidth: '330px',
      maxHeight: '70vh',
      overflowY: 'auto',
      background: '#FFFFFF',
      border: '1px solid #EAECF0',
      borderRadius: '8px',
      boxShadow: '0px 4px 8px -2px rgba(16,24,40,0.10), 0px 2px 4px -2px rgba(16,24,40,0.06)',
      padding: '6px',
    });
    document.documentElement.appendChild(picker);

    const done = (step, withSelector = true) => {
      const base = withSelector ? { selector, label, ...frameExtra } : {};
      send(Object.assign(base, step));
      flash(el, ox, oy);
      closePicker();
    };

    const renderMain = () => {
      picker.innerHTML = '';
      picker.appendChild(pickerHeader(shorten(label || selector, 42)));

      picker.appendChild(pickerItem('Hiển thị trên trang', () => done({ action: 'assert-visible' })));
      picker.appendChild(
        pickerItem('Đang bật — bấm được' + (st.disabled ? '' : current), () => done({ action: 'assert-enabled' }))
      );
      picker.appendChild(
        pickerItem('Bị vô hiệu — disabled' + (st.disabled ? current : ''), () => done({ action: 'assert-disabled' }))
      );
      if (st.checked !== null) {
        picker.appendChild(pickerItem('Đã tích' + (st.checked ? current : ''), () => done({ action: 'assert-checked' })));
        picker.appendChild(pickerItem('Chưa tích' + (st.checked ? '' : current), () => done({ action: 'assert-unchecked' })));
      }
      if (st.text) {
        picker.appendChild(
          pickerItem(`Văn bản: ${mono('"' + shorten(st.text, 32) + '"')}`, () => done({ action: 'assert-text', text: st.text }))
        );
        picker.appendChild(
          pickerItem('Không chứa văn bản này', () => done({ action: 'assert-not-text', text: st.text }))
        );
      }
      if (st.value !== null) {
        picker.appendChild(
          pickerItem(`Giá trị: ${mono('"' + shorten(st.value, 32) + '"')}`, () =>
            done({ action: 'assert-value', value: st.value })
          )
        );
      }
      if (el.tagName === 'SELECT') {
        let selLabel = '';
        try {
          const opt = el.selectedOptions && el.selectedOptions[0];
          selLabel = String((opt && (opt.label || opt.text)) || '').trim();
        } catch { selLabel = ''; }
        if (selLabel) {
          picker.appendChild(
            pickerItem(`Lựa chọn hiển thị: ${mono('"' + shorten(selLabel, 30) + '"')}`, () =>
              done({ action: 'assert-selected', text: selLabel })
            )
          );
        }
      }
      picker.appendChild(pickerItem('Tự nhập giá trị kiểm tra …', renderCustom));

      // element count for this selector
      let count = 0;
      try { count = doc.querySelectorAll(selector).length; } catch { count = 0; }
      if (count) {
        picker.appendChild(
          pickerItem(`Số phần tử khớp selector: ${mono(String(count))}`, () =>
            done({ action: 'assert-count', count })
          )
        );
      }

      const attrs = attrList();
      if (attrs.length) {
        picker.appendChild(pickerItem('Thuộc tính của phần tử …', renderAttrs));
      }
      picker.appendChild(
        pickerItem('Cấu trúc cả vùng này — ARIA snapshot', () => done({ action: 'assert-aria' }))
      );

      picker.appendChild(pickerDivider());
      picker.appendChild(
        pickerItem(`Trang — URL chứa: ${mono(shorten(location.href, 30))}`, () =>
          done({ action: 'assert-url', text: location.href }, false)
        )
      );
      if (document.title) {
        picker.appendChild(
          pickerItem(`Trang — tiêu đề: ${mono('"' + shorten(document.title, 28) + '"')}`, () =>
            done({ action: 'assert-title', text: document.title }, false)
          )
        );
      }
      picker.appendChild(pickerDivider());
      picker.appendChild(pickerItem('Di chuột tới phần tử — hover', () => done({ action: 'hover' })));
      positionPicker(x, y);
    };

    const attrList = () =>
      Array.from(el.attributes || [])
        .filter((a) => a.name !== 'style' && a.value !== '' && a.value.length <= 200)
        .slice(0, 12);

    /** Type an expected value by hand instead of taking the current one. */
    const HINT = 'Dùng được cả tham số, ví dụ {{ma_kh}}.';
    const renderCustom = () => {
      picker.innerHTML = '';
      picker.appendChild(pickerHeader('Tự nhập giá trị kiểm tra'));
      picker.appendChild(pickerItem('‹ Quay lại', renderMain));

      const wrap = document.createElement('div');
      Object.assign(wrap.style, { padding: '4px 10px 8px' });

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Giá trị mong đợi — ví dụ ABC';
      input.value = st.value != null ? st.value : st.text || '';
      Object.assign(input.style, {
        width: '100%',
        boxSizing: 'border-box',
        font: '400 ' + FONT,
        color: '#101828',
        padding: '7px 10px',
        border: '1px solid #D0D5DD',
        borderRadius: '8px',
        background: '#FFFFFF',
        outline: 'none',
      });
      input.addEventListener('focus', () => {
        input.style.borderColor = '#84ADFF';
        input.style.boxShadow = '0 0 0 4px #EFF4FF';
      });
      input.addEventListener('blur', () => {
        input.style.borderColor = '#D0D5DD';
        input.style.boxShadow = 'none';
      });
      // The page must not see these keystrokes.
      const swallow = (e) => e.stopPropagation();
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          renderMain();
        }
      });
      input.addEventListener('keyup', swallow);
      input.addEventListener('keypress', swallow);
      input.addEventListener('input', () => {
        hint.textContent = HINT;
        hint.style.color = '#667085';
      });

      const hint = document.createElement('div');
      Object.assign(hint.style, {
        font: '400 11px/16px Inter, -apple-system, sans-serif',
        color: '#667085',
        padding: '6px 10px 2px',
      });
      hint.textContent = HINT;

      wrap.appendChild(input);
      picker.appendChild(wrap);
      picker.appendChild(hint);
      picker.appendChild(pickerDivider());

      let kind = el.tagName === 'SELECT' ? 'assert-selected' : st.value !== null ? 'assert-value' : 'assert-text';
      const choices = [];
      if (el.tagName === 'SELECT') choices.push(['assert-selected', 'Lựa chọn hiển thị đúng giá trị này']);
      if (st.value !== null) choices.push(['assert-value', 'Ô nhập có đúng giá trị này']);
      choices.push(['assert-text', 'Văn bản chứa giá trị này']);
      choices.push(['assert-not-text', 'Văn bản KHÔNG chứa giá trị này']);
      if (el.tagName !== 'SELECT' && st.value === null) {
        choices.push(['assert-value', 'Ô nhập có đúng giá trị này']);
      }

      const rows = [];
      const paint = () => {
        rows.forEach(([r, k]) => {
          const on = k === kind;
          r.style.background = on ? '#EFF4FF' : 'transparent';
          r.style.color = on ? '#004EEB' : '#101828';
          r.style.fontWeight = on ? '500' : '400';
        });
      };
      for (const [k, label] of choices) {
        const row = pickerItem(label, () => {
          kind = k;
          paint();
          submit();
        });
        rows.push([row, k]);
        picker.appendChild(row);
      }
      paint();

      const submit = () => {
        const v = input.value.trim();
        if (!v) {
          hint.textContent = 'Nhập giá trị trước khi chọn cách kiểm tra.';
          hint.style.color = '#B42318';
          input.focus();
          return;
        }
        if (kind === 'assert-value') done({ action: 'assert-value', value: v });
        else if (kind === 'assert-selected') done({ action: 'assert-selected', text: v });
        else done({ action: kind, text: v });
      };

      positionPicker(x, y);
      setTimeout(() => input.focus(), 0);
    };

    const renderAttrs = () => {
      picker.innerHTML = '';
      picker.appendChild(pickerHeader('Kiểm tra thuộc tính'));
      picker.appendChild(pickerItem('‹ Quay lại', renderMain));
      picker.appendChild(pickerDivider());
      for (const a of attrList()) {
        picker.appendChild(
          pickerItem(`${mono(a.name)} = ${mono('"' + shorten(a.value, 26) + '"')}`, () =>
            done({ action: 'assert-attr', name: a.name, value: a.value })
          )
        );
      }
      positionPicker(x, y);
    };

    renderMain();
  }

  window.__csSetMode = (m) => {
    mode = m === 'assert' ? 'assert' : 'action';
    updateOverlay();
  };

  /* ---------------- listeners ---------------- */

  window.addEventListener(
    'keydown',
    (e) => {
      if (mode === 'assert' && e.key === 'Escape' && picker) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closePicker();
        return;
      }
      if (mode !== 'action') return;
      if (e.key !== 'Enter') return;
      const el = e.target;
      if (el instanceof Element && el.tagName === 'INPUT') {
        send({ action: 'press', selector: buildSelector(el), key: 'Enter', label: labelOf(el) });
      }
    },
    true
  );

  window.addEventListener(
    'click',
    (e) => {
      const raw = e.composedPath ? e.composedPath()[0] : e.target;
      if (!(raw instanceof Element)) return;
      // Studio chrome (toolbar, picker) is never part of the recording.
      if (toolbar && toolbar.contains(raw)) return;
      if (picker && picker.contains(raw)) return;

      if (mode === 'assert') {
        // The glass pane owns assert-mode clicks; anything else that slips
        // through must not reach the page.
        if (raw === glass) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      const el = actionTarget(raw);
      const tag = el.tagName;
      const type = (el.getAttribute && (el.getAttribute('type') || '').toLowerCase()) || '';

      // Label clicks forward a second click event to their control — record that one.
      if (tag === 'LABEL' && el.control) return;

      if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
        // Read the state after the default action has applied.
        setTimeout(() => {
          const action = type === 'radio' || el.checked ? 'check' : 'uncheck';
          send({ action, selector: buildSelector(el), label: labelOf(el) });
        }, 0);
        return;
      }
      if (tag === 'SELECT') return; // the change event records the selection
      if (isTextEntry(el)) return; // focus clicks are noise — fill covers it

      send({ action: 'click', selector: buildSelector(el), label: labelOf(el) });
    },
    true
  );

  window.addEventListener(
    'dblclick',
    (e) => {
      if (mode !== 'action') return;
      const raw = e.composedPath ? e.composedPath()[0] : e.target;
      if (!(raw instanceof Element)) return;
      if (toolbar && toolbar.contains(raw)) return;
      const el = actionTarget(raw);
      const type = (el.getAttribute && (el.getAttribute('type') || '').toLowerCase()) || '';
      if (isTextEntry(el)) return; // double click in a field selects text — noise
      if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio'))) return;
      // The two single clicks were already recorded — the session merges them.
      send({ action: 'dblclick', selector: buildSelector(el), label: labelOf(el) });
    },
    true
  );

  window.addEventListener(
    'input',
    (e) => {
      if (mode !== 'action') return;
      const el = e.target;
      if (!(el instanceof Element)) return;
      if (el.tagName === 'SELECT') return;
      if (!isTextEntry(el)) return;
      const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
      send({
        action: 'fill',
        selector: buildSelector(el),
        value: el.isContentEditable ? el.innerText : el.value,
        secret: type === 'password',
        label: labelOf(el),
      });
    },
    true
  );

  window.addEventListener(
    'change',
    (e) => {
      if (mode !== 'action') return;
      const el = e.target;
      if (el instanceof Element && el.tagName === 'SELECT') {
        send({ action: 'select', selector: buildSelector(el), value: el.value, label: labelOf(el) });
      }
    },
    true
  );

  /* ---------------- boot ---------------- */

  const boot = () => {
    ensureOverlay();
    updateOverlay();
  };
  if (topWin) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
