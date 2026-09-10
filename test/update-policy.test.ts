import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildWindowsPortableUpdateScript,
  compareVersions,
  parseLatestRelease,
} = require('../../electron/update-policy.cjs');

test('compares normalized semantic release versions', () => {
  assert.equal(compareVersions('0.1.24', '0.1.23'), 1);
  assert.equal(compareVersions('v0.1.23', '0.1.23'), 0);
  assert.equal(compareVersions('0.1.22', '0.1.23'), -1);
  assert.throws(() => compareVersions('main', '0.1.23'), /version/i);
});

test('accepts only the exact official portable release asset with a SHA-256 digest', () => {
  const release = parseLatestRelease({
    tag_name: 'v0.1.24',
    html_url: 'https://github.com/aephiaviktor/fleet-rental-bot-2/releases/tag/v0.1.24',
    draft: false,
    prerelease: false,
    assets: [{
      name: 'Fleet-Rental-Bot-2-0.1.24-portable.exe',
      size: 90_000_000,
      digest: `sha256:${'a'.repeat(64)}`,
      browser_download_url: 'https://github.com/aephiaviktor/fleet-rental-bot-2/releases/download/v0.1.24/Fleet-Rental-Bot-2-0.1.24-portable.exe',
    }],
  });
  assert.equal(release.version, '0.1.24');
  assert.equal(release.asset.sha256, 'a'.repeat(64));
  assert.equal(release.asset.size, 90_000_000);

  assert.throws(() => parseLatestRelease({
    tag_name: 'v0.1.24', draft: false, prerelease: false,
    assets: [{
      name: 'Fleet-Rental-Bot-2-0.1.24-portable.exe', size: 1, digest: null,
      browser_download_url: 'https://evil.example/update.exe',
    }],
  }), /official|digest/i);
});

test('builds a transactional Windows replacement with readiness rollback', () => {
  const script = buildWindowsPortableUpdateScript({
    parentPid: 42,
    targetPath: "C:\\Apps\\Fleet Rental Bot 2\\Fleet Rental Bot 2's.exe",
    stagedPath: 'C:\\Temp\\next.exe',
    backupPath: 'C:\\Apps\\backup.exe',
    readyPath: 'C:\\Temp\\ready.json',
    token: 'token-123',
    instance: 'UST',
  });
  assert.match(script, /Wait-ForExit 42 180/);
  assert.match(script, /Move-Item -LiteralPath/);
  assert.match(script, /--instance/);
  assert.match(script, /--update-ready-file/);
  assert.match(script, /token-123/);
  assert.match(script, /Restore-PreviousVersion/);
  assert.match(script, /Fleet Rental Bot 2''s\.exe/);
});
