---
title: Fasremit WA Gateway
emoji: 💬
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
---

# Fasremit WA Gateway

Server Express.js yang menjalankan `whatsapp-web.js` + Puppeteer sebagai WA Gateway backend.
Di-deploy ke **Railway** agar bisa diakses dari Vercel CRM.

## Environment Variables (Railway)

| Variable | Keterangan | Contoh |
|---|---|---|
| `PORT` | Port server (Railway set otomatis) | `3001` |
| `WA_SECRET` | Token rahasia untuk autentikasi request dari Vercel | `fasremit-secret-2024` |

## Deploy ke Railway

1. Login ke [railway.app](https://railway.app)
2. New Project → Deploy from GitHub Repo
3. Upload / connect folder ini
4. Set environment variable `WA_SECRET` di Railway dashboard
5. Catat URL Railway yang diberikan (contoh: `https://fasremit-wa-gateway.up.railway.app`)
6. Set di Vercel CRM: `WA_GATEWAY_URL=https://fasremit-wa-gateway.up.railway.app` dan `WA_SECRET=nilai_yang_sama`

## Endpoints

| Method | Path | Keterangan |
|---|---|---|
| `GET` | `/health` | Health check (tanpa auth) |
| `GET` | `/status` | Status WA + QR Code |
| `POST` | `/connect` | Mulai inisialisasi WA |
| `POST` | `/logout` | Logout WA |
| `POST` | `/send` | Kirim pesan WA |

Semua endpoint (kecuali `/health`) memerlukan header `x-wa-secret: <WA_SECRET>`.
