const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { createClient } = require('@libsql/client');

// Pengaman: kalau ada error async yang tidak tertangkap di route manapun,
// jangan sampai proses Node mati total (yang bikin 502 Bad Gateway) —
// cukup dicatat di log saja.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server tetap jalan):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server tetap jalan):', err);
});

// ---------- Setup database --------------------------------------------------
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

// ---------- Siapkan tabel (termasuk migrasi ke multi-user) --------------------
async function siapkanDatabase() {
  // Tabel user (diisi otomatis saat pertama kali login lewat Google)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      name        TEXT,
      foto        TEXT,
      dibuat_pada TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Tabel transaksi (kalau database baru sama sekali, langsung punya kolom user_id)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS transaksi (
      id          TEXT PRIMARY KEY,
      tanggal     TEXT NOT NULL,
      akun        TEXT NOT NULL CHECK (akun IN ('kas','bank')),
      jenis       TEXT NOT NULL CHECK (jenis IN ('masuk','keluar')),
      kategori    TEXT,
      keterangan  TEXT,
      jumlah      REAL NOT NULL,
      user_id     TEXT,
      dibuat_pada TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Kalau tabel transaksi ini peninggalan versi LAMA (sebelum ada login),
  // kolom user_id belum ada -> tambahkan sekarang lewat ALTER TABLE.
  const kolom = await db.execute(`PRAGMA table_info(transaksi);`);
  const sudahAdaUserId = kolom.rows.some((r) => r[1] === 'user_id');
  if (!sudahAdaUserId) {
    await db.execute(`ALTER TABLE transaksi ADD COLUMN user_id TEXT;`);
  }

  // Saldo awal sekarang per-user (satu baris per user)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS saldo_awal (
      user_id TEXT PRIMARY KEY,
      kas     REAL NOT NULL DEFAULT 0,
      bank    REAL NOT NULL DEFAULT 0
    );
  `);

  // Tabel settings LAMA (versi single-user) — dipertahankan cuma untuk
  // dibaca sekali saat migrasi (pindahin saldo awal lama ke user pertama).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Tabel session login — disimpan permanen di Turso, BUKAN di RAM,
  // supaya login tidak hilang kalau server restart/sleep/crash.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid        TEXT PRIMARY KEY,
      sess       TEXT NOT NULL,
      kadaluarsa INTEGER NOT NULL
    );
  `);
}

// ---------- Session store custom berbasis Turso --------------------------------
// express-session butuh objek "Store" dengan method get/set/destroy.
// Ini implementasi minimal yang nyimpen semuanya sebagai baris di tabel `sessions`.
class TursoSessionStore extends session.Store {
  async get(sid, callback) {
    try {
      const hasil = await db.execute({
        sql: 'SELECT sess, kadaluarsa FROM sessions WHERE sid = ?',
        args: [sid],
      });
      if (hasil.rows.length === 0) return callback(null, null);
      const row = hasil.rows[0];
      const sess = row[0];
      const kadaluarsa = row[1];
      if (Date.now() > Number(kadaluarsa)) {
        await db.execute({ sql: 'DELETE FROM sessions WHERE sid = ?', args: [sid] });
        return callback(null, null);
      }
      callback(null, JSON.parse(sess));
    } catch (err) {
      callback(err);
    }
  }

