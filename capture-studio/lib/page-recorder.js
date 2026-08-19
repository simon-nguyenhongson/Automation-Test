// Injected into every recorded page via context.addInitScript.
// Captures user actions, builds a stable selector, and reports each step
// through the exposed binding window.__csRecord(step).
//
// Assert mode covers the page with a transparent glass pane so that clicking
// any element — including disabled controls, which never emit click events —
// opens a picker listing checks read from the element's live state.
(() => {
  if (window.__csInstalled) return;
  window.__csInstalled = true;

  let mode = 'action'; // 'action' | 'assert'

  const send = (step) => {
    try { window.__csRecord(step); } catch { /* binding gone — session ended */ }
  };

  /* ---------------- selector engine ---------------- */

  const cssEsc = (v) =>
    window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  const attrEsc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const unique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };

  function bySpecialAttr(el) {
    for (const a of ['data-testid', 'data-test', 'data-qa']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) {
        const s = `[${a}="${attrEsc(v)}"]`;
        if (unique(s)) return s;
      }
    }
    return null;
  }

  // Framework-generated ids change on every render — never anchor on them.
  // Covers React useId (":r0:", "_R_3idahlek5_"), Radix, Headless UI, MUI,
  // and anything carrying a long digit run.
  function isGeneratedId(id) {
    return (
      /^_?[rR]_[\w-]+_?$/.test(id) ||
      /:/.test(id) ||
      /^(radix|headlessui|react-aria|mui|downshift|floating-ui|ember|aria)[-_:]/i.test(id) ||
      /\d{4,}/.test(id)
    );
  }

  function byId(el) {
    if (!el.id || isGeneratedId(el.id)) return null;
    const s = '#' + cssEsc(el.id);
    return unique(s) ? s : null;
  }

  function byName(el) {
    const v = el.getAttribute && el.getAttribute('name');
    if (!v) return null;
    const s = `${el.tagName.toLowerCase()}[name="${attrEsc(v)}"]`;
    return unique(s) ? s : null;
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

  function cssPath(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n.tagName !== 'HTML') {
      const anchor = bySpecialAttr(n) || byId(n);
      if (anchor) {
        parts.unshift(anchor);
        break;
      }
      parts.unshift(segment(n));
      if (unique(parts.join(' > '))) break;
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  function buildSelector(el) {
    return bySpecialAttr(el) || byId(el) || byName(el) || cssPath(el);
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

  /* ---------------- overlay: banner, hover box, glass, picker ---------------- */

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
      const el = elementAt(e.clientX, e.clientY);
      if (el) moveHoverBox(actionTarget(el));
    });
    glass.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = elementAt(e.clientX, e.clientY);
      closePicker();
      if (el) openPicker(actionTarget(el), e.clientX, e.clientY);
    });

    // Floating toolbar — lives in the recorded page so the mode switch is
    // where the user's hands already are.
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

  function elementAt(x, y) {
    if (!glass) return null;
    glass.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    glass.style.pointerEvents = 'auto';
    if (!el || el === glass || el === banner || el === hoverBox) return null;
    if (picker && picker.contains(el)) return null;
    if (toolbar && toolbar.contains(el)) return null;
    return el instanceof Element ? el : null;
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

  function moveHoverBox(el) {
    ensureOverlay();
    if (!hoverBox || !el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    Object.assign(hoverBox.style, {
      display: 'block',
      left: r.left - 2 + 'px',
      top: r.top - 2 + 'px',
      width: r.width + 'px',
      height: r.height + 'px',
    });
  }

  function flash(el) {
    ensureOverlay();
    if (!hoverBox) return;
    moveHoverBox(el);
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
      maxWidth: '280px',
    });
    return h;
  }

  function pickerDivider() {
    const d = document.createElement('div');
    Object.assign(d.style, { height: '1px', background: '#EAECF0', margin: '4px 0' });
    return d;
  }

  const mono = (s) =>
    `<span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#667085">${s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')}</span>`;
  const current = '<span style="color:#17B26A;font-weight:500"> · hiện tại</span>';

  function openPicker(el, x, y) {
    ensureOverlay();
    const selector = buildSelector(el);
    const label = labelOf(el);
    const st = readState(el);

    picker = document.createElement('div');
    picker.setAttribute('data-cs-picker', '');
    Object.assign(picker.style, {
      position: 'fixed',
      zIndex: Z_TOP,
      minWidth: '240px',
      maxWidth: '320px',
      background: '#FFFFFF',
      border: '1px solid #EAECF0',
      borderRadius: '8px',
      boxShadow: '0px 4px 8px -2px rgba(16,24,40,0.10), 0px 2px 4px -2px rgba(16,24,40,0.06)',
      padding: '6px',
    });

    const done = (step) => {
      send(Object.assign({ selector, label }, step));
      flash(el);
      closePicker();
    };

    picker.appendChild(pickerHeader(shorten(label || selector, 40)));

    picker.appendChild(pickerItem('Hiển thị trên trang', () => done({ action: 'assert-visible' })));
    picker.appendChild(
      pickerItem('Đang bật — bấm được' + (st.disabled ? '' : current), () => done({ action: 'assert-enabled' }))
    );
    picker.appendChild(
      pickerItem('Bị vô hiệu — disabled' + (st.disabled ? current : ''), () => done({ action: 'assert-disabled' }))
    );
    if (st.checked !== null) {
      picker.appendChild(
        pickerItem('Đã tích' + (st.checked ? current : ''), () => done({ action: 'assert-checked' }))
      );
      picker.appendChild(
        pickerItem('Chưa tích' + (st.checked ? '' : current), () => done({ action: 'assert-unchecked' }))
      );
    }
    if (st.text) {
      picker.appendChild(
        pickerItem(`Văn bản: ${mono('"' + shorten(st.text, 32) + '"')}`, () =>
          done({ action: 'assert-text', text: st.text })
        )
      );
    }
    if (st.value !== null) {
      picker.appendChild(
        pickerItem(`Giá trị: ${mono('"' + shorten(st.value, 32) + '"')}`, () =>
          done({ action: 'assert-value', value: st.value })
        )
      );
    }
    picker.appendChild(pickerDivider());
    picker.appendChild(pickerItem('Di chuột tới phần tử — hover', () => done({ action: 'hover' })));

    document.documentElement.appendChild(picker);
    const w = picker.offsetWidth;
    const h = picker.offsetHeight;
    picker.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    picker.style.top = Math.max(8, Math.min(y + 8, window.innerHeight - h - 8)) + 'px';
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
