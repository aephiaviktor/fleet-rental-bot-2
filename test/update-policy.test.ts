import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('builds a transactional Windows replacement that waits for the app and portable wrapper', () => {
  const script = buildWindowsPortableUpdateScript({
    appPid: 42,
    portablePid: 41,
    targetPath: "C:\\Apps\\Fleet Rental Bot 2\\Fleet Rental Bot 2's.exe",
    stagedPath: 'C:\\Temp\\next.exe',
    backupPath: 'C:\\Apps\\backup.exe',
    readyPath: 'C:\\Temp\\ready.json',
    logPath: 'C:\\Temp\\update.log',
    token: 'token-123',
    instance: 'UST',
  });
  assert.match(script, /Wait-ForExit 42 180/);
  assert.match(script, /Wait-ForExit 41 180/);
  assert.ok(script.indexOf('Wait-ForExit 42 180') < script.indexOf('Wait-ForExit 41 180'));
  assert.ok(script.indexOf('Wait-ForExit 41 180') < script.indexOf('Move-WithRetry \$TargetPath'));
  assert.match(script, /Move-Item -LiteralPath/);
  assert.match(script, /--instance/);
  assert.match(script, /--update-ready-file/);
  assert.match(script, /token-123/);
  assert.match(script, /Restore-PreviousVersion/);
  assert.match(script, /Fleet Rental Bot 2''s\.exe/);
});

test('persists updater phase and exception evidence to a durable helper log', async () => {
  const script = buildWindowsPortableUpdateScript({
    appPid: 42,
    portablePid: 41,
    targetPath: 'C:\\Apps\\current.exe',
    stagedPath: 'C:\\Temp\\next.exe',
    backupPath: 'C:\\Apps\\backup.exe',
    readyPath: 'C:\\Temp\\ready.json',
    logPath: 'C:\\Temp\\update.log',
    token: 'token-123',
    instance: 'UST',
  });
  assert.match(script, /\$LogPath = 'C:\\Temp\\update\.log'/);
  assert.match(script, /Write-UpdateLog/);
  assert.match(script, /waiting-for-app-exit/);
  assert.match(script, /waiting-for-portable-wrapper-exit/);
  assert.match(script, /replacement-installed/);
  assert.match(script, /readiness-confirmed/);
  assert.match(script, /rollback-started/);
  assert.match(script, /\$_\.Exception\.ToString\(\)/);

  const main = await readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /path\.join\(targetDirectory, 'fleet-rental-bot-2-update\.log'\)/);
  assert.match(main, /portablePid: process\.ppid/);
  // The helper must be spawned detached with plain 'ignore' stdio. Redirecting
  // the child's stdout/stderr to the app's log file handle killed the spawned
  // PowerShell on the live host (helper never executed), so no fd may be wired
  // into the child. The durable phase log is written by the helper itself via
  // Add-Content to the same log path.
  assert.match(main, /stdio: 'ignore'/);
  assert.doesNotMatch(main, /helperLog\.fd/);
});