  async set(sid, sessionData, callback) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 30 * 24 * 60 * 60 * 1000;
      const kadaluarsa = Date.now() + maxAge;
      await db.execute({
        sql: `INSERT INTO sessions (sid, sess, kadaluarsa) VALUES (?, ?, ?)
              ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, kadaluarsa = excluded.kadaluarsa`,
        args: [sid, JSON.stringify(sessionData), kadaluarsa],
      });
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async destroy(sid, callback) {
    try {
      await db.execute({ sql: 'DELETE FROM sessions WHERE sid = ?', args: [sid] });
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async touch(sid, sessionData, callback) {
    // Perpanjang masa berlaku tanpa mengubah isi session
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 30 * 24 * 60 * 60 * 1000;
      const kadaluarsa = Date.now() + maxAge;
      await db.execute({
        sql: 'UPDATE sessions SET kadaluarsa = ? WHERE sid = ?',
        args: [kadaluarsa, sid],
      });
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

// Dipanggil sekali saat ada user BENAR-BENAR BARU yang pertama kali login.
// Kalau dia adalah user paling pertama di aplikasi ini, semua transaksi lama
// (yang belum punya pemilik / user_id NULL) otomatis jadi milik dia, dan
// saldo awal lama (dari tabel settings) juga dipindahkan ke dia.
async function urusUserBaru(user) {
  const jumlah = await db.execute('SELECT COUNT(*) FROM users');
  const adalahUserPertama = Number(jumlah.rows[0][0]) === 0;

  await db.execute({
    sql: 'INSERT INTO users (id, email, name, foto) VALUES (?, ?, ?, ?)',
    args: [user.id, user.email, user.name, user.foto],
  });

  if (adalahUserPertama) {
    await db.execute({
      sql: 'UPDATE transaksi SET user_id = ? WHERE user_id IS NULL',
      args: [user.id],
    });

    let kas = 0;
    let bank = 0;
    const legacy = await db.execute({
      sql: 'SELECT value FROM settings WHERE key = ?',
      args: ['saldo_awal'],
    });
    if (legacy.rows.length > 0) {
      const parsed = JSON.parse(legacy.rows[0][0]);
      kas = Number(parsed.kas) || 0;
      bank = Number(parsed.bank) || 0;
    }
    await db.execute({
      sql: 'INSERT INTO saldo_awal (user_id, kas, bank) VALUES (?, ?, ?)',
      args: [user.id, kas, bank],
    });
  } else {
    await db.execute({
      sql: 'INSERT INTO saldo_awal (user_id, kas, bank) VALUES (?, 0, 0)',
      args: [user.id],
    });
  }
}

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

// ---------- Setup Google OAuth (Passport) --------------------------------------

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const existing = await db.execute({
          sql: 'SELECT id, email, name, foto FROM users WHERE id = ?',
          args: [profile.id],
        });

        if (existing.rows.length > 0) {
          const r = existing.rows[0];
          return done(null, { id: r[0], email: r[1], name: r[2], foto: r[3] });
        }

        const userBaru = {
          id: profile.id,
          email: (profile.emails && profile.emails[0] && profile.emails[0].value) || '',
          name: profile.displayName || '',
          foto: (profile.photos && profile.photos[0] && profile.photos[0].value) || '',
        };
        await urusUserBaru(userBaru);
        return done(null, userBaru);
      } catch (err) {
        return done(err);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const hasil = await db.execute({
      sql: 'SELECT id, email, name, foto FROM users WHERE id = ?',
      args: [id],
    });
    if (hasil.rows.length === 0) return done(null, false);
    const r = hasil.rows[0];
    done(null, { id: r[0], email: r[1], name: r[2], foto: r[3] });
  } catch (err) {
    done(err);
  }
});

// ---------- Setup server ------------------------------------------------------

const app = express();
app.use(express.json());

app.use(
  session({
    store: new TursoSessionStore(),
    secret: process.env.SESSION_SECRET || 'ganti-rahasia-sesi-ini-di-env-var',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 hari
  })
);
app.use(passport.initialize());
app.use(passport.session());

function requireLogin(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Belum login' });
  return res.redirect('/login.html');
}

// ---------- Route login (PUBLIK, sebelum requireLogin) -------------------------

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get(
  '/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/login.html'));
});

app.get('/api/me', requireLogin, (req, res) => res.json(req.user));

// ---------- Semua route di bawah ini WAJIB login --------------------------------

app.use(requireLogin);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API: saldo awal ---------------------------------------------------

app.get('/api/saldo-awal', async (req, res) => {
  const hasil = await db.execute({
    sql: 'SELECT kas, bank FROM saldo_awal WHERE user_id = ?',
    args: [req.user.id],
  });
  if (hasil.rows.length === 0) return res.json({ kas: 0, bank: 0 });
  res.json({ kas: hasil.rows[0][0], bank: hasil.rows[0][1] });
});

app.post('/api/saldo-awal', async (req, res) => {
  const kas = Number(req.body.kas) || 0;
  const bank = Number(req.body.bank) || 0;
  await db.execute({
    sql: `INSERT INTO saldo_awal (user_id, kas, bank) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET kas = excluded.kas, bank = excluded.bank`,
    args: [req.user.id, kas, bank],
  });
  res.json({ kas, bank });
});

// ---------- API: transaksi -----------------------------------------------------

const KOLOM_TRANSAKSI = 'id, tanggal, akun, jenis, kategori, keterangan, jumlah, dibuat_pada';

