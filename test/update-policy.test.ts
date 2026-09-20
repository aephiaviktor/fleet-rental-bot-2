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
  // WScript uses ignored stdio; the PowerShell helper owns the durable phase log.
  assert.match(main, /stdio: 'ignore'/);
  assert.doesNotMatch(main, /helperLog\.fd/);
});

test('helper acknowledges execution and requires parent authorization before touching installation', () => {
 const script=buildWindowsPortableUpdateScript({appPid:42,portablePid:41,targetPath:'target',stagedPath:'stage',backupPath:'backup',readyPath:'ready',logPath:'log',token:'test',instance:'MUD'});
 assert.match(script,/helper-started/);
 assert.match(script,/helper-started\.json/);
 assert.match(script,/helper-proceed\.json/);
 assert.ok(script.indexOf('if (-not $Authorized)') < script.indexOf("Write-UpdateLog 'waiting-for-app-exit'"));
});

test('Windows updater uses independent WScript launcher and waits for helper acknowledgement', async () => {
 const main=await readFile(new URL('../../electron/main.cjs',import.meta.url),'utf8');
 assert.match(main,/spawn\('wscript.exe'/);
 assert.doesNotMatch(main,/spawn\('powershell.exe'/);
 assert.match(main,/await waitForHelper/);
 assert.ok(main.indexOf('await waitForHelper') < main.indexOf('setTimeout(() => app.quit()'));
});

test('handshake authorizes only a matching helper and rejects timeout or early exit', async () => {
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os'); const path=await import('node:path');
 const {EventEmitter}=await import('node:events');
 const {waitForHelper}=require('../../electron/update-handshake.cjs');
 for(const scenario of ['success','wrong-token','exit']){
  const dir=await mkdtemp(path.join(tmpdir(),'helper-test-'));
  const helper=Object.assign(new EventEmitter(),{exitCode:scenario==='exit'?0:null,signalCode:null,killed:false,kill(){this.killed=true;}});
  try {
   await writeFile(path.join(dir,'helper-started.json'),'\uFEFF'+JSON.stringify({token:scenario==='wrong-token'?'wrong':'test'}));
   const run=waitForHelper(helper,dir,'test',path.join(dir,'log'),150);
   if(scenario==='success') {await run;assert.equal(JSON.parse(await readFile(path.join(dir,'helper-proceed.json'),'utf8')).token,'test');assert.equal(helper.killed,false);}
   else {await assert.rejects(run,/acknowledge|exited/);assert.equal(helper.killed,true);await assert.rejects(readFile(path.join(dir,'helper-proceed.json')));}
  }finally{await rm(dir,{recursive:true,force:true});}
 }
});
