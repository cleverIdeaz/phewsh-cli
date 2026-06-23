const { execFileSync } = require('child_process');

const WEB_URL = 'https://phewsh.com/mbhd';

console.log(`\n  🎵 Opening MBHD Music Engine...\n`);

try {
  // execFileSync (no shell) — argument-safe even though the URL is constant.
  if (process.platform === 'darwin') {
    execFileSync('open', [WEB_URL]);
  } else if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'start', '', WEB_URL]);
  } else {
    execFileSync('xdg-open', [WEB_URL]);
  }
} catch {
  console.log(`  Could not open browser. Visit: ${WEB_URL}\n`);
}