app.get('/api/transaksi', async (req, res) => {
  const hasil = await db.execute({
    sql: `SELECT ${KOLOM_TRANSAKSI} FROM transaksi WHERE user_id = ? ORDER BY tanggal ASC, id ASC`,
    args: [req.user.id],
  });
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
    sql: `INSERT INTO transaksi (id, tanggal, akun, jenis, kategori, keterangan, jumlah, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, tanggal, akun, jenis, (kategori || '-').trim(), keterangan.trim(), jumlahNum, req.user.id],
  });

  const hasil = await db.execute({
    sql: `SELECT ${KOLOM_TRANSAKSI} FROM transaksi WHERE id = ? AND user_id = ?`,
    args: [id, req.user.id],
  });
  res.json(keObjekTransaksi(hasil.rows[0]));
});

app.put('/api/transaksi/:id', async (req, res) => {
  const existing = await db.execute({
    sql: 'SELECT id FROM transaksi WHERE id = ? AND user_id = ?',
    args: [req.params.id, req.user.id],
  });
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
          WHERE id=? AND user_id=?`,
    args: [tanggal, akun, jenis, (kategori || '-').trim(), keterangan.trim(), jumlahNum, req.params.id, req.user.id],
  });

  const hasil = await db.execute({
    sql: `SELECT ${KOLOM_TRANSAKSI} FROM transaksi WHERE id = ? AND user_id = ?`,
    args: [req.params.id, req.user.id],
  });
  res.json(keObjekTransaksi(hasil.rows[0]));
});

app.delete('/api/transaksi/:id', async (req, res) => {
  await db.execute({
    sql: 'DELETE FROM transaksi WHERE id = ? AND user_id = ?',
    args: [req.params.id, req.user.id],
  });
  res.json({ ok: true });
});

// ---------- API: cadangan (backup / restore) ------------------------------------

app.get('/api/backup', async (req, res) => {
  const baris = await db.execute({
    sql: 'SELECT kas, bank FROM saldo_awal WHERE user_id = ?',
    args: [req.user.id],
  });
  const saldoAwal = baris.rows.length > 0 ? { kas: baris.rows[0][0], bank: baris.rows[0][1] } : { kas: 0, bank: 0 };

  const hasilTransaksi = await db.execute({
    sql: `SELECT ${KOLOM_TRANSAKSI} FROM transaksi WHERE user_id = ? ORDER BY tanggal ASC, id ASC`,
    args: [req.user.id],
  });
  const transaksi = hasilTransaksi.rows.map(keObjekTransaksi);

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="akasa-verse-cadangan-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.json({ saldoAwal, transaksi, dibuatPada: new Date().toISOString() });
});

app.post('/api/restore', async (req, res) => {
  const { saldoAwal, transaksi } = req.body;
  if (!saldoAwal || !Array.isArray(transaksi)) {
    return res.status(400).json({ error: 'Format file cadangan tidak sesuai' });
  }

  const perintah = [
    {
      sql: `INSERT INTO saldo_awal (user_id, kas, bank) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET kas = excluded.kas, bank = excluded.bank`,
      args: [req.user.id, Number(saldoAwal.kas) || 0, Number(saldoAwal.bank) || 0],
    },
    { sql: 'DELETE FROM transaksi WHERE user_id = ?', args: [req.user.id] },
  ];

  for (const t of transaksi) {
    perintah.push({
      sql: `INSERT INTO transaksi (id, tanggal, akun, jenis, kategori, keterangan, jumlah, user_id, dibuat_pada)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        t.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        t.tanggal,
        t.akun,
        t.jenis,
        t.kategori || '-',
        t.keterangan,
        Number(t.jumlah) || 0,
        req.user.id,
        t.dibuat_pada || new Date().toISOString(),
      ],
    });
  }

  try {
    await db.batch(perintah, 'write');
  } catch (err) {
    console.error('Gagal restore:', err);
    return res.status(500).json({ error: 'Gagal menyimpan data cadangan ke database' });
  }

  res.json({ ok: true });
});

// ---------- Jalankan server ------------------------------------------------------

const PORT = process.env.PORT || 3000;

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
      console.log(
        process.env.GOOGLE_CLIENT_ID
          ? `  - Login   : Google OAuth aktif`
          : `  - Login   : \u26a0\ufe0f  GOOGLE_CLIENT_ID belum diset, login akan gagal`
      );
    });
  })
  .catch((err) => {
    console.error('Gagal menyiapkan database:', err);
    process.exit(1);
  });
