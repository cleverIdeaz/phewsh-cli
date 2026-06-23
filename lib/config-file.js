const fs = require('fs');
const path = require('path');

function hardenConfigPath(configPath) {
  const dir = path.dirname(configPath);
  if (fs.existsSync(dir)) {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  }
  if (fs.existsSync(configPath)) {
    try { fs.chmodSync(configPath, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  }
}

function loadConfig(configPath, fallback = null) {
  if (!fs.existsSync(configPath)) return fallback;
  hardenConfigPath(configPath);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function saveConfig(configPath, config) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(configPath, 0o600); } catch { /* existing files keep their prior mode */ }
}

module.exports = {
  hardenConfigPath,
  loadConfig,
  saveConfig,
};
