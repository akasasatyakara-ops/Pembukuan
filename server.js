const path = require('path');
const express = require('express');
const { createClient } = require('@libsql/client');

// ---------- Setup database --------------------------------------------------
// Sebelumnya pakai better-sqlite3 (file lokal saja). Sekarang diganti
// @libsql/client supaya bisa konek ke Turso (SQLite yang di-hosting di
// cloud, gratis, dan datanya PERMANEN walau server di Render di-restart
// atau redeploy — beda dengan disk gratis Render yang sifatnya sementara).
//
// Kalau env TURSO_DATABASE_URL diset (nanti diisi di pengaturan Render),
// server ini konek ke database Turso di cloud.
// Kalau env itu TIDAK diset, server otomatis pakai file SQLite lokal
// (akasa_verse.db) seperti sebelumnya — supaya tetap bisa dites di
// komputer sendiri tanpa perlu akun Turso.
const db = createClient(
  process.env.TURSO_DATABASE_URL
    ? {
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      }
    : {
        url: `file:${path.join(__dirname, 'akasa_verse.db')}`,
      }
);

// PENTING: @libsql/client itu ASYNC (beda dari better-sqlite3 yang sync).
// Jadi semua query di bawah ini sekarang pakai async/await.
async function siapkanDatabase() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS transaksi (
      id          TEXT PRIMARY KEY,
      tanggal     TEXT NOT NULL,
      akun        TEXT NOT NULL CHECK (akun IN ('kas','bank')),
      jenis       TEXT NOT NULL CHECK (jenis IN ('masuk','keluar')),
      kategori    TEXT,
      keterangan  TEXT,
      jumlah      REAL NOT NULL,
      dibuat_pada TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Saldo awal default kalau belum pernah diisi
  const defaultSaldoAwal = { kas: 0, bank: 0 };
  const cek = await db.execute({ sql: 'SELECT 1 FROM settings WHERE key = ?', args: ['saldo_awal'] });
  if (cek.rows.length === 0) {
    await db.execute({
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?)',
      args: ['saldo_awal', JSON.stringify(defaultSaldoAwal)],
    });
  }
}

// Baris hasil query dari @libsql/client itu array-like (bukan objek biasa
// seperti punya better-sqlite3), jadi diubah dulu jadi objek supaya
// res.json(...) hasilnya tetap sama seperti sebelumnya.
function keObjekTransaksi(row) {
  return {
    id: row[0],
    tanggal: row[1],
    akun: row[2],
    jenis: row[3],
    kategori: row[4],
    keterangan: row[5],
    jumlah: row[6],
    dibuat_pada: row[7],
  };
}

// ---------- Setup server ------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API: saldo awal ---------------------------------------------------

app.get('/api/saldo-awal', async (req, res) => {
  const hasil = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: ['saldo_awal'] });
  res.json(JSON.parse(hasil.rows[0][0]));
});

app.post('/api/saldo-awal', async (req, res) => {
  const kas = Number(req.body.kas) || 0;
  const bank = Number(req.body.bank) || 0;
  await db.execute({
    sql: 'UPDATE settings SET value = ? WHERE key = ?',
    args: [JSON.stringify({ kas, bank }), 'saldo_awal'],
  });
  res.json({ kas, bank });
});

// ---------- API: transaksi -----------------------------------------------------

app.get('/api/transaksi', async (req, res) => {
  const hasil = await db.execute('SELECT * FROM transaksi ORDER BY tanggal ASC, id ASC');
  res.json(hasil.rows.map(keObjekTransaksi));
});

