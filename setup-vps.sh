#!/usr/bin/env bash
set -e

echo "=== Memasang GudangPro Server di VPS ==="

if ! command -v node >/dev/null 2>&1; then
  echo "-> Menginstal Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs build-essential python3
fi

echo "-> Menginstal dependensi utama (express, sqlite3, multer)..."
npm install --omit=dev

if ! command -v pm2 >/dev/null 2>&1; then
  echo "-> Menginstal PM2 (Penjaga Server 24 Jam)..."
  sudo npm install -g pm2
fi

echo "-> Menjalankan GudangPro Server di port 3000..."
pm2 delete gudangpro >/dev/null 2>&1 || true
pm2 start server.js --name gudangpro
pm2 save

echo "=== Selesai! Server GudangPro aktif 24 jam di port 3000 ==="

