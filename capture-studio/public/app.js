// Capture Studio front-end — vanilla JS over the SooBinZHongSon tokens.
import ICONS from './ds/icon-data.js';

/* ---------------- helpers ---------------- */

const $ = (sel) => document.querySelector(sel);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function icon(name, size = 16) {
  const d = ICONS[name];
  if (!d) return '';
  const body = d.body.replace(/<path[^>]*fill="rgb\(255,255,255\)"[^>]*\/>/, '');
  return `<svg class="ic" width="${size}" height="${size}" viewBox="${d.viewBox}" fill="currentColor" aria-hidden="true">${body}</svg>`;
}

const fmtNum = (n) => Number(n || 0).toLocaleString('vi-VN');
const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Lỗi ' + res.status);
  return data;
}

let alertTimer = null;
function notify(message, kind = 'info') {
  const slot = $('#alert-slot');
  slot.innerHTML = `<div class="alert alert-${kind}">${icon(
    kind === 'error' ? 'IconErrorFilled' : kind === 'success' ? 'IconCheckmarkFilled' : 'IconInformation'
  )}<span>${esc(message)}</span></div>`;
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => (slot.innerHTML = ''), 5000);
}

/* ---------------- state ---------------- */

const S = {
  view: 'list',
  tcs: [],
  selected: [], // ordered ids
  record: { active: false, url: '', mode: 'action', steps: [] },
  drawer: null, // { kind:'tc', tc, dirty, exportInfo } | { kind:'run', run }
  run: null, // live run: { tcId, name, runId, segments, results:{}, summary }
  runs: [], // persisted run history summaries
  runsFilter: '',
  batch: null, // { total, done, current }
};

const byId = (id) => S.tcs.find((t) => t.id === id);

/* ---------------- step metadata ---------------- */

const ACTION_META = {
  goto: { label: 'Mở trang', icon: 'IconLaunch' },
  click: { label: 'Bấm', icon: 'IconCursor1' },
  hover: { label: 'Di chuột', icon: 'IconArrowUpRight' },
  fill: { label: 'Nhập', icon: 'IconPen' },
  press: { label: 'Nhấn phím', icon: 'IconTerminal' },
  select: { label: 'Chọn', icon: 'IconCaretSort' },
  check: { label: 'Tích chọn', icon: 'IconCheckboxChecked' },
  uncheck: { label: 'Bỏ tích', icon: 'IconCheckbox' },
  'assert-visible': { label: 'Kiểm tra hiển thị', icon: 'IconView' },
  'assert-hidden': { label: 'Kiểm tra đã ẩn', icon: 'IconViewOff' },
  'assert-enabled': { label: 'Kiểm tra đang bật', icon: 'IconUnlocked' },
  'assert-disabled': { label: 'Kiểm tra bị vô hiệu', icon: 'IconLocked' },
  'assert-checked': { label: 'Kiểm tra đã tích', icon: 'IconCheckboxChecked' },
  'assert-unchecked': { label: 'Kiểm tra chưa tích', icon: 'IconCheckbox' },
  'assert-value': { label: 'Kiểm tra giá trị', icon: 'IconRule' },
  'assert-text': { label: 'Kiểm tra văn bản', icon: 'IconTextAlignLeft' },
};

/** The editable payload of a step, if any — drives the "Sửa bước" modal. */
function editableField(step) {
  switch (step.action) {
    case 'goto': return { key: 'url', label: 'URL' };
    case 'fill': return { key: 'value', label: 'Giá trị nhập' };
    case 'select': return { key: 'value', label: 'Giá trị chọn' };
    case 'press': return { key: 'key', label: 'Phím' };
    case 'assert-text': return { key: 'text', label: 'Văn bản mong đợi' };
    case 'assert-value': return { key: 'value', label: 'Giá trị mong đợi' };
    default: return null;
  }
}

function stepTitle(step) {
  const meta = ACTION_META[step.action] || { label: step.action };
  if (step.action === 'goto') return `<b>${meta.label}</b> <span class="muted">${esc(step.url)}</span>`;
  const target = step.label ? ` <span class="muted">${esc(step.label)}</span>` : '';
  return `<b>${meta.label}</b>${target}`;
}

function stepValueHtml(step) {
  if (step.action === 'fill') {
    const v = step.secret ? '••••••' : step.value;
    return `<span class="step-value truncate" title="${step.secret ? '' : esc(step.value)}">${esc(v)}</span>`;
  }
  if (step.action === 'select' || step.action === 'assert-value')
    return `<span class="step-value truncate" title="${esc(step.value)}">${esc(step.value)}</span>`;
  if (step.action === 'press') return `<span class="step-value">${esc(step.key)}</span>`;
  if (step.action === 'assert-text') return `<span class="step-value truncate" title="${esc(step.text)}">${esc(step.text)}</span>`;
  return '';
}

function stepRow(step, i, { tools = '', status = '', shot = null } = {}) {
  const meta = ACTION_META[step.action] || { icon: 'IconDotMark' };
  return `<div class="step-row ${status ? 'is-' + status : ''}" data-step-id="${esc(step.id)}">
    <span class="idx">${i + 1}</span>
    ${icon(meta.icon)}
    <div class="step-main">
      <div class="step-title">${stepTitle(step)}</div>
      ${step.selector ? `<div class="step-sel truncate" title="${esc(step.selector)}">${esc(step.selector)}</div>` : ''}
    </div>
    ${stepValueHtml(step)}
    ${shot ? `<a class="shot-link" href="${esc(shot)}" target="_blank" title="Mở evidence"><img src="${esc(shot)}" alt="Evidence bước ${i + 1}"></a>` : ''}
    ${status ? `<span class="step-status">${statusIcon(status)}</span>` : ''}
    ${tools ? `<span class="step-tools">${tools}</span>` : ''}
  </div>`;
}

