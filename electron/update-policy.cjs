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

function buildWindowsPortableUpdateScript({ parentPid, targetPath, stagedPath, backupPath, readyPath, token, instance }) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('A valid updater parent PID is required.');
  return `$ErrorActionPreference = 'Stop'
$TargetPath = ${psQuote(targetPath)}
$StagedPath = ${psQuote(stagedPath)}
$BackupPath = ${psQuote(backupPath)}
$ReadyPath = ${psQuote(readyPath)}
$Token = ${psQuote(token)}
$Instance = ${psQuote(instance)}

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

try {
  if (-not (Wait-ForExit ${parentPid} 180)) { throw 'The running application did not exit for the update.' }
  if (Test-Path -LiteralPath $ReadyPath) { Remove-Item -LiteralPath $ReadyPath -Force }
  if (Test-Path -LiteralPath $BackupPath) { Remove-Item -LiteralPath $BackupPath -Force }
  Move-WithRetry $TargetPath $BackupPath 60
  Move-WithRetry $StagedPath $TargetPath 30
  $UpdatedProcess = Start-FleetRentalBot $true
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
  Remove-Item -LiteralPath $BackupPath -Force
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
} catch {
  if ($UpdatedProcess -and -not $UpdatedProcess.HasExited) {
    Stop-Process -Id $UpdatedProcess.Id -Force -ErrorAction SilentlyContinue
    Wait-ForExit $UpdatedProcess.Id 30 | Out-Null
  }
  Restore-PreviousVersion
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
