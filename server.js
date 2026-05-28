/**
 * Fasremit WA Gateway Server (Baileys Edition)
 * Express.js server utilizing @whiskeysockets/baileys.
 * Runs directly on pure Node.js without requiring Puppeteer/Chromium.
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
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const appInstance = express();
const PORT = process.env.PORT || 3001;

// Secret token for basic auth (set WA_SECRET in env vars)
const WA_SECRET = process.env.WA_SECRET || '';

// ─── CORS ──────────────────────────────────────────────────────────────────
appInstance.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-wa-secret'],
}));
appInstance.use(express.json());

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

let sock = null;
let isInitializing = false;
const SESSION_DIR = path.join(__dirname, 'baileys-session');

function updateState(partial) {
  waState = { ...waState, ...partial };
}

// ─── WA Init (Baileys) ──────────────────────────────────────────────────────
async function initWAClient() {
  if (waState.status === 'CONNECTED' && sock) return;
  if (isInitializing) return;

  isInitializing = true;
  updateState({ status: 'INITIALIZING', qrCode: null });
  console.log('[WA] Initializing Baileys socket...');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr);
          updateState({ status: 'QR_PENDING', qrCode: qrDataUrl });
          console.log('[WA] QR Code generated — awaiting scan');
        } catch (e) {
          updateState({ status: 'QR_PENDING', qrCode: null });
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[WA] Connection closed. Status code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
        
        updateState({ status: 'DISCONNECTED', qrCode: null, phoneNumber: null, connectedAt: null });
        sock = null;
        isInitializing = false;

        if (shouldReconnect) {
          // Re-initialize socket
          setTimeout(() => {
            initWAClient().catch(err => console.error('[WA] Reconnect error:', err));
          }, 3000);
        } else {
          // Logged out: clean up session
          console.log('[WA] User logged out. Clearing session directory...');
          try {
            if (fs.existsSync(SESSION_DIR)) {
              fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            }
          } catch (e) {}
        }
      } else if (connection === 'open') {
        const user = sock.user;
        updateState({
          status: 'CONNECTED',
          phoneNumber: user?.id?.split(':')[0] || null,
          deviceName: user?.name || 'Fasremit CRM (Baileys)',
          connectedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        });
        console.log('[WA] Connected successfully as:', user?.id);
        isInitializing = false;
      }
    });

  } catch (err) {
    console.error('[WA] Init failed:', err.message);
    updateState({ status: 'DISCONNECTED' });
    sock = null;
    isInitializing = false;
    throw err;
  }
}

async function logoutWAClient() {
  if (sock) {
    try { sock.logout(); } catch (e) {}
    sock = null;
  }
  updateState({ status: 'DISCONNECTED', qrCode: null, phoneNumber: null, deviceName: null, connectedAt: null });
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }
  } catch (e) {}
  isInitializing = false;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check
appInstance.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), waStatus: waState.status });
});

// GET /status — returns current WA state
appInstance.get('/status', authMiddleware, (req, res) => {
  res.json({ success: true, ...waState });
});

// POST /connect — trigger WA init
appInstance.post('/connect', authMiddleware, (req, res) => {
  initWAClient().catch(err => console.error('[WA] Connect error:', err));
  res.json({ success: true, message: 'Menginisialisasi koneksi WA...' });
});

// POST /logout — disconnect WA
appInstance.post('/logout', authMiddleware, async (req, res) => {
  await logoutWAClient();
  res.json({ success: true, message: 'Berhasil logout dari WhatsApp.' });
});

// POST /send — send a WhatsApp message
appInstance.post('/send', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone dan message wajib diisi' });
  }

  if (waState.status !== 'CONNECTED' || !sock) {
    return res.status(503).json({ success: false, error: 'WA client tidak terhubung. Silakan scan QR Code terlebih dahulu.' });
  }

  try {
    let cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
    if (!cleanPhone.startsWith('62')) cleanPhone = '62' + cleanPhone;
    
    // Baileys requires phone format like '62xxx@s.whatsapp.net'
    const jid = `${cleanPhone}@s.whatsapp.net`;

    const sent = await sock.sendMessage(jid, { text: message });
    updateState({ lastSeen: new Date().toISOString() });

    res.json({
      success: true,
      messageId: sent.key.id || `msg_${Date.now()}`,
    });
  } catch (err) {
    console.error('[WA] Send error:', err.message);
    res.status(500).json({ success: false, error: err.message || 'Gagal mengirim pesan' });
  }
});

// ─── Auto-connect on startup if session folder exists ──────────────────────────
if (fs.existsSync(SESSION_DIR)) {
  console.log('[WA] Found existing session folder, auto-connecting...');
  initWAClient().catch(err => console.warn('[WA] Auto-connect failed:', err.message));
}

// ─── Start Server ───────────────────────────────────────────────────────────
appInstance.listen(PORT, () => {
  console.log(`✅ Fasremit WA Gateway (Baileys) running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Status: http://localhost:${PORT}/status`);
});