function statusIcon(status) {
  if (status === 'running') return '<span class="spinner"></span>';
  if (status === 'passed') return `<span class="ok">${icon('IconCheckmarkFilled')}</span>`;
  if (status === 'failed') return `<span class="bad">${icon('IconErrorFilled')}</span>`;
  return '';
}

/* ---------------- nav ---------------- */

function renderNav() {
  $('#nav-list').innerHTML = `${icon('IconList')}<span>Test case</span><span class="count">${fmtNum(S.tcs.length)}</span>`;
  $('#nav-record').innerHTML = `${icon('IconDotMark')}<span>Phiên ghi</span>${
    S.record.active ? '<span class="count"><span class="rec-dot" style="display:inline-block"></span></span>' : ''
  }`;
  $('#nav-runs').innerHTML = `${icon('IconActivity')}<span>Kiểm thử</span><span class="count">${fmtNum(S.runs.length)}</span>`;
  $('#nav-list').classList.toggle('is-active', S.view === 'list');
  $('#nav-record').classList.toggle('is-active', S.view === 'record');
  $('#nav-runs').classList.toggle('is-active', S.view === 'runs');
}

/* ---------------- list view ---------------- */

function typeBadge(tc) {
  return tc.type === 'composite'
    ? `<span class="badge badge-blue">${icon('IconLayers', 12)}Tổng hợp</span>`
    : '<span class="badge badge-gray">Đơn</span>';
}

function lastRunBadge(tc) {
  if (!tc.lastRun) return '<span class="badge badge-gray">Chưa chạy</span>';
  const ok = tc.lastRun.status === 'passed';
  return `<span class="badge ${ok ? 'badge-success' : 'badge-error'}" title="${fmtDate(tc.lastRun.at)}">
    <span class="dot"></span>${ok ? 'Đạt' : 'Lỗi'} ${fmtNum(tc.lastRun.passed)}/${fmtNum(tc.lastRun.total)}</span>`;
}

