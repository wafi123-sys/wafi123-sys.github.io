const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

// Path configuration (can be overridden by Electron or Cloud Hosting via env vars)
const PUBLIC_DIR = process.env.GUDANGPRO_PUBLIC_PATH || (fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname);
const VENDOR_DIR = fs.existsSync(path.join(PUBLIC_DIR, 'vendor')) ? path.join(PUBLIC_DIR, 'vendor') : path.join(__dirname, 'vendor');
const UPLOADS_DIR = process.env.GUDANGPRO_UPLOADS_PATH || path.join(__dirname, 'uploads');
const DB_PATH = process.env.GUDANGPRO_DB_PATH || path.join(__dirname, 'warehouse.db');
const BACKUP_DIR = process.env.GUDANGPRO_BACKUP_PATH || path.join(path.dirname(DB_PATH), 'backups');

const app = express();
app.use((req, res, next) => {
  res.setHeader('X-GudangPro-App', '1');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (PUBLIC_DIR === __dirname && (req.path === '/server.js' || req.path === '/warehouse.db' || req.path === '/package.json' || req.path.startsWith('/.git'))) {
    return res.status(404).end();
  }
  next();
});
app.use(express.json({ limit: '25mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/vendor', express.static(VENDOR_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!fs.existsSync(UPLOADS_DIR)) { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); }
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
// Photo size limit: 5MB
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

let db;
const DEFAULT_WH = 'MAIN';
const CATEGORIES = ['FERTILIZER', 'CHEMICAL', 'OTHER'];

// ---------------------------------------------------------------- helpers
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const toNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local date
const todayStr = () => dateStr(new Date());
const genId = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase()}`;
const clean = (v, fallback = '-') => { const s = (v === undefined || v === null) ? '' : String(v).trim(); return s || fallback; };

// Every stock movement in one place. qty is signed (+ in, - out, adjustment signed).
const MOVES_SQL = `
  SELECT kode_barang, COALESCE(gudang,'${DEFAULT_WH}') AS gudang, tanggal_masuk AS tanggal, qty_masuk AS qty, 'IN' AS kind FROM inbound_log
  UNION ALL
  SELECT kode_barang, COALESCE(gudang,'${DEFAULT_WH}') AS gudang, tanggal_keluar AS tanggal, -qty_keluar AS qty, 'OUT' AS kind FROM outbound_log
  UNION ALL
  SELECT kode_barang, COALESCE(gudang,'${DEFAULT_WH}') AS gudang, tanggal AS tanggal, selisih AS qty, 'ADJ' AS kind FROM stock_opname
`;

async function getBalance(kode, gudang) {
  const r = await db.get(`SELECT COALESCE(SUM(qty),0) AS b FROM (${MOVES_SQL}) WHERE kode_barang = ? AND gudang = ?`, [kode, gudang]);
  return round3(r.b);
}

async function lastClosedDate(gudang) {
  const r = await db.get('SELECT MAX(tanggal) AS m FROM closing_days WHERE gudang = ?', [gudang]);
  return r && r.m ? r.m : null;
}

async function assertDayOpen(gudang, tanggal) {
  const last = await lastClosedDate(gudang);
  if (last && tanggal <= last) {
    throw new Error(`Day ${last} is already closed for warehouse ${gudang}. Transactions dated on or before it are locked.`);
  }
}

async function getActiveItem(kode) {
  const item = await db.get('SELECT * FROM master_stock WHERE kode_barang = ?', [kode]);
  if (!item) throw new Error(`Item ${kode} was not found in Master Stock.`);
  if (item.aktif === 0) throw new Error(`Item ${item.nama_barang} is inactive.`);
  return item;
}

async function getActiveWarehouse(code) {
  const wh = await db.get('SELECT * FROM warehouses WHERE code = ?', [code]);
  if (!wh) throw new Error(`Warehouse ${code || '(none)'} is not registered.`);
  if (wh.aktif === 0) throw new Error(`Warehouse ${wh.name} is inactive.`);
  return wh;
}

async function addColumn(table, column, definition) {
  const cols = await db.all(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function createBackupSnapshot(label = 'snapshot') {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const now = new Date();
    const stamp = `${dateStr(now)}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeLabel = String(label || 'snapshot').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'snapshot';
    const fileName = `warehouse_${stamp}_${safeLabel}.db`;
    const fullPath = path.join(BACKUP_DIR, fileName);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    const escaped = fullPath.replace(/\\/g, '/').replace(/'/g, "''");
    await db.exec(`VACUUM INTO '${escaped}'`);
    // Prune older snapshots beyond 30 files
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('warehouse_') && f.endsWith('.db'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of files.slice(30)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch (e) { }
    }
    return fileName;
  } catch (err) {
    console.warn('[Backup] Snapshot warning:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------- database
async function initDB() {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA synchronous = NORMAL;');
  await db.exec('PRAGMA foreign_keys = ON;');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        role TEXT NOT NULL
    );
    INSERT OR IGNORE INTO users (username, password, role) VALUES ('admin', 'admin123', 'ADMIN');
    INSERT OR IGNORE INTO users (username, password, role) VALUES ('staff', 'staff123', 'STAFF');

    CREATE TABLE IF NOT EXISTS master_stock (
        kode_barang TEXT PRIMARY KEY,
        nama_barang TEXT NOT NULL,
        ca_barang TEXT,
        satuan TEXT DEFAULT 'pcs',
        lokasi_gudang TEXT,
        lokasi_rak TEXT,
        kondisi TEXT,
        qty_total INTEGER NOT NULL DEFAULT 0,
        min_stock_alert INTEGER NOT NULL DEFAULT 0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS master_location (
        nama_lokasi TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS inbound_log (
        transaction_id TEXT PRIMARY KEY,
        tanggal_masuk TEXT NOT NULL,
        kode_barang TEXT NOT NULL,
        qty_masuk INTEGER NOT NULL,
        pic TEXT NOT NULL,
        supplier TEXT,
        surat_jalan TEXT,
        foto_bukti TEXT,
        lokasi TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (kode_barang) REFERENCES master_stock(kode_barang)
    );
    CREATE TABLE IF NOT EXISTS outbound_log (
        transaction_id TEXT PRIMARY KEY,
        tanggal_keluar TEXT NOT NULL,
        kode_barang TEXT NOT NULL,
        qty_keluar INTEGER NOT NULL,
        kondisi_keluar TEXT,
        alasan_keluar TEXT,
        pic TEXT NOT NULL,
        foto_bukti TEXT,
        lokasi TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (kode_barang) REFERENCES master_stock(kode_barang)
    );
    CREATE TABLE IF NOT EXISTS stock_opname (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tanggal TEXT NOT NULL,
        kode_barang TEXT NOT NULL,
        qty_sistem INTEGER NOT NULL,
        qty_fisik INTEGER NOT NULL,
        selisih INTEGER NOT NULL,
        pic TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (kode_barang) REFERENCES master_stock(kode_barang)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        old_data TEXT,
        username TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS warehouses (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        remarks TEXT,
        aktif INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS closing_days (
        tanggal TEXT NOT NULL,
        gudang TEXT NOT NULL,
        closed_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tanggal, gudang)
    );
    CREATE TABLE IF NOT EXISTS daily_closing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tanggal TEXT NOT NULL,
        gudang TEXT NOT NULL,
        kode_barang TEXT NOT NULL,
        opening REAL NOT NULL,
        qty_in REAL NOT NULL,
        qty_out REAL NOT NULL,
        adj REAL NOT NULL,
        expected REAL NOT NULL,
        physical REAL NOT NULL,
        selisih REAL NOT NULL,
        reason TEXT,
        pic TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (tanggal, gudang, kode_barang)
    );
  `);

  // Migrations for existing databases (safe to run repeatedly)
  await addColumn('master_stock', 'satuan', "TEXT DEFAULT 'pcs'");
  await addColumn('master_stock', 'kategori', "TEXT DEFAULT 'OTHER'");
  await addColumn('master_stock', 'conv_factor', 'REAL DEFAULT 0');
  await addColumn('master_stock', 'conv_unit', "TEXT DEFAULT ''");
  await addColumn('master_stock', 'aktif', 'INTEGER DEFAULT 1');

  await addColumn('inbound_log', 'supplier', 'TEXT');
  await addColumn('inbound_log', 'surat_jalan', 'TEXT');
  await addColumn('inbound_log', 'gudang', `TEXT DEFAULT '${DEFAULT_WH}'`);

  await addColumn('outbound_log', 'gudang', `TEXT DEFAULT '${DEFAULT_WH}'`);
  await addColumn('outbound_log', 'requisition_no', 'TEXT');
  await addColumn('outbound_log', 'block', 'TEXT');
  await addColumn('outbound_log', 'phase', 'TEXT');
  await addColumn('outbound_log', 'account_no', 'TEXT');
  await addColumn('outbound_log', 'requested_by', 'TEXT');
  await addColumn('outbound_log', 'approved_by', 'TEXT');
  await addColumn('outbound_log', 'received_by', 'TEXT');
  await addColumn('outbound_log', 'empty_returned', 'REAL');

  await addColumn('stock_opname', 'gudang', `TEXT DEFAULT '${DEFAULT_WH}'`);
  await addColumn('stock_opname', 'source', 'TEXT');

  // Existing data belongs to the default warehouse
  const whCount = await db.get('SELECT COUNT(*) AS c FROM warehouses');
  if (whCount.c === 0) {
    await db.run("INSERT INTO warehouses (code, name, remarks) VALUES (?, 'Main Warehouse', 'Default warehouse (existing data)')", [DEFAULT_WH]);
  }
  await db.run("INSERT OR IGNORE INTO warehouses (code, name, remarks, aktif) VALUES ('G-BAJA', 'STORE 1', 'SEBELAH BENGKEL', 1)");

  // Seed default Southwind Plantation fertilizer items & 010337 Stock Card ledger (safe idempotent)
  await seedSouthwindFertilizers();
}

async function seedSouthwindFertilizers() {
  const fertItems = [
    { kode: '010337', nama: 'PROFICOTE (CRF) / SK cote', kat: 'FERTILIZER', unit: 'bag', conv: 25, cunit: 'kg', min: 100, openMain: 3184, openStore1: 0 },
    { kode: 'CPD-45B', nama: 'Compound 45B', kat: 'FERTILIZER', unit: 'bag', conv: 50, cunit: 'kg', min: 50, openMain: 1200, openStore1: 0 },
    { kode: 'CPD-55', nama: 'Compound 55', kat: 'FERTILIZER', unit: 'bag', conv: 50, cunit: 'kg', min: 50, openMain: 950, openStore1: 0 },
    { kode: 'NK-MIX', nama: 'NK MIX', kat: 'FERTILIZER', unit: 'bag', conv: 50, cunit: 'kg', min: 50, openMain: 800, openStore1: 0 },
    { kode: 'PUPUK-UREA', nama: 'Pupuk Urea 50kg', kat: 'FERTILIZER', unit: 'bag', conv: 50, cunit: 'kg', min: 50, openMain: 500, openStore1: 200 },
    { kode: 'PUPUK-NPK', nama: 'Pupuk NPK Phonska 50kg', kat: 'FERTILIZER', unit: 'bag', conv: 50, cunit: 'kg', min: 50, openMain: 450, openStore1: 150 },
    { kode: 'PUPUK-ZA', nama: 'Pupuk ZA 50kg', kat: 'FERTILIZER', unit: 'bag', conv: 50, cunit: 'kg', min: 30, openMain: 300, openStore1: 0 },
    { kode: 'PUPUK-KCL', nama: 'Pupuk MOP / KCL 50kg', kat: 'FERTILIZER', unit: 'bag', conv: 50, cunit: 'kg', min: 30, openMain: 250, openStore1: 0 }
  ];

  for (const f of fertItems) {
    await db.run(
      `INSERT OR IGNORE INTO master_stock (kode_barang, nama_barang, ca_barang, satuan, lokasi_gudang, lokasi_rak, kondisi, qty_total, min_stock_alert, kategori, conv_factor, conv_unit, aktif)
       VALUES (?, ?, '-', ?, '-', '-', 'OK', 0, ?, ?, ?, ?, 1)`,
      [f.kode, f.nama, f.unit, f.min, f.kat, f.conv, f.cunit]
    );
    const hasMoves = await db.get('SELECT COUNT(*) AS c FROM inbound_log WHERE kode_barang = ?', [f.kode]);
    if (!hasMoves || hasMoves.c === 0) {
      if (f.openMain > 0) {
        await db.run(
          `INSERT OR IGNORE INTO inbound_log (transaction_id, tanggal_masuk, kode_barang, qty_masuk, pic, supplier, surat_jalan, lokasi, gudang, created_at)
           VALUES (?, '2026-09-30', ?, ?, 'admin', 'B/F Opening Stock', 'BF-2026', 'MAIN', 'MAIN', '2026-09-30 08:00:00')`,
          [`BF-MAIN-${f.kode}`, f.kode, f.openMain]
        );
      }
      if (f.openStore1 > 0) {
        await db.run(
          `INSERT OR IGNORE INTO inbound_log (transaction_id, tanggal_masuk, kode_barang, qty_masuk, pic, supplier, surat_jalan, lokasi, gudang, created_at)
           VALUES (?, '2026-09-30', ?, ?, 'admin', 'B/F Opening Stock', 'BF-2026', 'G-BAJA', 'G-BAJA', '2026-09-30 08:00:00')`,
          [`BF-GBAJA-${f.kode}`, f.kode, f.openStore1]
        );
      }
    }
  }

  const proficoteOutbound = [
    ['SC-010337-01', '2026-10-06', 4, '70332', 'NS', 'B56', '', 'Field Team', '2026-10-06 08:01:00'],
    ['SC-010337-02', '2026-10-08', 86, '71277', 'PH4', '2686', '', 'Field Team', '2026-10-08 08:02:00'],
    ['SC-010337-03', '2026-10-09', 86, '71278', 'PH4', '2686', '', 'Field Team', '2026-10-09 08:03:00'],
    ['SC-010337-04', '2026-10-09', 77, '71278', 'PH4', '2689', '', 'Field Team', '2026-10-09 08:04:00'],
    ['SC-010337-05', '2026-10-10', 12, '72020', '', '', 'Repacking Fertilizer', 'Repacking', '2026-10-10 08:05:00'],
    ['SC-010337-06', '2026-10-10', 12, '72021', '', '', 'Repacking Fertilizer', 'Repacking', '2026-10-10 08:06:00'],
    ['SC-010337-07', '2026-10-10', 12, '72022', '', '', 'Repacking Fertilizer', 'Repacking', '2026-10-10 08:07:00'],
    ['SC-010337-08', '2026-10-10', 12, '72023', '', '', 'Repacking Fertilizer', 'Repacking', '2026-10-10 08:08:00'],
    ['SC-010337-09', '2026-10-10', 12, '72024', '', '', 'Repacking Fertilizer', 'Repacking', '2026-10-10 08:09:00'],
    ['SC-010337-10', '2026-10-12', 2, '70333', 'NS', 'B56', '', 'Field Team', '2026-10-12 08:10:00'],
    ['SC-010337-11', '2026-10-12', 40, '72122', '', '', 'BHB', 'BHB', '2026-10-12 08:11:00'],
    ['SC-010337-12', '2026-10-13', 44, '71281', '', '', 'BHB', 'BHB', '2026-10-13 08:12:00'],
    ['SC-010337-13', '2026-10-13', 93, '71279', 'PH4', '2688', '', 'Field Team', '2026-10-13 08:13:00'],
    ['SC-010337-14', '2026-10-13', 93, '71280', 'PH4', '2688', '', 'Field Team', '2026-10-13 08:14:00'],
    ['SC-010337-15', '2026-10-14', 168, '71282', 'PH4', '2687', '', 'Field Team', '2026-10-14 08:15:00'],
    ['SC-010337-16', '2026-10-24', 87, '71288', 'PH4', '2696', '', 'Field Team', '2026-10-24 08:16:00'],
    ['SC-010337-17', '2026-10-26', 87, '71289', 'PH4', '2696', '', 'Field Team', '2026-10-26 08:17:00'],
    ['SC-010337-18', '2026-10-26', 3, '70334', 'NS', 'B60', '', 'Field Team', '2026-10-26 08:18:00'],
    ['SC-010337-19', '2026-10-27', 30, '72127', 'PH2', '2644', '', 'Field Team', '2026-10-27 08:19:00'],
    ['SC-010337-20', '2026-10-28', 132, '72128', 'PH2', '2644', '', 'Field Team', '2026-10-28 08:20:00'],
    ['SC-010337-21', '2026-10-28', 55, '71283', '', '', 'BHB', 'BHB', '2026-10-28 08:21:00'],
    ['SC-010337-22', '2026-10-28', 12, '72018', '', '', 'Repacking Fertilizer', 'Repacking', '2026-10-28 08:22:00'],
    ['SC-010337-23', '2026-10-28', 12, '72019', '', '', 'Repacking Fertilizer', 'Repacking', '2026-10-28 08:23:00']
  ];

  for (const r of proficoteOutbound) {
    await db.run(
      `INSERT OR IGNORE INTO outbound_log (transaction_id, tanggal_keluar, kode_barang, qty_keluar, kondisi_keluar, alasan_keluar, pic, gudang, requisition_no, phase, block, received_by, empty_returned, created_at)
       VALUES (?, ?, '010337', ?, 'OK', ?, 'admin', 'MAIN', ?, ?, ?, ?, ?, ?)`,
      [r[0], r[1], r[2], r[6], r[3], r[4], r[5], r[7], r[2], r[8]]
    );
  }
}

// ---------------------------------------------------------------- auth
const requireAuth = async (req, res, next) => {
  try {
    const username = req.headers['authorization'];
    if (!username) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    req.user = user;
    next();
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ status: 'error', message: 'Access denied. Admin only.' });
  next();
};

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
    if (user) {
      res.json({ status: 'success', token: user.username, role: user.role, username: user.username });
    } else {
      res.status(401).json({ status: 'error', message: 'Wrong username or password!' });
    }
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// ---------------------------------------------------------------- warehouses
app.get('/api/warehouses', requireAuth, async (req, res) => {
  try {
    const rows = await db.all('SELECT code, name, remarks, aktif, created_at FROM warehouses ORDER BY aktif DESC, name ASC');
    res.json({ status: 'success', data: rows });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.post('/api/warehouses', requireAuth, requireAdmin, async (req, res) => {
  const code = clean(req.body.code, '').toUpperCase().replace(/\s+/g, '-');
  const name = clean(req.body.name, '');
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) return res.status(400).json({ status: 'error', message: 'Warehouse code must be 2-20 characters (letters, numbers, - or _).' });
  if (!name) return res.status(400).json({ status: 'error', message: 'Warehouse name is required.' });
  try {
    await db.run('INSERT INTO warehouses (code, name, remarks) VALUES (?, ?, ?)', [code, name, clean(req.body.remarks, '')]);
    res.status(201).json({ status: 'success', message: `Warehouse ${name} registered.` });
  } catch (e) { res.status(400).json({ status: 'error', message: 'Failed to register warehouse. The code must be unique.' }); }
});

app.put('/api/warehouses/:code', requireAuth, requireAdmin, async (req, res) => {
  try {
    const wh = await db.get('SELECT * FROM warehouses WHERE code = ?', [req.params.code]);
    if (!wh) throw new Error('Warehouse not found.');
    const name = clean(req.body.name, wh.name);
    const remarks = req.body.remarks === undefined ? wh.remarks : clean(req.body.remarks, '');
    const aktif = req.body.aktif === undefined ? wh.aktif : (req.body.aktif ? 1 : 0);

    if (aktif === 0 && wh.aktif === 1 && !req.body.force) {
      const r = await db.get(`SELECT COUNT(*) AS c FROM (SELECT kode_barang, SUM(qty) AS q FROM (${MOVES_SQL}) WHERE gudang = ? GROUP BY kode_barang HAVING q != 0)`, [wh.code]);
      if (r.c > 0) {
        return res.status(409).json({ status: 'confirm', message: `This warehouse still holds stock for ${r.c} item(s). Inactive warehouses are excluded from daily closing. Deactivate anyway?` });
      }
    }
    await db.run('UPDATE warehouses SET name = ?, remarks = ?, aktif = ? WHERE code = ?', [name, remarks, aktif, wh.code]);
    res.json({ status: 'success', message: 'Warehouse updated.' });
  } catch (e) { res.status(400).json({ status: 'error', message: e.message }); }
});

// ---------------------------------------------------------------- stats
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const period = parseInt(req.query.period) || 7;
    const dateLimit = dateStr(new Date(Date.now() - period * 24 * 60 * 60 * 1000));

    const inStats = await db.all('SELECT tanggal_masuk AS date, SUM(qty_masuk) AS total FROM inbound_log WHERE tanggal_masuk >= ? GROUP BY tanggal_masuk ORDER BY tanggal_masuk ASC', [dateLimit]);
    const outStats = await db.all('SELECT tanggal_keluar AS date, SUM(qty_keluar) AS total FROM outbound_log WHERE tanggal_keluar >= ? GROUP BY tanggal_keluar ORDER BY tanggal_keluar ASC', [dateLimit]);

    const topItems = await db.all(`
      SELECT o.kode_barang, m.nama_barang, m.satuan, SUM(o.qty_keluar) AS total_keluar
      FROM outbound_log o JOIN master_stock m ON o.kode_barang = m.kode_barang
      WHERE o.tanggal_keluar >= ? AND m.aktif = 1
      GROUP BY o.kode_barang ORDER BY total_keluar DESC LIMIT 5
    `, [dateLimit]);

    const totals = await db.all(`
      SELECT m.kode_barang, m.nama_barang, m.satuan, m.min_stock_alert, COALESCE(SUM(v.qty),0) AS total
      FROM master_stock m LEFT JOIN (${MOVES_SQL}) v ON v.kode_barang = m.kode_barang
      WHERE m.aktif = 1 GROUP BY m.kode_barang
    `);
    const lowStock = totals.filter(t => t.min_stock_alert > 0 && t.total <= t.min_stock_alert).map(t => ({ ...t, total: round3(t.total) }));

    const movedCodes = new Set((await db.all('SELECT DISTINCT kode_barang FROM outbound_log WHERE tanggal_keluar >= ?', [dateLimit])).map(r => r.kode_barang));
    const deadStock = totals.filter(t => t.total > 0 && !movedCodes.has(t.kode_barang)).slice(0, 10).map(t => ({ ...t, total: round3(t.total) }));

    const adj = await db.get('SELECT COALESCE(SUM(selisih),0) AS total, COUNT(*) AS n FROM stock_opname WHERE tanggal >= ?', [dateLimit]);

    const today = todayStr();
    const whs = await db.all('SELECT code, name FROM warehouses WHERE aktif = 1 ORDER BY name');
    const closing = [];
    for (const w of whs) {
      const last = await lastClosedDate(w.code);
      closing.push({ code: w.code, name: w.name, last_closed: last, today_closed: last === today });
    }

    res.json({
      status: 'success', data: {
        inStats, outStats, topItems, lowStock, deadStock,
        adjTotal: round3(adj.total), adjCount: adj.n,
        itemCount: totals.length, warehouseCount: whs.length, closing, today
      }
    });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// ---------------------------------------------------------------- master stock
app.get('/api/stock', requireAuth, async (req, res) => {
  try {
    const items = await db.all(`
      SELECT kode_barang, nama_barang, COALESCE(kategori,'OTHER') AS kategori, satuan,
             COALESCE(conv_factor,0) AS conv_factor, COALESCE(conv_unit,'') AS conv_unit,
             min_stock_alert, COALESCE(aktif,1) AS aktif
      FROM master_stock ORDER BY nama_barang ASC
    `);
    const bal = await db.all(`SELECT kode_barang, gudang, SUM(qty) AS qty FROM (${MOVES_SQL}) GROUP BY kode_barang, gudang`);
    const map = {};
    bal.forEach(b => { (map[b.kode_barang] = map[b.kode_barang] || {})[b.gudang] = round3(b.qty); });
    const data = items.map(i => {
      const balances = map[i.kode_barang] || {};
      const total = round3(Object.values(balances).reduce((a, b) => a + b, 0));
      return { ...i, balances, total };
    });
    res.json({ status: 'success', data });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

function itemFields(body, defaults = {}) {
  const kategori = CATEGORIES.includes(body.kategori) ? body.kategori : (defaults.kategori || 'OTHER');
  const defUnit = kategori === 'FERTILIZER' ? 'bag' : kategori === 'CHEMICAL' ? 'liter' : 'pcs';
  const conv = body.conv_factor === undefined || body.conv_factor === '' ? (defaults.conv_factor || 0) : toNum(body.conv_factor);
  return {
    nama_barang: clean(body.nama_barang, defaults.nama_barang || ''),
    kategori,
    satuan: clean(body.satuan, defaults.satuan || defUnit),
    conv_factor: Number.isFinite(conv) && conv > 0 ? conv : 0,
    conv_unit: clean(body.conv_unit, defaults.conv_unit || ''),
    min_stock_alert: Math.max(0, toNum(body.min_stock_alert) || 0)
  };
}

app.post('/api/stock', requireAuth, requireAdmin, async (req, res) => {
  const kode = clean(req.body.kode_barang, '');
  const f = itemFields(req.body);
  if (!kode || !f.nama_barang) return res.status(400).json({ status: 'error', message: 'Item code and name are required.' });
  if (f.conv_factor > 0 && f.conv_unit === '') f.conv_unit = f.satuan === 'bag' ? 'kg' : '';
  try {
    await db.run(
      `INSERT INTO master_stock (kode_barang, nama_barang, ca_barang, satuan, lokasi_gudang, lokasi_rak, kondisi, qty_total, min_stock_alert, kategori, conv_factor, conv_unit, aktif)
       VALUES (?, ?, '-', ?, '-', '-', 'OK', 0, ?, ?, ?, ?, 1)`,
      [kode, f.nama_barang, f.satuan, f.min_stock_alert, f.kategori, f.conv_factor, f.conv_unit]
    );
    res.status(201).json({ status: 'success', message: `Item ${f.nama_barang} registered.` });
  } catch (error) { res.status(400).json({ status: 'error', message: 'Failed to register item. The code must be unique.' }); }
});

app.put('/api/stock/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const cur = await db.get('SELECT * FROM master_stock WHERE kode_barang = ?', [req.params.id]);
    if (!cur) throw new Error('Item not found.');
    const f = itemFields(req.body, cur);
    const aktif = req.body.aktif === undefined ? (cur.aktif === 0 ? 0 : 1) : (req.body.aktif ? 1 : 0);

    if (aktif === 0 && cur.aktif !== 0 && !req.body.force) {
      const r = await db.get(`SELECT COALESCE(SUM(qty),0) AS t FROM (${MOVES_SQL}) WHERE kode_barang = ?`, [cur.kode_barang]);
      if (round3(r.t) !== 0) {
        return res.status(409).json({ status: 'confirm', message: `This item still has stock (${round3(r.t)} ${cur.satuan}). Inactive items are hidden and excluded from daily closing. Deactivate anyway?` });
      }
    }
    await db.run(
      `UPDATE master_stock SET nama_barang = ?, kategori = ?, satuan = ?, conv_factor = ?, conv_unit = ?, min_stock_alert = ?, aktif = ? WHERE kode_barang = ?`,
      [f.nama_barang, f.kategori, f.satuan, f.conv_factor, f.conv_unit, f.min_stock_alert, aktif, cur.kode_barang]
    );
    res.json({ status: 'success', message: 'Item updated.' });
  } catch (error) { res.status(400).json({ status: 'error', message: error.message }); }
});

// ---------------------------------------------------------------- inbound (receiving)
app.get('/api/inbound', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT i.*, COALESCE(i.gudang,'${DEFAULT_WH}') AS gudang, m.nama_barang, m.satuan, m.kategori
      FROM inbound_log i JOIN master_stock m ON i.kode_barang = m.kode_barang
      ORDER BY i.tanggal_masuk DESC, i.created_at DESC LIMIT 500`);
    res.json({ status: 'success', data: rows });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/inbound', requireAuth, upload.single('foto'), async (req, res) => {
  const b = req.body;
  const qty = toNum(b.qty_masuk);
  const tanggal = b.tanggal_masuk;
  const gudang = clean(b.gudang, '');
  if (!validDate(tanggal)) return res.status(400).json({ status: 'error', message: 'Invalid date.' });
  if (!(qty > 0)) return res.status(400).json({ status: 'error', message: 'Quantity must be greater than 0.' });

  const foto_bukti = req.file ? `/uploads/${req.file.filename}` : (typeof b.foto_bukti === 'string' && b.foto_bukti.startsWith('data:image/') ? b.foto_bukti : null);
  try {
    await getActiveItem(b.kode_barang);
    await getActiveWarehouse(gudang);
    await assertDayOpen(gudang, tanggal);
    await db.run(
      `INSERT INTO inbound_log (transaction_id, tanggal_masuk, kode_barang, qty_masuk, pic, supplier, surat_jalan, foto_bukti, lokasi, gudang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.transaction_id || genId('IN'), tanggal, b.kode_barang, qty, clean(b.pic, req.user.username), clean(b.supplier), clean(b.surat_jalan), foto_bukti, clean(b.lokasi), gudang]
    );
    res.status(201).json({ status: 'success', message: 'Receiving saved.' });
  } catch (error) { res.status(400).json({ status: 'error', message: error.message }); }
});

app.delete('/api/inbound/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const trx = await db.get('SELECT * FROM inbound_log WHERE transaction_id = ?', [req.params.id]);
    if (!trx) throw new Error('Transaction not found.');
    const gudang = trx.gudang || DEFAULT_WH;
    await assertDayOpen(gudang, trx.tanggal_masuk);
    const bal = await getBalance(trx.kode_barang, gudang);
    if (bal - trx.qty_masuk < 0) throw new Error(`Cannot cancel: stock in ${gudang} would become negative (current ${bal}).`);

    await db.exec('BEGIN TRANSACTION');
    await db.run("INSERT INTO audit_log (action, table_name, record_id, old_data, username) VALUES ('DELETE', 'inbound_log', ?, ?, ?)", [trx.transaction_id, JSON.stringify(trx), req.user.username]);
    await db.run('DELETE FROM inbound_log WHERE transaction_id = ?', [req.params.id]);
    await db.exec('COMMIT');
    res.json({ status: 'success', message: 'Transaction cancelled. Audit log recorded.' });
  } catch (error) {
    try { await db.exec('ROLLBACK'); } catch (e) { }
    res.status(400).json({ status: 'error', message: error.message });
  }
});

// ---------------------------------------------------------------- outbound (issuing / requisition chit)
app.get('/api/outbound', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT o.*, COALESCE(o.gudang,'${DEFAULT_WH}') AS gudang, m.nama_barang, m.satuan, m.kategori
      FROM outbound_log o JOIN master_stock m ON o.kode_barang = m.kode_barang
      ORDER BY o.tanggal_keluar DESC, o.created_at DESC LIMIT 500`);
    res.json({ status: 'success', data: rows });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/outbound', requireAuth, upload.single('foto'), async (req, res) => {
  const b = req.body;
  const qty = toNum(b.qty_keluar);
  const tanggal = b.tanggal_keluar;
  const gudang = clean(b.gudang, '');
  if (!validDate(tanggal)) return res.status(400).json({ status: 'error', message: 'Invalid date.' });
  if (!(qty > 0)) return res.status(400).json({ status: 'error', message: 'Quantity must be greater than 0.' });
  if (!clean(b.requisition_no, '')) return res.status(400).json({ status: 'error', message: 'Requisition No. is required.' });

  const foto_bukti = req.file ? `/uploads/${req.file.filename}` : (typeof b.foto_bukti === 'string' && b.foto_bukti.startsWith('data:image/') ? b.foto_bukti : null);
  try {
    const item = await getActiveItem(b.kode_barang);
    await getActiveWarehouse(gudang);
    await assertDayOpen(gudang, tanggal);
    const bal = await getBalance(b.kode_barang, gudang);
    if (bal < qty) throw new Error(`Insufficient stock in ${gudang}. Available: ${bal} ${item.satuan}`);

    let empty = null;
    if (b.empty_returned !== undefined && b.empty_returned !== '') {
      empty = toNum(b.empty_returned);
      if (!(empty >= 0)) throw new Error('Empty bags returned must be 0 or more.');
    }
    await db.run(
      `INSERT INTO outbound_log (transaction_id, tanggal_keluar, kode_barang, qty_keluar, kondisi_keluar, alasan_keluar, pic, foto_bukti, lokasi, gudang,
                                 requisition_no, block, phase, account_no, requested_by, approved_by, received_by, empty_returned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.transaction_id || genId('OUT'), tanggal, b.kode_barang, qty, clean(b.kondisi_keluar, 'OK'), clean(b.alasan_keluar), clean(b.pic, req.user.username), foto_bukti, clean(b.lokasi), gudang,
       clean(b.requisition_no), clean(b.block), clean(b.phase), clean(b.account_no), clean(b.requested_by), clean(b.approved_by), clean(b.received_by), empty]
    );
    res.status(201).json({ status: 'success', message: 'Issue saved.' });
  } catch (error) { res.status(400).json({ status: 'error', message: error.message }); }
});

// Record empty bags returned later (bags come back after the fertilizer is applied)
app.patch('/api/outbound/:id/empty-bags', requireAuth, async (req, res) => {
  try {
    const trx = await db.get('SELECT * FROM outbound_log WHERE transaction_id = ?', [req.params.id]);
    if (!trx) throw new Error('Transaction not found.');
    const v = toNum(req.body.empty_returned);
    if (!(v >= 0)) throw new Error('Empty bags returned must be 0 or more.');
    await db.run("INSERT INTO audit_log (action, table_name, record_id, old_data, username) VALUES ('UPDATE_EMPTY_BAGS', 'outbound_log', ?, ?, ?)",
      [trx.transaction_id, JSON.stringify({ empty_returned: trx.empty_returned, new_value: v }), req.user.username]);
    await db.run('UPDATE outbound_log SET empty_returned = ? WHERE transaction_id = ?', [v, req.params.id]);
    res.json({ status: 'success', message: 'Empty bags returned updated.' });
  } catch (error) { res.status(400).json({ status: 'error', message: error.message }); }
});

app.delete('/api/outbound/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const trx = await db.get('SELECT * FROM outbound_log WHERE transaction_id = ?', [req.params.id]);
    if (!trx) throw new Error('Transaction not found.');
    await assertDayOpen(trx.gudang || DEFAULT_WH, trx.tanggal_keluar);

    await db.exec('BEGIN TRANSACTION');
    await db.run("INSERT INTO audit_log (action, table_name, record_id, old_data, username) VALUES ('DELETE', 'outbound_log', ?, ?, ?)", [trx.transaction_id, JSON.stringify(trx), req.user.username]);
    await db.run('DELETE FROM outbound_log WHERE transaction_id = ?', [req.params.id]);
    await db.exec('COMMIT');
    res.json({ status: 'success', message: 'Transaction cancelled. Stock restored. Audit log recorded.' });
  } catch (error) {
    try { await db.exec('ROLLBACK'); } catch (e) {}
    res.status(400).json({ status: 'error', message: error.message });
  }
});

// Fertilizer daily log: issued bags vs empty bags returned
app.get('/api/fertilizer-log', requireAuth, async (req, res) => {
  try {
    const from = validDate(req.query.from) ? req.query.from : todayStr();
    const to = validDate(req.query.to) ? req.query.to : from;
    const params = [from, to];
    let whSql = '';
    if (req.query.gudang && req.query.gudang !== 'ALL') { whSql = " AND COALESCE(o.gudang,'" + DEFAULT_WH + "') = ?"; params.push(req.query.gudang); }
    const rows = await db.all(`
      SELECT o.transaction_id, o.tanggal_keluar, COALESCE(o.gudang,'${DEFAULT_WH}') AS gudang, o.kode_barang, m.nama_barang, m.satuan,
             o.qty_keluar, o.empty_returned, o.requisition_no, o.block, o.phase, o.received_by, o.alasan_keluar, o.pic
      FROM outbound_log o JOIN master_stock m ON m.kode_barang = o.kode_barang
      WHERE m.kategori = 'FERTILIZER' AND o.tanggal_keluar BETWEEN ? AND ? ${whSql}
      ORDER BY o.tanggal_keluar ASC, o.created_at ASC`, params);
    res.json({ status: 'success', data: rows });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// ---------------------------------------------------------------- bin card (ledger per item)
app.get('/api/bincard', requireAuth, async (req, res) => {
  try {
    const kode = req.query.kode_barang;
    const gudang = req.query.gudang && req.query.gudang !== 'ALL' ? req.query.gudang : null;
    const from = validDate(req.query.from) ? req.query.from : null;
    const to = validDate(req.query.to) ? req.query.to : null;
    const item = await db.get("SELECT kode_barang, nama_barang, COALESCE(kategori,'OTHER') AS kategori, satuan, COALESCE(conv_factor,0) AS conv_factor, COALESCE(conv_unit,'') AS conv_unit FROM master_stock WHERE kode_barang = ?", [kode]);
    if (!item) throw new Error('Item not found.');

    const whIn = gudang ? " AND COALESCE(gudang,'" + DEFAULT_WH + "') = ?" : '';
    const mk = (extra) => (gudang ? [kode, gudang, ...extra] : [kode, ...extra]);

    let opening = 0;
    if (from) {
      const r = await db.get(`SELECT COALESCE(SUM(qty),0) AS b FROM (${MOVES_SQL}) WHERE kode_barang = ? ${gudang ? 'AND gudang = ?' : ''} AND tanggal < ?`, mk([from]));
      opening = round3(r.b);
    } else {
      const bf = await db.get(`SELECT COALESCE(SUM(qty_masuk),0) AS b FROM inbound_log WHERE kode_barang = ? ${whIn} AND transaction_id LIKE 'BF-%'`, mk([]));
      opening = round3(bf ? bf.b : 0);
    }

    const rows = await db.all(`
      SELECT tanggal, kind, gudang, supplier, do_no, requisition_no, qty, allocation, pic, ref, created_at FROM (
        SELECT tanggal_masuk AS tanggal, 'IN' AS kind, COALESCE(gudang,'${DEFAULT_WH}') AS gudang,
               CASE WHEN supplier = '-' THEN '' ELSE COALESCE(supplier,'') END AS supplier,
               CASE WHEN surat_jalan = '-' THEN '' ELSE COALESCE(surat_jalan,'') END AS do_no,
               '' AS requisition_no,
               qty_masuk AS qty,
               CASE WHEN lokasi = '-' THEN '' ELSE COALESCE(lokasi,'') END AS allocation,
               pic, transaction_id AS ref, created_at
        FROM inbound_log WHERE kode_barang = ? ${whIn} ${!from ? "AND transaction_id NOT LIKE 'BF-%'" : ''}
        UNION ALL
        SELECT tanggal_keluar, 'OUT', COALESCE(gudang,'${DEFAULT_WH}'), '', '',
               CASE WHEN requisition_no = '-' THEN '' ELSE COALESCE(requisition_no,'') END,
               -qty_keluar, TRIM(
                 CASE
                   WHEN COALESCE(phase,'') NOT IN ('','-') AND COALESCE(block,'') NOT IN ('','-') THEN phase || '/' || block
                   WHEN COALESCE(block,'') NOT IN ('','-') THEN block
                   WHEN COALESCE(phase,'') NOT IN ('','-') THEN phase
                   ELSE ''
                 END ||
                 CASE WHEN COALESCE(alasan_keluar,'') NOT IN ('','-') THEN (CASE WHEN COALESCE(phase,'') NOT IN ('','-') OR COALESCE(block,'') NOT IN ('','-') THEN ' · ' ELSE '' END) || alasan_keluar ELSE '' END
               ), pic, transaction_id, created_at
        FROM outbound_log WHERE kode_barang = ? ${whIn}
        UNION ALL
        SELECT tanggal, 'ADJ', COALESCE(gudang,'${DEFAULT_WH}'), '', '', '',
               selisih, COALESCE(source,'Manual count'), pic, CAST(id AS TEXT), created_at
        FROM stock_opname WHERE kode_barang = ? ${whIn}
      ) WHERE 1=1 ${from ? 'AND tanggal >= ?' : ''} ${to ? 'AND tanggal <= ?' : ''}
      ORDER BY tanggal ASC, created_at ASC`,
      [
        ...(gudang ? [kode, gudang, kode, gudang, kode, gudang] : [kode, kode, kode]),
        ...(from ? [from] : []), ...(to ? [to] : [])
      ]);

    let balance = opening;
    const out = rows.map(r => { balance = round3(balance + r.qty); return { ...r, balance }; });
    res.json({ status: 'success', data: { item, opening, rows: out, closing: balance } });
  } catch (error) { res.status(400).json({ status: 'error', message: error.message }); }
});

// ---------------------------------------------------------------- daily closing
async function closingRows(date, gudang) {
  const rows = await db.all(`
    SELECT m.kode_barang, m.nama_barang, COALESCE(m.kategori,'OTHER') AS kategori, m.satuan,
           COALESCE(m.conv_factor,0) AS conv_factor, COALESCE(m.conv_unit,'') AS conv_unit,
           COALESCE(SUM(CASE WHEN v.tanggal < ? THEN v.qty END),0) AS opening,
           COALESCE(SUM(CASE WHEN v.tanggal = ? AND v.kind = 'IN' THEN v.qty END),0) AS qty_in,
           COALESCE(-SUM(CASE WHEN v.tanggal = ? AND v.kind = 'OUT' THEN v.qty END),0) AS qty_out,
           COALESCE(SUM(CASE WHEN v.tanggal = ? AND v.kind = 'ADJ' THEN v.qty END),0) AS adj,
           COALESCE(SUM(CASE WHEN v.tanggal <= ? THEN v.qty END),0) AS expected
    FROM master_stock m
    JOIN (${MOVES_SQL}) v ON v.kode_barang = m.kode_barang AND v.gudang = ?
    WHERE COALESCE(m.aktif,1) = 1
    GROUP BY m.kode_barang
    ORDER BY m.kategori, m.nama_barang`, [date, date, date, date, date, gudang]);
  return rows.map(r => ({
    ...r,
    opening: round3(r.opening), qty_in: round3(r.qty_in), qty_out: round3(r.qty_out), adj: round3(r.adj), expected: round3(r.expected)
  }));
}

app.get('/api/closing/preview', requireAuth, async (req, res) => {
  try {
    const date = req.query.date;
    const gudang = req.query.gudang;
    if (!validDate(date)) throw new Error('Invalid date.');
    const wh = await db.get('SELECT * FROM warehouses WHERE code = ?', [gudang]);
    if (!wh) throw new Error('Warehouse not found.');

    const rows = await closingRows(date, gudang);
    const day = await db.get('SELECT * FROM closing_days WHERE tanggal = ? AND gudang = ?', [date, gudang]);
    if (day) {
      const saved = await db.all('SELECT kode_barang, opening, qty_in, qty_out, adj, expected, physical, selisih, reason FROM daily_closing WHERE tanggal = ? AND gudang = ?', [date, gudang]);
      const sm = {}; saved.forEach(s => { sm[s.kode_barang] = s; });
      rows.forEach(r => {
        const s = sm[r.kode_barang];
        if (s) { Object.assign(r, { opening: s.opening, qty_in: s.qty_in, qty_out: s.qty_out, adj: s.adj, expected: s.expected, saved_physical: s.physical, saved_selisih: s.selisih, saved_reason: s.reason }); }
      });
    }
    const last = await lastClosedDate(gudang);
    res.json({ status: 'success', data: { date, gudang, closed: !!day, closed_by: day ? day.closed_by : null, closed_at: day ? day.created_at : null, last_closed: last, rows } });
  } catch (error) { res.status(400).json({ status: 'error', message: error.message }); }
});

app.post('/api/closing', requireAuth, async (req, res) => {
  const { tanggal, gudang } = req.body;
  const submitted = Array.isArray(req.body.rows) ? req.body.rows : [];
  try {
    if (!validDate(tanggal)) throw new Error('Invalid date.');
    if (tanggal > todayStr()) throw new Error('Cannot close a future date.');
    await getActiveWarehouse(gudang);
    const existing = await db.get('SELECT 1 AS x FROM closing_days WHERE tanggal = ? AND gudang = ?', [tanggal, gudang]);
    if (existing) throw new Error(`${tanggal} is already closed for ${gudang}.`);

    const rows = await closingRows(tanggal, gudang);
    if (rows.length === 0) throw new Error('There are no items to count in this warehouse.');
    const sm = {}; submitted.forEach(s => { sm[s.kode_barang] = s; });

    // All items must be counted
    const missing = rows.filter(r => !sm[r.kode_barang] || sm[r.kode_barang].physical === '' || sm[r.kode_barang].physical === null || sm[r.kode_barang].physical === undefined);
    if (missing.length) throw new Error(`Physical count is required for every item. Missing: ${missing.slice(0, 5).map(m => m.nama_barang).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`);

    const prepared = [];
    for (const r of rows) {
      const s = sm[r.kode_barang];
      const physical = toNum(s.physical);
      if (!(physical >= 0)) throw new Error(`Invalid physical count for ${r.nama_barang}.`);
      const diff = round3(physical - r.expected);
      const reason = clean(s.reason, '');
      if (diff !== 0 && !reason) throw new Error(`Please give a reason for the difference on ${r.nama_barang} (${diff > 0 ? '+' : ''}${diff}).`);
      prepared.push({ r, physical: round3(physical), diff, reason });
    }

    await db.exec('BEGIN TRANSACTION');
    for (const p of prepared) {
      await db.run(
        `INSERT INTO daily_closing (tanggal, gudang, kode_barang, opening, qty_in, qty_out, adj, expected, physical, selisih, reason, pic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tanggal, gudang, p.r.kode_barang, p.r.opening, p.r.qty_in, p.r.qty_out, p.r.adj, p.r.expected, p.physical, p.diff, p.reason, req.user.username]
      );
      if (p.diff !== 0) {
        await db.run(
          `INSERT INTO stock_opname (tanggal, kode_barang, qty_sistem, qty_fisik, selisih, pic, gudang, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [tanggal, p.r.kode_barang, p.r.expected, p.physical, p.diff, req.user.username, gudang, `CLOSING:${tanggal}`]
        );
      }
    }
    await db.run('INSERT INTO closing_days (tanggal, gudang, closed_by) VALUES (?, ?, ?)', [tanggal, gudang, req.user.username]);
    const mismatches = prepared.filter(p => p.diff !== 0).length;
    await db.run("INSERT INTO audit_log (action, table_name, record_id, old_data, username) VALUES ('CLOSE_DAY', 'closing_days', ?, ?, ?)",
      [`${gudang}|${tanggal}`, JSON.stringify({ items: prepared.length, mismatches }), req.user.username]);
    await db.exec('COMMIT');
    const backupFile = await createBackupSnapshot(`close_${gudang}_${tanggal}`);

    res.status(201).json({ status: 'success', message: `Day ${tanggal} closed for ${gudang}. ${prepared.length} item(s) counted, ${mismatches} difference(s).`, data: { items: prepared.length, mismatches, backupFile } });
  } catch (error) {
    try { await db.exec('ROLLBACK'); } catch (e) { }
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.get('/api/closing/history', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT c.tanggal, c.gudang, c.closed_by, c.created_at,
        (SELECT COUNT(*) FROM daily_closing d WHERE d.tanggal = c.tanggal AND d.gudang = c.gudang) AS items,
        (SELECT COUNT(*) FROM daily_closing d WHERE d.tanggal = c.tanggal AND d.gudang = c.gudang AND d.selisih != 0) AS mismatches
      FROM closing_days c ORDER BY c.tanggal DESC, c.gudang ASC LIMIT 60`);
    res.json({ status: 'success', data: rows });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// Reopen: only the most recent closed day of a warehouse (keeps later opening balances valid)
app.delete('/api/closing/:gudang/:date', requireAuth, requireAdmin, async (req, res) => {
  const { gudang, date } = req.params;
  try {
    const last = await lastClosedDate(gudang);
    if (!last || last !== date) throw new Error(`Only the most recent closed day can be reopened${last ? ` (${last})` : ''}.`);
    const saved = await db.all('SELECT * FROM daily_closing WHERE tanggal = ? AND gudang = ?', [date, gudang]);

    await db.exec('BEGIN TRANSACTION');
    await db.run("INSERT INTO audit_log (action, table_name, record_id, old_data, username) VALUES ('REOPEN_DAY', 'closing_days', ?, ?, ?)", [`${gudang}|${date}`, JSON.stringify(saved), req.user.username]);
    await db.run('DELETE FROM stock_opname WHERE gudang = ? AND source = ?', [gudang, `CLOSING:${date}`]);
    await db.run('DELETE FROM daily_closing WHERE tanggal = ? AND gudang = ?', [date, gudang]);
    await db.run('DELETE FROM closing_days WHERE tanggal = ? AND gudang = ?', [date, gudang]);
    await db.exec('COMMIT');
    res.json({ status: 'success', message: `Day ${date} reopened for ${gudang}. Adjustments from that closing were reversed.` });
  } catch (error) {
    try { await db.exec('ROLLBACK'); } catch (e) { }
    res.status(400).json({ status: 'error', message: error.message });
  }
});

// ---------------------------------------------------------------- data sync & backups
function computeSyncDigest(payload) {
  const raw = JSON.stringify({
    warehouses: (payload.warehouses || []).length,
    items: (payload.items || []).length,
    inbound: (payload.inbound || []).map(x => [x.transaction_id, x.tanggal_masuk, x.qty_masuk]),
    outbound: (payload.outbound || []).map(x => [x.transaction_id, x.tanggal_keluar, x.qty_keluar, x.empty_returned]),
    daily_closing: (payload.daily_closing || []).map(x => [x.tanggal, x.gudang, x.kode_barang, x.physical])
  });
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16).toUpperCase();
}

app.get('/api/sync/export', requireAuth, async (req, res) => {
  try {
    const from = validDate(req.query.from) ? req.query.from : todayStr();
    const to = validDate(req.query.to) ? req.query.to : from;
    if (from > to) throw new Error('Start date cannot be after end date.');
    const gudang = req.query.gudang && req.query.gudang !== 'ALL' ? req.query.gudang : null;

    const whFilterIn = gudang ? ` AND COALESCE(gudang,'${DEFAULT_WH}') = ?` : '';
    const whArgs = gudang ? [from, to, gudang] : [from, to];

    const warehouses = await db.all('SELECT code, name, remarks, aktif FROM warehouses ORDER BY code ASC');
    const items = await db.all(`SELECT kode_barang, nama_barang, COALESCE(kategori,'OTHER') AS kategori, satuan, COALESCE(conv_factor,0) AS conv_factor, COALESCE(conv_unit,'') AS conv_unit, min_stock_alert, COALESCE(aktif,1) AS aktif FROM master_stock ORDER BY kode_barang ASC`);
    const inbound = await db.all(`SELECT transaction_id, tanggal_masuk, COALESCE(gudang,'${DEFAULT_WH}') AS gudang, kode_barang, qty_masuk, pic, supplier, surat_jalan, lokasi, created_at FROM inbound_log WHERE tanggal_masuk BETWEEN ? AND ?${whFilterIn} ORDER BY tanggal_masuk ASC, created_at ASC`, whArgs);
    const outbound = await db.all(`SELECT transaction_id, tanggal_keluar, COALESCE(gudang,'${DEFAULT_WH}') AS gudang, kode_barang, qty_keluar, kondisi_keluar, alasan_keluar, pic, lokasi, requisition_no, block, phase, account_no, requested_by, approved_by, received_by, empty_returned, created_at FROM outbound_log WHERE tanggal_keluar BETWEEN ? AND ?${whFilterIn} ORDER BY tanggal_keluar ASC, created_at ASC`, whArgs);
    const closing_days = await db.all(`SELECT tanggal, gudang, closed_by, created_at FROM closing_days WHERE tanggal BETWEEN ? AND ?${gudang ? ' AND gudang = ?' : ''} ORDER BY tanggal ASC`, whArgs);
    const daily_closing = await db.all(`SELECT tanggal, gudang, kode_barang, opening, qty_in, qty_out, adj, expected, physical, selisih, reason, pic, created_at FROM daily_closing WHERE tanggal BETWEEN ? AND ?${gudang ? ' AND gudang = ?' : ''} ORDER BY tanggal ASC, kode_barang ASC`, whArgs);

    const dateSet = new Set();
    inbound.forEach(r => dateSet.add(r.tanggal_masuk));
    outbound.forEach(r => dateSet.add(r.tanggal_keluar));
    closing_days.forEach(r => dateSet.add(r.tanggal));
    if (dateSet.size === 0) dateSet.add(from);
    const dates = [...dateSet].sort();

    const pkg = {
      meta: {
        format: 'GUDANGPRO_SYNC_V1',
        version: '3.1.0',
        exported_at: new Date().toISOString(),
        exported_by: req.user.username,
        from,
        to,
        gudang: gudang || 'ALL',
        dates
      },
      warehouses,
      items,
      inbound,
      outbound,
      closing_days,
      daily_closing
    };
    pkg.meta.checksum = computeSyncDigest(pkg);
    res.json({ status: 'success', data: pkg });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

async function analyzeSyncPackage(pkg, selectedDatesInput) {
  if (!pkg || !pkg.meta || pkg.meta.format !== 'GUDANGPRO_SYNC_V1') {
    throw new Error('Invalid sync file format. Expected GUDANGPRO_SYNC_V1 package.');
  }
  const inboundAll = Array.isArray(pkg.inbound) ? pkg.inbound : [];
  const outboundAll = Array.isArray(pkg.outbound) ? pkg.outbound : [];
  const closingDaysAll = Array.isArray(pkg.closing_days) ? pkg.closing_days : [];
  const dailyClosingAll = Array.isArray(pkg.daily_closing) ? pkg.daily_closing : [];
  const whAll = Array.isArray(pkg.warehouses) ? pkg.warehouses : [];
  const itemsAll = Array.isArray(pkg.items) ? pkg.items : [];

  const dateMap = {};
  const ensureDate = (d) => {
    if (!validDate(d)) return null;
    if (!dateMap[d]) dateMap[d] = { date: d, inbound: 0, outbound: 0, closing: 0 };
    return dateMap[d];
  };
  inboundAll.forEach(r => { const x = ensureDate(r.tanggal_masuk); if (x) x.inbound++; });
  outboundAll.forEach(r => { const x = ensureDate(r.tanggal_keluar); if (x) x.outbound++; });
  closingDaysAll.forEach(r => { const x = ensureDate(r.tanggal); if (x) x.closing++; });
  if (Object.keys(dateMap).length === 0 && Array.isArray(pkg.meta.dates)) {
    pkg.meta.dates.forEach(d => ensureDate(d));
  }
  const availableDates = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
  const selectedSet = new Set(
    Array.isArray(selectedDatesInput) && selectedDatesInput.length
      ? selectedDatesInput.filter(validDate)
      : availableDates.map(d => d.date)
  );

  // Local state lookup
  const localWh = new Map((await db.all('SELECT * FROM warehouses')).map(w => [w.code, w]));
  const localItems = new Map((await db.all('SELECT * FROM master_stock')).map(i => [i.kode_barang, i]));
  const localIn = new Map((await db.all('SELECT transaction_id, tanggal_masuk, qty_masuk FROM inbound_log')).map(r => [r.transaction_id, r]));
  const localOut = new Map((await db.all('SELECT transaction_id, tanggal_keluar, qty_keluar, empty_returned FROM outbound_log')).map(r => [r.transaction_id, r]));
  const localClosed = new Map((await db.all('SELECT tanggal, gudang, closed_by FROM closing_days')).map(r => [`${r.gudang}|${r.tanggal}`, r]));

  const itemNameOf = (code) => {
    const pkgIt = itemsAll.find(i => i.kode_barang === code);
    if (pkgIt) return { name: pkgIt.nama_barang, unit: pkgIt.satuan };
    const locIt = localItems.get(code);
    return { name: locIt ? locIt.nama_barang : code, unit: locIt ? locIt.satuan : '' };
  };

  // Filter transactions by selected dates
  const inbound = inboundAll.filter(r => selectedSet.has(r.tanggal_masuk)).map(r => {
    const exists = localIn.has(r.transaction_id);
    const info = itemNameOf(r.kode_barang);
    return { ...r, nama_barang: info.name, satuan: info.unit, action: exists ? 'SKIP' : 'NEW' };
  });

  const outbound = outboundAll.filter(r => selectedSet.has(r.tanggal_keluar)).map(r => {
    const existing = localOut.get(r.transaction_id);
    const info = itemNameOf(r.kode_barang);
    let action = 'NEW';
    if (existing) {
      const incomingBags = r.empty_returned !== null && r.empty_returned !== undefined ? round3(r.empty_returned) : null;
      const currentBags = existing.empty_returned !== null && existing.empty_returned !== undefined ? round3(existing.empty_returned) : null;
      action = (incomingBags !== null && incomingBags !== currentBags) ? 'UPDATE_BAGS' : 'SKIP';
    }
    return { ...r, nama_barang: info.name, satuan: info.unit, action };
  });

  const closing = closingDaysAll.filter(r => selectedSet.has(r.tanggal)).map(r => {
    const key = `${r.gudang}|${r.tanggal}`;
    const exists = localClosed.has(key);
    const details = dailyClosingAll.filter(d => d.tanggal === r.tanggal && d.gudang === r.gudang);
    const mismatches = details.filter(d => round3(d.selisih) !== 0).length;
    return { ...r, itemsCount: details.length, mismatches, action: exists ? 'UPDATE' : 'NEW' };
  });

  // Master records referenced or new
  const refWh = new Set([...inbound.map(r => r.gudang), ...outbound.map(r => r.gudang), ...closing.map(r => r.gudang)]);
  const warehouses = whAll.filter(w => refWh.has(w.code) || !localWh.has(w.code)).map(w => ({
    ...w,
    action: localWh.has(w.code) ? 'EXISTS' : 'NEW'
  }));

  const refItems = new Set([
    ...inbound.map(r => r.kode_barang),
    ...outbound.map(r => r.kode_barang),
    ...dailyClosingAll.filter(d => selectedSet.has(d.tanggal)).map(d => d.kode_barang)
  ]);
  const items = itemsAll.filter(i => refItems.has(i.kode_barang) || !localItems.has(i.kode_barang)).map(i => ({
    ...i,
    action: localItems.has(i.kode_barang) ? 'EXISTS' : 'NEW'
  }));

  return {
    meta: pkg.meta,
    checksumValid: computeSyncDigest(pkg) === pkg.meta.checksum,
    availableDates,
    selectedDates: [...selectedSet].sort(),
    warehouses,
    items,
    inbound,
    outbound,
    closing,
    dailyClosing: dailyClosingAll.filter(d => selectedSet.has(d.tanggal)),
    counts: {
      newWarehouses: warehouses.filter(w => w.action === 'NEW').length,
      newItems: items.filter(i => i.action === 'NEW').length,
      newInbound: inbound.filter(r => r.action === 'NEW').length,
      skippedInbound: inbound.filter(r => r.action === 'SKIP').length,
      newOutbound: outbound.filter(r => r.action === 'NEW').length,
      updatedBags: outbound.filter(r => r.action === 'UPDATE_BAGS').length,
      skippedOutbound: outbound.filter(r => r.action === 'SKIP').length,
      newClosing: closing.filter(r => r.action === 'NEW').length,
      updatedClosing: closing.filter(r => r.action === 'UPDATE').length
    }
  };
}

app.post('/api/sync/inspect', requireAuth, async (req, res) => {
  try {
    const plan = await analyzeSyncPackage(req.body.package, req.body.selectedDates);
    res.json({ status: 'success', data: plan });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.post('/api/sync/import', requireAuth, async (req, res) => {
  try {
    const plan = await analyzeSyncPackage(req.body.package, req.body.selectedDates);
    if (plan.selectedDates.length === 0) throw new Error('Select at least one date to import.');

    const backupFile = await createBackupSnapshot('pre_sync');
    const operations = [];

    await db.exec('BEGIN TRANSACTION');

    // 1. Warehouses
    for (const w of plan.warehouses) {
      if (w.action === 'NEW') {
        await db.run('INSERT OR IGNORE INTO warehouses (code, name, remarks, aktif) VALUES (?, ?, ?, ?)',
          [w.code, clean(w.name, w.code), clean(w.remarks, ''), w.aktif === 0 ? 0 : 1]);
        operations.push({ stage: 'MASTER', kind: 'WAREHOUSE', action: 'ADDED', code: w.code, label: w.name, detail: 'Warehouse registered' });
      }
    }

    // 2. Master Stock Items
    for (const it of plan.items) {
      if (it.action === 'NEW') {
        const cat = CATEGORIES.includes(it.kategori) ? it.kategori : 'OTHER';
        await db.run(
          `INSERT OR IGNORE INTO master_stock (kode_barang, nama_barang, ca_barang, satuan, lokasi_gudang, lokasi_rak, kondisi, qty_total, min_stock_alert, kategori, conv_factor, conv_unit, aktif)
           VALUES (?, ?, '-', ?, '-', '-', 'OK', 0, ?, ?, ?, ?, ?)`,
          [it.kode_barang, it.nama_barang, clean(it.satuan, 'pcs'), toNum(it.min_stock_alert) || 0, cat, toNum(it.conv_factor) || 0, clean(it.conv_unit, ''), it.aktif === 0 ? 0 : 1]
        );
        operations.push({ stage: 'MASTER', kind: 'ITEM', action: 'ADDED', code: it.kode_barang, label: it.nama_barang, detail: `${cat} (${it.satuan})` });
      }
    }

    // 3. Inbound (Receiving)
    for (const r of plan.inbound) {
      if (r.action === 'NEW') {
        await db.run(
          `INSERT INTO inbound_log (transaction_id, tanggal_masuk, kode_barang, qty_masuk, pic, supplier, surat_jalan, foto_bukti, lokasi, gudang)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          [r.transaction_id, r.tanggal_masuk, r.kode_barang, toNum(r.qty_masuk) || 0, clean(r.pic, 'sync'), clean(r.supplier), clean(r.surat_jalan), clean(r.lokasi), clean(r.gudang, DEFAULT_WH)]
        );
        operations.push({ stage: 'INBOUND', kind: 'RECEIVING', action: 'ADDED', date: r.tanggal_masuk, code: r.transaction_id, label: r.nama_barang, detail: `+${r.qty_masuk} ${r.satuan} · D/O ${clean(r.surat_jalan)} · ${r.gudang}` });
      } else {
        operations.push({ stage: 'INBOUND', kind: 'RECEIVING', action: 'SKIPPED', date: r.tanggal_masuk, code: r.transaction_id, label: r.nama_barang, detail: `Already exists (${r.qty_masuk} ${r.satuan})` });
      }
    }

    // 4. Outbound (Issuing & Empty Bags)
    for (const r of plan.outbound) {
      if (r.action === 'NEW') {
        const emptyVal = r.empty_returned === null || r.empty_returned === undefined || r.empty_returned === '' ? null : toNum(r.empty_returned);
        await db.run(
          `INSERT INTO outbound_log (transaction_id, tanggal_keluar, kode_barang, qty_keluar, kondisi_keluar, alasan_keluar, pic, foto_bukti, lokasi, gudang,
                                     requisition_no, block, phase, account_no, requested_by, approved_by, received_by, empty_returned)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.transaction_id, r.tanggal_keluar, r.kode_barang, toNum(r.qty_keluar) || 0, clean(r.kondisi_keluar, 'OK'), clean(r.alasan_keluar), clean(r.pic, 'sync'), clean(r.lokasi), clean(r.gudang, DEFAULT_WH),
          clean(r.requisition_no), clean(r.block), clean(r.phase), clean(r.account_no), clean(r.requested_by), clean(r.approved_by), clean(r.received_by), emptyVal]
        );
        operations.push({ stage: 'OUTBOUND', kind: 'ISSUING', action: 'ADDED', date: r.tanggal_keluar, code: `REQ #${clean(r.requisition_no)}`, label: r.nama_barang, detail: `-${r.qty_keluar} ${r.satuan} · Blk ${clean(r.block)} · ${r.gudang}` });
      } else if (r.action === 'UPDATE_BAGS') {
        const emptyVal = toNum(r.empty_returned);
        await db.run('UPDATE outbound_log SET empty_returned = ? WHERE transaction_id = ?', [emptyVal, r.transaction_id]);
        operations.push({ stage: 'OUTBOUND', kind: 'EMPTY_BAGS', action: 'UPDATED', date: r.tanggal_keluar, code: `REQ #${clean(r.requisition_no)}`, label: r.nama_barang, detail: `Empty bags returned: ${emptyVal}` });
      } else {
        operations.push({ stage: 'OUTBOUND', kind: 'ISSUING', action: 'SKIPPED', date: r.tanggal_keluar, code: `REQ #${clean(r.requisition_no)}`, label: r.nama_barang, detail: `Already exists (${r.qty_keluar} ${r.satuan})` });
      }
    }

    // 5. Daily Closing & Physical Counts
    for (const c of plan.closing) {
      const rowsForDay = plan.dailyClosing.filter(d => d.tanggal === c.tanggal && d.gudang === c.gudang);
      await db.run('DELETE FROM stock_opname WHERE gudang = ? AND source = ?', [c.gudang, `CLOSING:${c.tanggal}`]);
      await db.run('DELETE FROM daily_closing WHERE tanggal = ? AND gudang = ?', [c.tanggal, c.gudang]);
      for (const d of rowsForDay) {
        const diff = round3(toNum(d.selisih) || 0);
        await db.run(
          `INSERT INTO daily_closing (tanggal, gudang, kode_barang, opening, qty_in, qty_out, adj, expected, physical, selisih, reason, pic)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [d.tanggal, d.gudang, d.kode_barang, round3(d.opening), round3(d.qty_in), round3(d.qty_out), round3(d.adj), round3(d.expected), round3(d.physical), diff, clean(d.reason, ''), clean(d.pic, c.closed_by || req.user.username)]
        );
        if (diff !== 0) {
          await db.run(
            `INSERT INTO stock_opname (tanggal, kode_barang, qty_sistem, qty_fisik, selisih, pic, gudang, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [d.tanggal, d.kode_barang, round3(d.expected), round3(d.physical), diff, clean(d.pic, c.closed_by || req.user.username), d.gudang, `CLOSING:${d.tanggal}`]
          );
        }
      }
      await db.run('INSERT OR REPLACE INTO closing_days (tanggal, gudang, closed_by) VALUES (?, ?, ?)',
        [c.tanggal, c.gudang, clean(c.closed_by, req.user.username)]);
      operations.push({ stage: 'CLOSING', kind: 'CLOSING', action: c.action === 'NEW' ? 'ADDED' : 'UPDATED', date: c.tanggal, code: c.gudang, label: `Daily Closing ${c.tanggal}`, detail: `${rowsForDay.length} item(s) verified, ${c.mismatches} diff(s)` });
    }

    await db.run(
      "INSERT INTO audit_log (action, table_name, record_id, old_data, username) VALUES ('SYNC_IMPORT', 'sync', ?, ?, ?)",
      [plan.selectedDates.join(','), JSON.stringify({ counts: plan.counts, backupFile, checksum: plan.meta.checksum }), req.user.username]
    );

    await db.exec('COMMIT');

    res.json({
      status: 'success',
      message: `Synchronized ${plan.selectedDates.length} date(s) successfully.`,
      data: {
        backupFile,
        selectedDates: plan.selectedDates,
        counts: plan.counts,
        operations
      }
    });
  } catch (error) {
    try { await db.exec('ROLLBACK'); } catch (e) { }
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.get('/api/backups', requireAuth, async (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, created_at: new Date(st.mtimeMs).toISOString() };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const jm = await db.get('PRAGMA journal_mode');
    res.json({ status: 'success', data: { journal_mode: (jm && jm.journal_mode) || 'wal', backup_dir: BACKUP_DIR, files } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/backups/create', requireAuth, async (req, res) => {
  try {
    const file = await createBackupSnapshot('manual');
    if (!file) throw new Error('Could not create backup snapshot.');
    res.status(201).json({ status: 'success', message: `Snapshot created: ${file}`, data: { name: file } });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.get('/api/backups/download/:name', requireAuth, async (req, res) => {
  try {
    const safe = path.basename(req.params.name);
    const full = path.join(BACKUP_DIR, safe);
    if (!fs.existsSync(full)) return res.status(404).json({ status: 'error', message: 'Backup file not found.' });
    res.download(full, safe);
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.get('/api/network-info', (req, res) => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        urls.push({ interface: name, ip: net.address, url: `http://${net.address}:${PORT}` });
      }
    }
  }
  const httpsUrl = process.env.GUDANGPRO_PUBLIC_URL || null;
  res.json({ status: 'success', data: { port: Number(PORT), urls, httpsUrl, hostname: os.hostname() } });
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ status: 'error', message: 'Photo size must be 5MB or less.' });
    return res.status(400).json({ status: 'error', message: err.message });
  }
  console.error(err);
  res.status(500).json({ status: 'error', message: err.message || 'Server error' });
});

const PORT = process.env.PORT || process.env.GUDANGPRO_PORT || 3000;
let server;
const ready = initDB().then(() => {
  server = app.listen(PORT, '0.0.0.0', () => console.log(`Warehouse API Server running at http://localhost:${PORT}`));
  return server;
}).catch((e) => { console.error('Failed to initialise database:', e); process.exit(1); });

module.exports = { app, ready };