app.post('/api/transaksi', async (req, res) => {
  const { tanggal, akun, jenis, kategori, keterangan, jumlah } = req.body;

  if (!tanggal || !['kas', 'bank'].includes(akun) || !['masuk', 'keluar'].includes(jenis)) {
    return res.status(400).json({ error: 'Data tidak lengkap atau tidak valid' });
  }
  if (!keterangan || !keterangan.trim()) {
    return res.status(400).json({ error: 'Keterangan wajib diisi' });
  }
  const jumlahNum = Number(jumlah);
  if (!jumlahNum || jumlahNum <= 0) {
    return res.status(400).json({ error: 'Jumlah harus lebih dari 0' });
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await db.execute({
    sql: `INSERT INTO transaksi (id, tanggal, akun, jenis, kategori, keterangan, jumlah)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, tanggal, akun, jenis, (kategori || '-').trim(), keterangan.trim(), jumlahNum],
  });

  const hasil = await db.execute({ sql: 'SELECT * FROM transaksi WHERE id = ?', args: [id] });
  res.json(keObjekTransaksi(hasil.rows[0]));
});

app.put('/api/transaksi/:id', async (req, res) => {
  const existing = await db.execute({ sql: 'SELECT * FROM transaksi WHERE id = ?', args: [req.params.id] });
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

  const { tanggal, akun, jenis, kategori, keterangan, jumlah } = req.body;

  if (!tanggal || !['kas', 'bank'].includes(akun) || !['masuk', 'keluar'].includes(jenis)) {
    return res.status(400).json({ error: 'Data tidak lengkap atau tidak valid' });
  }
  if (!keterangan || !keterangan.trim()) {
    return res.status(400).json({ error: 'Keterangan wajib diisi' });
  }
  const jumlahNum = Number(jumlah);
  if (!jumlahNum || jumlahNum <= 0) {
    return res.status(400).json({ error: 'Jumlah harus lebih dari 0' });
  }

  await db.execute({
    sql: `UPDATE transaksi SET tanggal=?, akun=?, jenis=?, kategori=?, keterangan=?, jumlah=?
          WHERE id=?`,
    args: [tanggal, akun, jenis, (kategori || '-').trim(), keterangan.trim(), jumlahNum, req.params.id],
  });

  const hasil = await db.execute({ sql: 'SELECT * FROM transaksi WHERE id = ?', args: [req.params.id] });
  res.json(keObjekTransaksi(hasil.rows[0]));
});

app.delete('/api/transaksi/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM transaksi WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- API: cadangan (backup / restore) ------------------------------------

app.get('/api/backup', async (req, res) => {
  const baris = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: ['saldo_awal'] });
  const saldoAwal = JSON.parse(baris.rows[0][0]);
  const hasilTransaksi = await db.execute('SELECT * FROM transaksi ORDER BY tanggal ASC, id ASC');
  const transaksi = hasilTransaksi.rows.map(keObjekTransaksi);
  res.setHeader('Content-Disposition', `attachment; filename="akasa-verse-cadangan-${new Date().toISOString().slice(0,10)}.json"`);
  res.json({ saldoAwal, transaksi, dibuatPada: new Date().toISOString() });
});

app.post('/api/restore', async (req, res) => {
  const { saldoAwal, transaksi } = req.body;
  if (!saldoAwal || !Array.isArray(transaksi)) {
    return res.status(400).json({ error: 'Format file cadangan tidak sesuai' });
  }

  // Sebelumnya pakai db.transaction() punya better-sqlite3 (sync).
  // Versi @libsql/client yang setara adalah db.batch([...], 'write'):
  // semua perintah di dalamnya dijalankan sebagai satu transaksi juga.
  const perintah = [
    {
      sql: 'UPDATE settings SET value = ? WHERE key = ?',
      args: [JSON.stringify({ kas: Number(saldoAwal.kas) || 0, bank: Number(saldoAwal.bank) || 0 }), 'saldo_awal'],
    },
    { sql: 'DELETE FROM transaksi', args: [] },
  ];

  for (const t of transaksi) {
    perintah.push({
      sql: `INSERT INTO transaksi (id, tanggal, akun, jenis, kategori, keterangan, jumlah, dibuat_pada)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        t.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
        t.tanggal, t.akun, t.jenis, t.kategori || '-', t.keterangan, Number(t.jumlah) || 0,
        t.dibuat_pada || new Date().toISOString(),
      ],
    });
  }

  await db.batch(perintah, 'write');

  res.json({ ok: true });
});

// ---------- Jalankan server ------------------------------------------------------
// '0.0.0.0' supaya bisa diakses dari perangkat lain di jaringan lokal (LAN),
// bukan cuma dari komputer ini sendiri — dan juga supaya jalan dengan benar
// saat di-deploy ke Render.

const PORT = process.env.PORT || 3000;

// TAMBAHAN: siapkan tabel dulu (async) sebelum server mulai menerima request,
// supaya tidak ada request yang nyasar ke tabel yang belum dibuat.
siapkanDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`AKASA VERSE berjalan di:`);
      console.log(`  - Lokal   : http://localhost:${PORT}`);
      console.log(`  - Jaringan: http://<IP-komputer-ini>:${PORT}  (cek dengan "ipconfig")`);
      console.log(
        process.env.TURSO_DATABASE_URL
          ? `  - Database: Turso (cloud, permanen)`
          : `  - Database: file lokal (akasa_verse.db)`
      );
    });
  })
  .catch((err) => {
    console.error('Gagal menyiapkan database:', err);
    process.exit(1);
  });