function renderList() {
  const v = $('#view-list');
  if (!S.tcs.length) {
    v.innerHTML = `
      <div class="page-head">
        <div><h1>Test case</h1><div class="sub">Ghi thao tác trên giao diện thành test case, ghép nhiều test case con thành luồng lớn</div></div>
      </div>
      <div class="card"><div class="empty">
        <div class="line1">Chưa có test case</div>
        <div class="line2">Ghi test case đầu tiên để bắt đầu.</div>
        <button class="btn btn-primary btn-lg" data-act="new-record">${icon('IconAdd')}Ghi test case mới</button>
      </div></div>`;
    return;
  }

  const rows = S.tcs
    .map((tc) => {
      const checked = S.selected.includes(tc.id);
      const size = tc.type === 'composite' ? `${fmtNum((tc.children || []).length)} con` : `${fmtNum((tc.steps || []).length)} bước`;
      return `<tr class="${checked ? 'is-selected' : ''}">
        <td style="width:36px;text-align:center"><input type="checkbox" class="cbx" data-act="sel-tc" data-id="${tc.id}" ${checked ? 'checked' : ''}></td>
        <td><div class="cell-name truncate" data-act="open-tc" data-id="${tc.id}" title="${esc(tc.name)}">${esc(tc.name)}</div>
            ${tc.description ? `<div class="cell-sub truncate">${esc(tc.description)}</div>` : ''}</td>
        <td style="width:110px">${typeBadge(tc)}</td>
        <td style="width:90px" class="cell-num">${size}</td>
        <td style="width:150px">${lastRunBadge(tc)}</td>
        <td style="width:130px"><span class="muted" style="font-size:12px">${fmtDate(tc.updatedAt)}</span></td>
        <td class="cell-actions" style="width:120px">
          <button class="btn btn-secondary btn-sm" data-act="run-tc" data-id="${tc.id}">${icon('IconPlay', 12)}Chạy</button>
        </td>
      </tr>`;
    })
    .join('');

  const selBar = S.selected.length
    ? `<div class="select-bar">
        <span>Đã chọn ${fmtNum(S.selected.length)} test case</span>
        <div class="actions">
          <button class="btn btn-ghost btn-sm" data-act="clear-sel">Bỏ chọn</button>
          <button class="btn btn-secondary btn-sm" data-act="run-batch">${icon('IconPlay', 12)}Chạy các mục đã chọn</button>
          <button class="btn btn-primary btn-sm" data-act="open-compose">${icon('IconLayers', 12)}Tạo test case tổng hợp</button>
        </div>
      </div>`
    : '';

  v.innerHTML = `
    <div class="page-head">
      <div><h1>Test case</h1><div class="sub">${fmtNum(S.tcs.length)} test case · chọn nhiều dòng để ghép thành test case tổng hợp</div></div>
      <div class="actions">
        <button class="btn btn-primary btn-lg" data-act="new-record">${icon('IconAdd')}Ghi test case mới</button>
      </div>
    </div>
    ${selBar}
    <div class="tbl-card"><table class="tbl">
      <thead><tr>
        <th style="text-align:center"><input type="checkbox" class="cbx" data-act="sel-all" ${S.selected.length === S.tcs.length ? 'checked' : ''}></th>
        <th>Tên</th><th>Loại</th><th style="text-align:right">Quy mô</th><th>Lần chạy cuối</th><th>Cập nhật</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/* ---------------- runs (testing) view ---------------- */

const fmtDur = (ms) => (Math.round(ms / 100) / 10).toLocaleString('vi-VN') + ' giây';

function runStatusBadge(r) {
  const ok = r.status === 'passed';
  return `<span class="badge ${ok ? 'badge-success' : 'badge-error'}"><span class="dot"></span>${ok ? 'Đạt' : 'Lỗi'}</span>`;
}

function renderRuns() {
  const v = $('#view-runs');

  const batchBar = S.batch
    ? `<div class="batch-bar"><span class="spinner"></span>
        <span>Đang chạy đợt kiểm thử — ${fmtNum(S.batch.done)}/${fmtNum(S.batch.total)}${
        S.batch.current ? ' · ' + esc(S.batch.current) : ''
      }</span></div>`
    : '';

  const names = [...new Set(S.runs.map((r) => r.tcName))];
  const filtered = S.runsFilter ? S.runs.filter((r) => r.tcName === S.runsFilter) : S.runs;

  if (!S.runs.length) {
    v.innerHTML = `
      <div class="page-head">
        <div><h1>Kiểm thử</h1><div class="sub">Lịch sử các lượt chạy — evidence chụp sau từng bước</div></div>
      </div>
      ${batchBar}
      <div class="card"><div class="empty">
        <div class="line1">Chưa có lượt chạy nào</div>
        <div class="line2">Chạy một test case để bắt đầu.</div>
      </div></div>`;
    return;
  }

  const rows = filtered
    .map((r) => {
      const tcExists = !!byId(r.tcId);
      return `<tr>
        <td style="width:140px"><span class="muted" style="font-size:12px">${fmtDate(r.startedAt)}</span></td>
        <td><div class="cell-name truncate" data-act="open-run" data-id="${r.runId}" title="${esc(r.tcName)}">${esc(r.tcName)}</div>
            <div class="cell-sub mono">${r.runId}${r.headless ? ' · chạy ẩn' : ''}</div></td>
        <td style="width:90px">${runStatusBadge(r)}</td>
        <td style="width:110px" class="cell-num">${fmtNum(r.passed)}/${fmtNum(r.total)} bước</td>
        <td style="width:100px" class="cell-num">${fmtDur(r.durationMs)}</td>
        <td class="cell-actions" style="width:190px">
          <button class="btn btn-secondary btn-sm" data-act="open-run" data-id="${r.runId}">${icon('IconView', 12)}Xem</button>
          <button class="btn btn-secondary btn-sm" data-act="rerun" data-id="${r.tcId}" ${tcExists ? '' : 'disabled title="Test case đã bị xoá"'}>${icon('IconRenew', 12)}Chạy lại</button>
        </td>
      </tr>`;
    })
    .join('');

  v.innerHTML = `
    <div class="page-head">
      <div><h1>Kiểm thử</h1><div class="sub">${fmtNum(S.runs.length)} lượt chạy — evidence chụp sau từng bước, xem lại bất kỳ lúc nào</div></div>
      <div class="actions">
        <select class="field" style="height:32px;padding:4px 12px;width:260px" data-act="runs-filter">
          <option value="">Tất cả test case</option>
          ${names.map((n) => `<option value="${esc(n)}" ${S.runsFilter === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
        </select>
      </div>
    </div>
    ${batchBar}
    <div class="tbl-card"><table class="tbl">
      <thead><tr>
        <th>Thời gian</th><th>Test case</th><th>Kết quả</th><th style="text-align:right">Bước đạt</th><th style="text-align:right">Thời lượng</th><th></th>
      </tr></thead>
      <tbody>${rows || ''}</tbody>
    </table></div>
    ${!filtered.length ? '<div class="empty"><div class="line1">Không có lượt chạy khớp bộ lọc</div><div class="line2">Chọn test case khác trong bộ lọc.</div></div>' : ''}`;
}

async function refreshRuns() {
  S.runs = await api('GET', '/api/runs');
}

/* ---------------- record view ---------------- */

function renderRecord() {
  const v = $('#view-record');
  if (!S.record.active) {
    v.innerHTML = `
      <div class="page-head">
        <div><h1>Phiên ghi</h1><div class="sub">Mở trang cần kiểm thử, thao tác trên đó — mỗi thao tác thành một bước của test case</div></div>
      </div>
      <div class="card" style="max-width:560px">
        <div class="card-head"><span class="title">Bắt đầu phiên ghi</span><span class="caption">chromium</span></div>
        <div class="card-body">
          <div class="field-row">
            <label class="field-label" for="rec-url">URL trang cần ghi</label>
            <input class="field" id="rec-url" placeholder="Nhập URL bắt đầu bằng https://" value="${esc(S.record.url)}" />
            <span class="field-hint">Trình duyệt Chromium sẽ mở ra. Thao tác trong đó được ghi lại tại đây.</span>
          </div>
          <button class="btn btn-primary btn-lg" data-act="start-record">${icon('IconPlay')}Bắt đầu ghi</button>
        </div>
      </div>`;
    return;
  }

  const steps = S.record.steps
    .map((s, i) =>
      stepRow(s, i, {
        tools: `<button class="x-btn" data-act="del-live-step" data-i="${i}" title="Xoá bước">${icon('IconClose', 12)}</button>`,
      })
    )
    .join('');

  v.innerHTML = `
    <div class="page-head">
      <div><h1>Phiên ghi</h1><div class="sub">Thao tác trong cửa sổ Chromium — các bước hiện ở đây ngay khi ghi được</div></div>
    </div>
    <div class="record-bar">
      <span class="rec-dot"></span>
      <span class="badge badge-rec">Đang ghi</span>
      <span class="url truncate" title="${esc(S.record.url)}">${esc(S.record.url)}</span>
      <div class="actions">
        <label class="toggle" title="Bật để bấm vào phần tử trên trang và thêm bước kiểm tra">
          <input type="checkbox" data-act="toggle-assert" ${S.record.mode === 'assert' ? 'checked' : ''}>
          <span class="track"></span>
          <span class="toggle-label">Chế độ kiểm tra</span>
        </label>
        <button class="btn btn-secondary" data-act="cancel-record">Huỷ phiên ghi</button>
        <button class="btn btn-primary" data-act="stop-save" ${S.record.steps.length ? '' : 'disabled'}>${icon('IconStopFilled')}Dừng và lưu</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><span class="title">Các bước đã ghi</span><span class="caption">${fmtNum(S.record.steps.length)} bước</span></div>
      ${
        S.record.steps.length
          ? `<div class="steps">${steps}</div>`
          : `<div class="empty"><div class="line1">Chưa có bước nào</div><div class="line2">Thao tác trong cửa sổ Chromium để ghi bước đầu tiên.</div></div>`
      }
    </div>`;
}

/* ---------------- drawer ---------------- */

function openDrawer(tcId) {
  const tc = byId(tcId);
  if (!tc) return;
  S.drawer = { kind: 'tc', tc: JSON.parse(JSON.stringify(tc)), dirty: false, exportInfo: null };
  renderDrawer();
}

async function openRunDrawer(runId) {
  try {
    const run = await api('GET', '/api/runs/' + runId);
    S.drawer = { kind: 'run', run };
    renderDrawer();
  } catch (err) {
    notify(err.message, 'error');
  }
}

function closeDrawer() {
  S.drawer = null;
  S.run = null;
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

function renderDrawer() {
  const d = S.drawer;
  if (!d) return;
  if (d.kind === 'run') return renderRunDrawer();
  const tc = d.tc;
  $('#scrim').hidden = false;
  $('#drawer').hidden = false;

  let body = '';

  if (S.run && S.run.tcId === tc.id) {
    body = renderRunPanel();
  } else if (tc.type === 'atomic') {
    const steps = (tc.steps || [])
      .map((s, i) =>
        stepRow(s, i, {
          tools: `
            <button class="x-btn" data-act="edit-step" data-i="${i}" title="Sửa bước">${icon('IconEdit', 12)}</button>
            <button class="x-btn" data-act="step-up" data-i="${i}" title="Chuyển lên">${icon('IconArrowUp', 12)}</button>
            <button class="x-btn" data-act="step-down" data-i="${i}" title="Chuyển xuống">${icon('IconArrowDown', 12)}</button>
            <button class="x-btn" data-act="step-del" data-i="${i}" title="Xoá bước">${icon('IconClose', 12)}</button>`,
        })
      )
      .join('');
    body = `
      ${drawerInfoFields(tc)}
      <div class="card" style="box-shadow:none">
        <div class="card-head"><span class="title">Các bước</span><span class="caption">${fmtNum((tc.steps || []).length)} bước</span></div>
        <div class="steps">${steps || ''}</div>
        ${!(tc.steps || []).length ? '<div class="empty"><div class="line1">Chưa có bước nào</div><div class="line2">Ghi lại test case này để thêm bước.</div></div>' : ''}
      </div>`;
  } else {
    const children = (tc.children || [])
      .map((cid, i) => {
        const c = byId(cid);
        return `<div class="child-row">
          <span class="idx mono muted">${i + 1}</span>
          ${icon(c && c.type === 'composite' ? 'IconLayers' : 'IconDocument')}
          <span class="name">${esc(c ? c.name : cid + ' (đã xoá)')}</span>
          ${c ? `<span class="muted" style="font-size:12px">${c.type === 'composite' ? fmtNum((c.children || []).length) + ' con' : fmtNum((c.steps || []).length) + ' bước'}</span>` : ''}
          <span class="tools">
            <button class="x-btn" data-act="child-up" data-i="${i}" title="Chuyển lên">${icon('IconArrowUp', 12)}</button>
            <button class="x-btn" data-act="child-down" data-i="${i}" title="Chuyển xuống">${icon('IconArrowDown', 12)}</button>
            <button class="x-btn" data-act="child-remove" data-i="${i}" title="Gỡ khỏi test case">${icon('IconClose', 12)}</button>
          </span>
        </div>`;
      })
      .join('');
    const addable = S.tcs.filter((t) => t.id !== tc.id);
    body = `
      ${drawerInfoFields(tc)}
      <div class="field-row">
        <label class="field-label">Các test case con — chạy nối tiếp theo thứ tự</label>
        ${children || '<div class="muted" style="font-size:13px;padding:8px 0">Chưa có test case con.</div>'}
        <select class="field" data-act="child-add">
          <option value="">Thêm test case con</option>
          ${addable.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
        </select>
      </div>`;
  }

  if (d.exportInfo) {
    body += `
      <div class="card" style="box-shadow:none;margin-top:16px">
        <div class="card-head"><span class="title">Mã Playwright</span><span class="caption">${esc(d.exportInfo.file)}</span>
          <button class="btn btn-ghost btn-sm" data-act="copy-code" style="margin-left:8px">${icon('IconCopy', 12)}Copy</button></div>
        <div class="card-body" style="padding:0"><pre class="code-block" id="export-code">${esc(d.exportInfo.code)}</pre></div>
      </div>`;
  }

  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div>
        <h2>${esc(tc.name)}</h2>
        <div class="meta">${typeBadge(tc)}${lastRunBadge(tc)}<span class="mono muted">${tc.id}</span></div>
      </div>
      <button class="x-btn" data-act="close-drawer" title="Đóng">${icon('IconClose')}</button>
    </div>
    <div class="drawer-body">${body}</div>
    <div class="drawer-foot">
      <button class="btn btn-danger" data-act="del-tc" data-id="${tc.id}">${icon('IconTrashCan', 12)}Xoá</button>
      <div class="right">
        <button class="btn btn-secondary" data-act="export-tc" data-id="${tc.id}">${icon('IconDocumentExport', 12)}Xuất mã</button>
        ${d.dirty ? `<button class="btn btn-secondary" data-act="save-tc">${icon('IconSave', 12)}Lưu thay đổi</button>` : ''}
        <button class="btn btn-secondary" data-act="run-tc-headless" data-id="${tc.id}">Chạy ẩn</button>
        <button class="btn btn-primary" data-act="run-tc" data-id="${tc.id}" ${S.run && !S.run.summary ? 'disabled' : ''}>${icon('IconPlay', 12)}Chạy</button>
      </div>
    </div>`;
}

function drawerInfoFields(tc) {
  return `
    <div class="field-row">
      <label class="field-label">Tên test case</label>
      <input class="field" data-field="name" value="${esc(tc.name)}" />
    </div>
    <div class="field-row">
      <label class="field-label">Mô tả</label>
      <input class="field" data-field="description" placeholder="Mô tả ngắn mục đích kiểm thử" value="${esc(tc.description || '')}" />
    </div>
    ${tc.type === 'atomic' ? `<div class="field-row"><label class="field-label">URL gốc</label><span class="mono muted">${esc(tc.baseUrl || '—')}</span></div>` : ''}`;
}

/* ---------------- run drawer (persisted history) ---------------- */

function renderRunDrawer() {
  const r = S.drawer.run;
  $('#scrim').hidden = false;
  $('#drawer').hidden = false;

  const segs = (r.segments || [])
    .map((seg) => {
      const rows = (seg.steps || [])
        .map((st, i) => {
          let html = stepRow(st, i, { status: st.status || '', shot: st.shot });
          if (st.status === 'failed' && st.error) {
            html += `<div class="step-error">${esc(st.error)}</div>`;
          }
          return html;
        })
        .join('');
      return `<div class="seg-head">${icon('IconDocument', 12)}${esc(seg.name)}</div>${rows}`;
    })
    .join('');

  const tcExists = !!byId(r.tcId);

  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div>
        <h2>${esc(r.tcName)}</h2>
        <div class="meta">${runStatusBadge(r)}
          <span class="badge badge-gray">${fmtNum(r.passed)}/${fmtNum(r.total)} bước</span>
          <span class="badge badge-gray">${fmtDur(r.durationMs)}</span>
          <span class="mono muted">${r.runId}</span>
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px">${fmtDate(r.startedAt)}${r.headless ? ' · chạy ẩn' : ''}</div>
      </div>
      <button class="x-btn" data-act="close-drawer" title="Đóng">${icon('IconClose')}</button>
    </div>
    <div class="drawer-body">
      ${r.error ? `<div class="alert alert-error">${icon('IconErrorFilled')}<span>${esc(r.error)}</span></div>` : ''}
      <div class="card" style="box-shadow:none">
        <div class="card-head"><span class="title">Các bước và evidence</span><span class="caption">bấm ảnh để mở bản đầy đủ</span></div>
        <div class="steps">${segs}</div>
      </div>
    </div>
    <div class="drawer-foot">
      <button class="btn btn-danger" data-act="del-run" data-id="${r.runId}">${icon('IconTrashCan', 12)}Xoá lượt chạy</button>
      <div class="right">
        <button class="btn btn-primary" data-act="rerun" data-id="${r.tcId}" ${tcExists ? '' : 'disabled title="Test case đã bị xoá"'}>${icon('IconRenew', 12)}Chạy lại</button>
      </div>
    </div>`;
}

/* ---------------- run panel ---------------- */

function renderRunPanel() {
  const r = S.run;
  const segs = r.segments
    .map((seg, si) => {
      const rows = seg.steps
        .map((st, i) => {
          const res = (r.results[si] || {})[i] || {};
          let html = stepRow(st, i, { status: res.status || '', shot: res.shot });
          if (res.status === 'failed' && res.error) {
            html += `<div class="step-error">${esc(res.error)}</div>`;
          }
          return html;
        })
        .join('');
      return `<div class="seg-head">${icon('IconDocument', 12)}${esc(seg.name)}</div>${rows}`;
    })
    .join('');

  let head = `<span class="spinner"></span><span class="title">Đang chạy</span>`;
  let summaryHtml = '';
  if (r.summary) {
    const ok = r.summary.status === 'passed';
    head = `<span class="title">Kết quả</span>`;
    summaryHtml = `<div class="alert ${ok ? 'alert-success' : 'alert-error'}" style="margin:12px">
      ${icon(ok ? 'IconCheckmarkFilled' : 'IconErrorFilled')}
      <span>${ok ? 'Đạt' : 'Lỗi'} — ${fmtNum(r.summary.passed)}/${fmtNum(r.summary.total)} bước, ${fmtNum(Math.round(r.summary.durationMs / 100) / 10)} giây</span>
      <button class="btn btn-ghost btn-sm" data-act="close-run" style="margin-left:auto">Đóng kết quả</button>
    </div>`;
  }

  return `<div class="card" style="box-shadow:none">
    <div class="card-head">${head}<span class="caption">${esc(r.runId || '')}</span></div>
    ${summaryHtml}
    <div class="steps">${segs}</div>
  </div>`;
}

/* ---------------- modals ---------------- */

function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-layer').hidden = false;
  const first = $('#modal input.field');
  if (first) setTimeout(() => first.focus(), 0);
}
function closeModal() {
  $('#modal-layer').hidden = true;
}

function modalNewRecord() {
  openModal(`
    <div class="modal-head"><h3>Ghi test case mới</h3><button class="x-btn" data-act="close-modal">${icon('IconClose')}</button></div>
    <div class="modal-body">
      <div class="field-row">
        <label class="field-label" for="m-url">URL trang cần ghi</label>
        <input class="field" id="m-url" placeholder="Nhập URL bắt đầu bằng https://" value="${esc(S.record.url)}" />
        <span class="field-hint">Trình duyệt Chromium sẽ mở ra. Thao tác trong đó được ghi lại thành các bước.</span>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" data-act="close-modal">Cancel</button>
      <button class="btn btn-primary" data-act="start-record-modal">${icon('IconPlay', 12)}Bắt đầu ghi</button>
    </div>`);
}

function modalSaveRecording() {
  openModal(`
    <div class="modal-head"><h3>Lưu test case</h3><button class="x-btn" data-act="close-modal">${icon('IconClose')}</button></div>
    <div class="modal-body">
      <div class="field-row">
        <label class="field-label" for="m-name">Tên test case</label>
        <input class="field" id="m-name" placeholder="Đặt tên theo hành vi kiểm thử" />
      </div>
      <div class="field-row">
        <label class="field-label" for="m-desc">Mô tả</label>
        <input class="field" id="m-desc" placeholder="Mô tả ngắn mục đích kiểm thử" />
      </div>
      <span class="field-hint">${fmtNum(S.record.steps.length)} bước · ${esc(S.record.url)}</span>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" data-act="close-modal">Cancel</button>
      <button class="btn btn-primary" data-act="save-recording">Lưu test case</button>
    </div>`);
}

let composeOrder = [];
function modalCompose() {
  composeOrder = S.selected.slice();
  renderComposeModal();
}
function renderComposeModal() {
  const rows = composeOrder
    .map((id, i) => {
      const c = byId(id);
      return `<div class="child-row">
        <span class="idx mono muted">${i + 1}</span>
        ${icon(c && c.type === 'composite' ? 'IconLayers' : 'IconDocument')}
        <span class="name">${esc(c ? c.name : id)}</span>
        <span class="tools">
          <button class="x-btn" data-act="compose-up" data-i="${i}" title="Chuyển lên">${icon('IconArrowUp', 12)}</button>
          <button class="x-btn" data-act="compose-down" data-i="${i}" title="Chuyển xuống">${icon('IconArrowDown', 12)}</button>
          <button class="x-btn" data-act="compose-remove" data-i="${i}" title="Gỡ">${icon('IconClose', 12)}</button>
        </span>
      </div>`;
    })
    .join('');
  const nameVal = $('#m-name') ? $('#m-name').value : '';
  const descVal = $('#m-desc') ? $('#m-desc').value : '';
  openModal(`
    <div class="modal-head"><h3>Tạo test case tổng hợp</h3><button class="x-btn" data-act="close-modal">${icon('IconClose')}</button></div>
    <div class="modal-body">
      <div class="field-row">
        <label class="field-label" for="m-name">Tên test case</label>
        <input class="field" id="m-name" placeholder="Đặt tên theo luồng nghiệp vụ" value="${esc(nameVal)}" />
      </div>
      <div class="field-row">
        <label class="field-label" for="m-desc">Mô tả</label>
        <input class="field" id="m-desc" placeholder="Mô tả ngắn luồng kiểm thử" value="${esc(descVal)}" />
      </div>
      <div class="field-row">
        <label class="field-label">Các test case con — chạy nối tiếp theo thứ tự</label>
        ${rows || '<div class="muted" style="font-size:13px">Chưa chọn test case con.</div>'}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" data-act="close-modal">Cancel</button>
      <button class="btn btn-primary" data-act="create-composite" ${composeOrder.length ? '' : 'disabled'}>Tạo test case</button>
    </div>`);
}

function modalEditStep(i) {
  const step = S.drawer.tc.steps[i];
  if (!step) return;
  const meta = ACTION_META[step.action] || { label: step.action };
  const field = editableField(step);
  openModal(`
    <div class="modal-head"><h3>Sửa bước ${i + 1} — ${esc(meta.label)}</h3><button class="x-btn" data-act="close-modal">${icon('IconClose')}</button></div>
    <div class="modal-body">
      ${
        step.selector !== undefined && step.action !== 'goto'
          ? `<div class="field-row">
              <label class="field-label" for="m-sel">Selector</label>
              <input class="field mono" id="m-sel" style="font-family:var(--ds-font-mono);font-size:12px" value="${esc(step.selector || '')}" />
              <span class="field-hint">Chuỗi locator Playwright — đổi khi selector ghi được quá giòn.</span>
            </div>`
          : ''
      }
      ${
        field
          ? `<div class="field-row">
              <label class="field-label" for="m-val">${esc(field.label)}</label>
              <input class="field" id="m-val" value="${esc(step[field.key] != null ? step[field.key] : '')}" />
            </div>`
          : ''
      }
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" data-act="close-modal">Cancel</button>
      <button class="btn btn-primary" data-act="apply-edit-step" data-i="${i}">Lưu bước</button>
    </div>`);
}

function modalConfirmDelete(id) {
  const tc = byId(id);
  if (!tc) return;
  openModal(`
    <div class="modal-head"><h3>Xoá test case</h3><button class="x-btn" data-act="close-modal">${icon('IconClose')}</button></div>
    <div class="modal-body">
      <p style="margin:0;color:var(--ds-text-body)">Xoá <b>${esc(tc.name)}</b>? Hành động này không hoàn tác được.</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" data-act="close-modal">Cancel</button>
      <button class="btn btn-danger" data-act="confirm-del" data-id="${id}">${icon('IconTrashCan', 12)}Xoá</button>
    </div>`);
}

/* ---------------- rendering root ---------------- */

function render() {
  renderNav();
  $('#view-list').hidden = S.view !== 'list';
  $('#view-record').hidden = S.view !== 'record';
  $('#view-runs').hidden = S.view !== 'runs';
  if (S.view === 'list') renderList();
  else if (S.view === 'runs') renderRuns();
  else renderRecord();
  if (S.drawer) renderDrawer();
}

async function refreshList() {
  S.tcs = await api('GET', '/api/testcases');
}

/* ---------------- actions ---------------- */

async function startRecord(url) {
  if (!/^https?:\/\//i.test(url || '')) {
    notify('Nhập URL bắt đầu bằng http:// hoặc https://', 'error');
    return;
  }
  try {
    await api('POST', '/api/record/start', { url });
    // The server is the source of truth — the first goto step is emitted
    // during start, before this response arrives.
    const st = await api('GET', '/api/record/state');
    S.record = { active: true, url, mode: st.mode || 'action', steps: st.steps || [] };
    S.view = 'record';
    closeModal();
    render();
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function runTc(id, headless) {
  const tc = byId(id);
  if (!tc) return;
  if (S.run && !S.run.summary) {
    notify('Đang có lượt chạy khác. Chờ xong rồi chạy tiếp.', 'error');
    return;
  }
  if (!S.drawer || S.drawer.kind !== 'tc' || S.drawer.tc.id !== id) openDrawer(id);
  api('POST', '/api/run/' + id, { headless: !!headless })
    .then(async () => {
      await refreshList();
      if (S.drawer && S.drawer.kind === 'tc') {
        const fresh = byId(S.drawer.tc.id);
        if (fresh) {
          S.drawer.tc.lastRun = fresh.lastRun;
        }
      }
      render();
    })
    .catch((err) => notify(err.message, 'error'));
}

const moveItem = (arr, i, delta) => {
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  const [x] = arr.splice(i, 1);
  arr.splice(j, 0, x);
};

const handlers = {
  'close-modal': () => closeModal(),
  'close-drawer': () => closeDrawer(),
  'new-record': () => modalNewRecord(),
  'start-record-modal': () => startRecord($('#m-url').value.trim()),
  'start-record': () => startRecord($('#rec-url').value.trim()),

  'stop-save': () => modalSaveRecording(),
  'cancel-record': async () => {
    await api('POST', '/api/record/stop').catch(() => {});
    S.record = { active: false, url: S.record.url, mode: 'action', steps: [] };
    render();
  },
  'del-live-step': (ds) => {
    S.record.steps.splice(Number(ds.i), 1);
    render();
  },
  'save-recording': async () => {
    const name = $('#m-name').value.trim();
    if (!name) return notify('Nhập tên test case', 'error');
    try {
      await api('POST', '/api/record/stop').catch(() => {});
      await api('POST', '/api/testcases', {
        type: 'atomic',
        name,
        description: $('#m-desc').value.trim(),
        baseUrl: S.record.url,
        steps: S.record.steps,
      });
      S.record = { active: false, url: '', mode: 'action', steps: [] };
      closeModal();
      await refreshList();
      S.view = 'list';
      render();
      notify('Đã lưu test case "' + name + '"', 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  },

  'sel-all': (ds, el) => {
    S.selected = el.checked ? S.tcs.map((t) => t.id) : [];
    render();
  },
  'sel-tc': (ds, el) => {
    if (el.checked) {
      if (!S.selected.includes(ds.id)) S.selected.push(ds.id);
    } else {
      S.selected = S.selected.filter((x) => x !== ds.id);
    }
    render();
  },
  'clear-sel': () => {
    S.selected = [];
    render();
  },
  'open-compose': () => modalCompose(),
  'compose-up': (ds) => { moveItem(composeOrder, Number(ds.i), -1); renderComposeModal(); },
  'compose-down': (ds) => { moveItem(composeOrder, Number(ds.i), 1); renderComposeModal(); },
  'compose-remove': (ds) => { composeOrder.splice(Number(ds.i), 1); renderComposeModal(); },
  'create-composite': async () => {
    const name = $('#m-name').value.trim();
    if (!name) return notify('Nhập tên test case', 'error');
    try {
      await api('POST', '/api/testcases', {
        type: 'composite',
        name,
        description: $('#m-desc').value.trim(),
        children: composeOrder,
      });
      closeModal();
      S.selected = [];
      await refreshList();
      render();
      notify('Đã tạo test case tổng hợp "' + name + '"', 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  },

  'open-tc': (ds) => openDrawer(ds.id),
  'run-tc': (ds) => runTc(ds.id, false),
  'run-tc-headless': (ds) => runTc(ds.id, true),
  'close-run': () => { S.run = null; renderDrawer(); },

  'run-batch': () => {
    if (!S.selected.length) return;
    if (S.batch) return notify('Đang có đợt chạy khác. Chờ xong rồi chạy tiếp.', 'error');
    const ids = S.selected.slice();
    S.batch = { total: ids.length, done: 0, current: null };
    S.view = 'runs';
    render();
    api('POST', '/api/run-batch', { ids, headless: false }).catch((err) => {
      S.batch = null;
      notify(err.message, 'error');
      render();
    });
  },
  'open-run': (ds) => openRunDrawer(ds.id),
  'rerun': (ds) => runTc(ds.id, false),
  'del-run': async (ds) => {
    try {
      await api('DELETE', '/api/runs/' + ds.id);
      closeDrawer();
      await refreshRuns();
      render();
      notify('Đã xoá lượt chạy', 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  },

  'edit-step': (ds) => modalEditStep(Number(ds.i)),
  'apply-edit-step': (ds) => {
    const step = S.drawer.tc.steps[Number(ds.i)];
    if (!step) return;
    const sel = $('#m-sel');
    if (sel) step.selector = sel.value.trim();
    const field = editableField(step);
    const val = $('#m-val');
    if (field && val) step[field.key] = val.value;
    S.drawer.dirty = true;
    closeModal();
    renderDrawer();
  },
  'step-up': (ds) => { moveItem(S.drawer.tc.steps, Number(ds.i), -1); S.drawer.dirty = true; renderDrawer(); },
  'step-down': (ds) => { moveItem(S.drawer.tc.steps, Number(ds.i), 1); S.drawer.dirty = true; renderDrawer(); },
  'step-del': (ds) => { S.drawer.tc.steps.splice(Number(ds.i), 1); S.drawer.dirty = true; renderDrawer(); },
  'child-up': (ds) => { moveItem(S.drawer.tc.children, Number(ds.i), -1); S.drawer.dirty = true; renderDrawer(); },
  'child-down': (ds) => { moveItem(S.drawer.tc.children, Number(ds.i), 1); S.drawer.dirty = true; renderDrawer(); },
  'child-remove': (ds) => { S.drawer.tc.children.splice(Number(ds.i), 1); S.drawer.dirty = true; renderDrawer(); },

  'save-tc': async () => {
    const tc = S.drawer.tc;
    try {
      const patch = { name: tc.name, description: tc.description };
      if (tc.type === 'atomic') patch.steps = tc.steps;
      else patch.children = tc.children;
      await api('PUT', '/api/testcases/' + tc.id, patch);
      S.drawer.dirty = false;
      await refreshList();
      render();
      notify('Đã lưu thay đổi', 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  },

  'export-tc': async (ds) => {
    try {
      S.drawer.exportInfo = await api('POST', '/api/export/' + ds.id);
      renderDrawer();
      notify('Đã ghi file ' + S.drawer.exportInfo.file, 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  },
  'copy-code': () => {
    const code = $('#export-code');
    if (code) navigator.clipboard.writeText(code.textContent).then(() => notify('Đã copy mã', 'success'));
  },

  'del-tc': (ds) => modalConfirmDelete(ds.id),
  'confirm-del': async (ds) => {
    try {
      await api('DELETE', '/api/testcases/' + ds.id);
      closeModal();
      closeDrawer();
      S.selected = S.selected.filter((x) => x !== ds.id);
      await refreshList();
      render();
      notify('Đã xoá test case', 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return; // handled on change
  const fn = handlers[el.dataset.act];
  if (fn) fn(el.dataset, el);
});

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act]');
  if (el) {
    if (el.dataset.act === 'toggle-assert') {
      const mode = el.checked ? 'assert' : 'action';
      try {
        await api('POST', '/api/record/mode', { mode });
        S.record.mode = mode;
      } catch (err) {
        notify(err.message, 'error');
      }
      return;
    }
    if (el.dataset.act === 'runs-filter') {
      S.runsFilter = el.value;
      renderRuns();
      return;
    }
    if (el.dataset.act === 'child-add') {
      if (el.value) {
        S.drawer.tc.children.push(el.value);
        S.drawer.dirty = true;
        renderDrawer();
      }
      return;
    }
    const fn = handlers[el.dataset.act];
    if (fn) return fn(el.dataset, el);
  }
  // drawer info fields
  const f = e.target.closest('[data-field]');
  if (f && S.drawer && S.drawer.kind === 'tc') {
    S.drawer.tc[f.dataset.field] = f.value;
    S.drawer.dirty = true;
    renderDrawer();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#modal-layer').hidden) closeModal();
    else if (S.drawer) closeDrawer();
  }
  if (e.key === 'Enter' && !$('#modal-layer').hidden) {
    const primary = $('#modal .modal-foot .btn-primary');
    if (primary && document.activeElement && document.activeElement.tagName === 'INPUT') primary.click();
  }
});

$('#scrim').addEventListener('click', closeDrawer);
$('#modal-layer').addEventListener('click', (e) => {
  if (e.target === $('#modal-layer')) closeModal();
});

document.querySelectorAll('.nav-item').forEach((b) =>
  b.addEventListener('click', async () => {
    S.view = b.dataset.view;
    if (S.view === 'list') await refreshList().catch(() => {});
    if (S.view === 'runs') await refreshRuns().catch(() => {});
    render();
  })
);

/* ---------------- websocket ---------------- */

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onWs(msg);
  };
  ws.onclose = () => setTimeout(connectWS, 1000);
}

function onWs(msg) {
  switch (msg.type) {
    case 'record-step':
      S.record.steps.push(msg.step);
      if (S.view === 'record') renderRecord();
      renderNav();
      break;
    case 'record-step-updated': {
      const i = S.record.steps.findIndex((s) => s.id === msg.step.id);
      if (i >= 0) S.record.steps[i] = msg.step;
      if (S.view === 'record') renderRecord();
      break;
    }
    case 'record-mode':
      S.record.mode = msg.mode;
      if (S.view === 'record') renderRecord();
      break;
    case 'record-warn':
      notify(msg.message, 'error');
      break;
    case 'record-stopped':
      if (msg.reason === 'browser-closed' && S.record.active) {
        S.record.active = false;
        if (S.record.steps.length) {
          notify('Cửa sổ ghi đã đóng — lưu lại các bước đã ghi', 'info');
          modalSaveRecording();
        } else {
          render();
        }
      }
      break;

    case 'run-started':
      S.run = { tcId: msg.tcId, name: msg.name, runId: msg.runId, segments: msg.segments, results: {} };
      if (S.batch) S.batch.current = msg.name;
      if (S.drawer && S.drawer.kind === 'tc' && S.drawer.tc.id === msg.tcId) renderDrawer();
      if (S.batch && S.view === 'runs') renderRuns();
      break;
    case 'run-step': {
      if (!S.run || S.run.runId !== msg.runId) return;
      const seg = (S.run.results[msg.segIndex] = S.run.results[msg.segIndex] || {});
      seg[msg.stepIndex] = { status: msg.status, error: msg.error, shot: msg.shot };
      if (S.drawer && S.drawer.kind === 'tc' && S.drawer.tc.id === S.run.tcId) renderDrawer();
      break;
    }
    case 'run-error':
      if (S.run && S.run.runId === msg.runId) notify(msg.error, 'error');
      break;
    case 'run-done':
      if (S.run && S.run.runId === msg.runId) {
        S.run.summary = msg;
        if (S.drawer && S.drawer.kind === 'tc' && S.drawer.tc.id === S.run.tcId) renderDrawer();
      }
      if (S.view === 'runs') refreshRuns().then(() => S.view === 'runs' && renderRuns()).catch(() => {});
      break;

    case 'batch-started':
      S.batch = { total: msg.total, done: 0, current: msg.names[0] || null };
      if (S.view === 'runs') renderRuns();
      break;
    case 'batch-progress':
      if (S.batch) {
        S.batch.done = msg.done;
        if (S.view === 'runs') renderRuns();
      }
      break;
    case 'batch-done': {
      S.batch = null;
      const ok = (msg.results || []).filter((r) => r.status === 'passed').length;
      notify(`Đợt chạy hoàn tất — đạt ${fmtNum(ok)}/${fmtNum((msg.results || []).length)} test case`, ok === (msg.results || []).length ? 'success' : 'error');
      refreshRuns()
        .then(refreshList)
        .then(() => render())
        .catch(() => {});
      break;
    }
  }
}

/* ---------------- init ---------------- */

(async function init() {
  try {
    await refreshList();
    await refreshRuns().catch(() => {});
    const st = await api('GET', '/api/record/state');
    if (st.active) {
      S.record = { active: true, url: st.url, mode: st.mode, steps: st.steps };
      S.view = 'record';
    }
  } catch (err) {
    notify(err.message, 'error');
  }
  render();
  connectWS();
})();
