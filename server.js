/**
 * Fasremit WA Gateway Server
 * Express.js server with whatsapp-web.js + Puppeteer
 * Deploy this to Railway — Vercel CRM will call this as a backend.
 *
 * Endpoints:
 *   GET  /status       — WA connection status + QR code
 *   POST /connect      — Start WA client initialization
 *   POST /logout       — Logout & clear session
 *   POST /send         — Send a WhatsApp message
 *   GET  /health       — Health check
 */

const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// Secret token for basic auth (set WA_SECRET in Railway env vars)
const WA_SECRET = process.env.WA_SECRET || '';

// ─── CORS ──────────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*', // Restrict to your Vercel domain in production via env var
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-wa-secret'],
}));
app.use(express.json());

// ─── Auth Middleware ────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!WA_SECRET) return next(); // No secret set → open (dev mode)
  const provided = req.headers['x-wa-secret'] || req.query.secret;
  if (provided !== WA_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ─── WA Client State ────────────────────────────────────────────────────────
let waState = {
  status: 'DISCONNECTED', // DISCONNECTED | INITIALIZING | QR_PENDING | CONNECTED | AUTH_FAILURE
  qrCode: null,
  phoneNumber: null,
  deviceName: null,
  connectedAt: null,
  lastSeen: null,
};

let waClient = null;
let initPromise = null;
const SESSION_DIR = path.join(__dirname, 'wa-session');

function updateState(partial) {
  waState = { ...waState, ...partial };
}

// ─── WA Init ────────────────────────────────────────────────────────────────
async function initWAClient() {
  if (waState.status === 'CONNECTED' && waClient) return;
  if (initPromise) return initPromise;

  initPromise = _doInit().finally(() => { initPromise = null; });
  return initPromise;
}

async function _doInit() {
  try {
    updateState({ status: 'INITIALIZING', qrCode: null });
    console.log('[WA] Initializing client...');

    // Ensure Chrome is installed in the cache at runtime (fixes Hugging Face mount/discard cache issues)
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(__dirname, '.puppeteer-cache');
    
    // Recursive search for "chrome" binary to verify it actually exists and is complete
    function findChromeExecutable(dir) {
      if (!fs.existsSync(dir)) return null;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            const found = findChromeExecutable(fullPath);
            if (found) return found;
          } else if (file === 'chrome' || file === 'chrome.exe') {
            return fullPath;
          }
        } catch (e) {
          // Ignore permission/read errors for specific files
        }
      }
      return null;
    }

    const chromePath = findChromeExecutable(cacheDir);
    if (!chromePath) {
      console.log('[WA] Chrome executable not found in cache. Clean installing Chrome at runtime...');
      const { execSync } = require('child_process');
      if (fs.existsSync(cacheDir)) {
        try {
          fs.rmSync(cacheDir, { recursive: true, force: true });
        } catch (e) {}
      }
      fs.mkdirSync(cacheDir, { recursive: true });

      // Get exact version expected by local puppeteer-core to avoid mismatches
      let expectedVersion = 'chrome';
      try {
        const revisions = require('puppeteer-core/lib/cjs/puppeteer/revisions.js');
        const rev = revisions.PUPPETEER_REVISIONS.chrome;
        if (rev) expectedVersion = `chrome@${rev}`;
      } catch (e) {
        console.warn('[WA] Could not read expected Chrome revision, installing latest...');
      }

      console.log(`[WA] Running: npx puppeteer browsers install ${expectedVersion}`);
      execSync(`npx puppeteer browsers install ${expectedVersion}`, {
        env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir },
        stdio: 'inherit'
      });
      console.log('[WA] Chrome installation completed successfully!');
    } else {
      console.log('[WA] Found Chrome executable in cache at:', chromePath);
    }

    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    waClient = new Client({
      authStrategy: new LocalAuth({
        dataPath: SESSION_DIR,
        clientId: 'fasremit-crm',
      }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
          '--disable-extensions',
        ],
      },
    });

    waClient.on('qr', async (qr) => {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        updateState({ status: 'QR_PENDING', qrCode: qrDataUrl });
        console.log('[WA] QR Code generated — awaiting scan');
      } catch (e) {
        updateState({ status: 'QR_PENDING', qrCode: null });
      }
    });

    waClient.on('authenticated', () => {
      console.log('[WA] Authenticated');
      updateState({ status: 'INITIALIZING', qrCode: null });
    });

    waClient.on('ready', () => {
      try {
        const info = waClient.info;
        updateState({
          status: 'CONNECTED',
          phoneNumber: info?.wid?.user || null,
          deviceName: info?.pushname || 'Fasremit CRM',
          connectedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        });
        console.log('[WA] Ready. Connected as:', info?.wid?.user);
      } catch (e) {
        updateState({ status: 'CONNECTED', connectedAt: new Date().toISOString() });
      }
    });

    waClient.on('auth_failure', (msg) => {
      console.error('[WA] Auth failure:', msg);
      updateState({ status: 'AUTH_FAILURE', qrCode: null });
      waClient = null;
    });

    waClient.on('disconnected', (reason) => {
      console.warn('[WA] Disconnected:', reason);
      updateState({ status: 'DISCONNECTED', qrCode: null, phoneNumber: null, connectedAt: null });
      waClient = null;
    });

    waClient.on('message_ack', () => {
      updateState({ lastSeen: new Date().toISOString() });
    });

    await waClient.initialize();
  } catch (err) {
    console.error('[WA] Init failed:', err.message);
    updateState({ status: 'DISCONNECTED' });
    waClient = null;
    throw err;
  }
}

