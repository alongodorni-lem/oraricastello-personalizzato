/**
 * Cartella dati persistenti (black list, registri invio, coda, cache).
 * Su Render imposta NEWSLETTER_DATA_DIR=/var/data e monta un disco su quel path.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'data');

function getDataDir() {
  const fromEnv = String(process.env.NEWSLETTER_DATA_DIR || '').trim();
  const dir = fromEnv || DEFAULT_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (dir !== DEFAULT_DIR && fs.existsSync(DEFAULT_DIR)) {
    for (const name of fs.readdirSync(DEFAULT_DIR)) {
      const src = path.join(DEFAULT_DIR, name);
      const dest = path.join(dir, name);
      try {
        if (fs.statSync(src).isFile() && !fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
        }
      } catch (_) {}
    }
  }
  return dir;
}

function dataFile(name) {
  return path.join(getDataDir(), name);
}

module.exports = { getDataDir, dataFile, DEFAULT_DIR };
