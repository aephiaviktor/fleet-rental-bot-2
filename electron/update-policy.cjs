const OFFICIAL_REPOSITORY = 'aephiaviktor/fleet-rental-bot-2';
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MAX_PORTABLE_ASSET_BYTES = 250 * 1024 * 1024;

function normalizeVersion(value) {
  const version = String(value || '').trim().replace(/^v/i, '');
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid release version: ${value || 'empty'}`);
  return version;
}

function compareVersions(leftValue, rightValue) {
  const left = normalizeVersion(leftValue).split('.').map(Number);
  const right = normalizeVersion(rightValue).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function parseLatestRelease(release) {
  if (!release || release.draft || release.prerelease) throw new Error('The latest official release is unavailable.');
  const version = normalizeVersion(release.tag_name);
  const assetName = `Fleet-Rental-Bot-2-${version}-portable.exe`;
  const asset = Array.isArray(release.assets) ? release.assets.find((candidate) => candidate?.name === assetName) : null;
  const digestMatch = /^sha256:([a-f0-9]{64})$/i.exec(String(asset?.digest || ''));
  const expectedPath = `/${OFFICIAL_REPOSITORY}/releases/download/v${version}/${assetName}`;
  let downloadUrl;
  try { downloadUrl = new URL(String(asset?.browser_download_url || '')); } catch { downloadUrl = null; }
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PORTABLE_ASSET_BYTES || !digestMatch
      || downloadUrl?.protocol !== 'https:' || downloadUrl.hostname !== 'github.com' || downloadUrl.pathname !== expectedPath) {
    throw new Error(`The official ${assetName} asset or its SHA-256 digest is unavailable.`);
  }
  return {
    version,
    releaseUrl: String(release.html_url || `https://github.com/${OFFICIAL_REPOSITORY}/releases/tag/v${version}`),
    asset: {
      name: assetName,
      size: asset.size,
      sha256: digestMatch[1].toLowerCase(),
      downloadUrl: downloadUrl.href,
    },
  };
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildWindowsPortableUpdateScript({ appPid, portablePid, targetPath, stagedPath, backupPath, readyPath, logPath, token, instance }) {
  if (!Number.isSafeInteger(appPid) || appPid <= 0) throw new Error('A valid updater application PID is required.');
  if (!Number.isSafeInteger(portablePid) || portablePid <= 0) throw new Error('A valid portable wrapper PID is required.');
  return `$ErrorActionPreference = 'Stop'
$TargetPath = ${psQuote(targetPath)}
$StagedPath = ${psQuote(stagedPath)}
$BackupPath = ${psQuote(backupPath)}
$ReadyPath = ${psQuote(readyPath)}
$LogPath = ${psQuote(logPath)}
$Token = ${psQuote(token)}
$Instance = ${psQuote(instance)}

function Write-UpdateLog([string]$Message) {
  try {
    $Timestamp = [DateTimeOffset]::Now.ToString('o')
    Add-Content -LiteralPath $LogPath -Value ("$Timestamp $Message") -Encoding UTF8 -ErrorAction Stop
  } catch {}
}

function Start-FleetRentalBot([bool]$ReadinessCheck) {
  $Arguments = @('--instance', $Instance)
  if ($ReadinessCheck) {
    $Arguments += @('--update-ready-file', ('"' + $ReadyPath + '"'), '--update-token', $Token)
  }
  return Start-Process -FilePath $TargetPath -ArgumentList $Arguments -PassThru
}

function Wait-ForExit([int]$ProcessId, [int]$TimeoutSeconds) {
  for ($Attempt = 0; $Attempt -lt $TimeoutSeconds; $Attempt++) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Move-WithRetry([string]$Source, [string]$Destination, [int]$TimeoutSeconds) {
  for ($Attempt = 0; $Attempt -lt $TimeoutSeconds; $Attempt++) {
    try {
      Move-Item -LiteralPath $Source -Destination $Destination -Force
      return
    } catch {
      if ($Attempt -eq ($TimeoutSeconds - 1)) { throw }
      Start-Sleep -Seconds 1
    }
  }
}

function Restore-PreviousVersion {
  if (Test-Path -LiteralPath $BackupPath) {
    if (Test-Path -LiteralPath $TargetPath) { Remove-Item -LiteralPath $TargetPath -Force }
    Move-WithRetry $BackupPath $TargetPath 30
  }
  if (Test-Path -LiteralPath $TargetPath) { Start-FleetRentalBot $false | Out-Null }
}

# No installation or rollback is allowed until the parent authorizes shutdown.
$HelperStarted = Join-Path (Split-Path $ReadyPath) 'helper-started.json'
$HelperProceed = Join-Path (Split-Path $ReadyPath) 'helper-proceed.json'
@{token=$Token} | ConvertTo-Json -Compress | Set-Content -LiteralPath $HelperStarted -Encoding UTF8
Write-UpdateLog 'helper-started'
$Authorized = $false
for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
  if (Test-Path -LiteralPath $HelperProceed) {
    try {
      $Permission = Get-Content -LiteralPath $HelperProceed -Raw | ConvertFrom-Json
      if ($Permission.token -eq $Token) { $Authorized = $true; break }
    } catch {}
  }
  Start-Sleep -Milliseconds 500
}
if (-not $Authorized) { Write-UpdateLog 'helper-not-authorized'; exit 1 }

try {
  Write-UpdateLog 'waiting-for-app-exit'
  if (-not (Wait-ForExit ${appPid} 180)) { throw 'The running application did not exit for the update.' }
  Write-UpdateLog 'waiting-for-portable-wrapper-exit'
  if (-not (Wait-ForExit ${portablePid} 180)) { throw 'The portable wrapper did not exit for the update.' }
  if (Test-Path -LiteralPath $ReadyPath) { Remove-Item -LiteralPath $ReadyPath -Force }
  if (Test-Path -LiteralPath $BackupPath) { Remove-Item -LiteralPath $BackupPath -Force }
  Write-UpdateLog 'installing-replacement'
  Move-WithRetry $TargetPath $BackupPath 60
  Move-WithRetry $StagedPath $TargetPath 30
  Write-UpdateLog 'replacement-installed'
  $UpdatedProcess = Start-FleetRentalBot $true
  Write-UpdateLog ("updated-process-started pid=" + $UpdatedProcess.Id)
  $Ready = $false
  for ($Attempt = 0; $Attempt -lt 90; $Attempt++) {
    Start-Sleep -Seconds 1
    if ($UpdatedProcess.HasExited) { break }
    if (Test-Path -LiteralPath $ReadyPath) {
      try {
        $Marker = Get-Content -LiteralPath $ReadyPath -Raw | ConvertFrom-Json
        if ($Marker.token -eq $Token) { $Ready = $true; break }
      } catch {}
    }
  }
  if (-not $Ready) { throw 'The updated application did not confirm readiness.' }
  Write-UpdateLog 'readiness-confirmed'
  Remove-Item -LiteralPath $BackupPath -Force
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
  Write-UpdateLog 'update-complete'
} catch {
  Write-UpdateLog ("update-failed " + $_.Exception.ToString())
  Write-UpdateLog 'rollback-started'
  if ($UpdatedProcess -and -not $UpdatedProcess.HasExited) {
    Stop-Process -Id $UpdatedProcess.Id -Force -ErrorAction SilentlyContinue
    Wait-ForExit $UpdatedProcess.Id 30 | Out-Null
  }
  Restore-PreviousVersion
  Write-UpdateLog 'rollback-finished'
  throw
}
`;
}

module.exports = {
  OFFICIAL_REPOSITORY,
  buildWindowsPortableUpdateScript,
  compareVersions,
  normalizeVersion,
  parseLatestRelease,
};