async function logoutWAClient() {
  if (waClient) {
    try { await waClient.logout(); } catch (e) {}
    waClient = null;
  }
  updateState({ status: 'DISCONNECTED', qrCode: null, phoneNumber: null, deviceName: null, connectedAt: null });
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }
  } catch (e) {}
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), waStatus: waState.status });
});

// GET /status — returns current WA state
app.get('/status', authMiddleware, (req, res) => {
  res.json({ success: true, ...waState });
});

// POST /connect — trigger WA init
app.post('/connect', authMiddleware, (req, res) => {
  initWAClient().catch(err => console.error('[WA] Connect error:', err));
  res.json({ success: true, message: 'Menginisialisasi koneksi WA...' });
});

// POST /logout — disconnect WA
app.post('/logout', authMiddleware, async (req, res) => {
  await logoutWAClient();
  res.json({ success: true, message: 'Berhasil logout dari WhatsApp.' });
});

// POST /send — send a WhatsApp message
app.post('/send', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone dan message wajib diisi' });
  }

  if (waState.status !== 'CONNECTED' || !waClient) {
    return res.status(503).json({ success: false, error: 'WA client tidak terhubung. Silakan scan QR Code terlebih dahulu.' });
  }

  try {
    let cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
    if (!cleanPhone.startsWith('62')) cleanPhone = '62' + cleanPhone;
    const chatId = `${cleanPhone}@c.us`;

    const msg = await waClient.sendMessage(chatId, message);
    updateState({ lastSeen: new Date().toISOString() });

    res.json({
      success: true,
      messageId: msg.id?.id || msg.id?._serialized || `msg_${Date.now()}`,
    });
  } catch (err) {
    console.error('[WA] Send error:', err.message);
    res.status(500).json({ success: false, error: err.message || 'Gagal mengirim pesan' });
  }
});

// ─── Auto-connect on startup if session exists ───────────────────────────────
if (fs.existsSync(path.join(SESSION_DIR, 'session-fasremit-crm'))) {
  console.log('[WA] Found existing session, auto-connecting...');
  initWAClient().catch(err => console.warn('[WA] Auto-connect failed:', err.message));
}

// ─── Start Server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Fasremit WA Gateway running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Status: http://localhost:${PORT}/status`);
});
