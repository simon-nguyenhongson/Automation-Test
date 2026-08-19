// Store — test cases persisted as one JSON file per case under data/testcases.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data', 'testcases');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileOf(id) {
  // ids are generated here (hex only) — never path fragments
  if (!/^tc_[a-z0-9]+$/.test(id)) throw new Error('Mã test case không hợp lệ: ' + id);
  return path.join(DATA_DIR, id + '.json');
}

function newId() {
  return 'tc_' + crypto.randomBytes(4).toString('hex');
}

function readOne(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function list() {
  ensureDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readOne(path.join(DATA_DIR, f)))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function get(id) {
  ensureDir();
  const file = fileOf(id);
  return fs.existsSync(file) ? readOne(file) : null;
}

function write(tc) {
  ensureDir();
  fs.writeFileSync(fileOf(tc.id), JSON.stringify(tc, null, 2));
  return tc;
}

function create(data) {
  const now = new Date().toISOString();
  const tc = {
    id: newId(),
    type: data.type === 'composite' ? 'composite' : 'atomic',
    name: String(data.name || 'Test case chưa đặt tên').trim(),
    description: String(data.description || '').trim(),
    createdAt: now,
    updatedAt: now,
    lastRun: null,
  };
  if (tc.type === 'atomic') {
    tc.baseUrl = String(data.baseUrl || '');
    tc.steps = Array.isArray(data.steps) ? data.steps : [];
  } else {
    tc.children = Array.isArray(data.children) ? data.children.slice() : [];
  }
  return write(tc);
}

function update(id, patch) {
  const tc = get(id);
  if (!tc) return null;
  const allowed = ['name', 'description', 'baseUrl', 'steps', 'children', 'lastRun'];
  for (const key of allowed) {
    if (patch[key] !== undefined) tc[key] = patch[key];
  }
  tc.updatedAt = new Date().toISOString();
  return write(tc);
}

/** Composites whose children reference the given id. */
function referencing(id) {
  return list().filter((tc) => tc.type === 'composite' && (tc.children || []).includes(id));
}

function remove(id) {
  const file = fileOf(id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

module.exports = { list, get, create, update, remove, referencing };
