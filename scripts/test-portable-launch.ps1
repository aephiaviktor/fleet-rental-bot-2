param([Parameter(Mandatory)][string]$Version)

$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath "release/Fleet-Rental-Bot-2-$Version-portable.exe").Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('fleet-rental-bot-2-update-test-' + [guid]::NewGuid().ToString('N'))
$launches = @()

try {
  # Both instances use the same TEMP and build, like separate faction installations on one PC.
  foreach ($instance in @('MUD', 'ONI')) {
    $directory = Join-Path $root $instance
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $copy = Join-Path $directory (Split-Path -Leaf $exe)
    Copy-Item -LiteralPath $exe -Destination $copy
    $markerDir = Join-Path $directory 'fleet-rental-bot-2-update-test'
    New-Item -ItemType Directory -Path $markerDir | Out-Null
    $marker = Join-Path $markerDir 'ready.json'
    $token = [guid]::NewGuid().ToString()
    $process = Start-Process -FilePath $copy -ArgumentList @('--instance', $instance, '--update-ready-file', ('"' + $marker + '"'), '--update-token', $token) -PassThru
    $launches += @{ Instance = $instance; Process = $process; Marker = $marker; Token = $token }
  }

  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  foreach ($launch in $launches) {
    $ready = $null
    while (!$ready) {
      if ($launch.Process.HasExited) { throw "$($launch.Instance) exited before its window loaded." }
      if ([DateTime]::UtcNow -ge $deadline) { throw "$($launch.Instance) did not confirm readiness." }
      if (Test-Path -LiteralPath $launch.Marker) {
        try { $ready = Get-Content -LiteralPath $launch.Marker -Raw | ConvertFrom-Json } catch {}
        if ($ready) { break }
      }
      Start-Sleep -Milliseconds 500
    }
    if ($ready.token -ne $launch.Token -or $ready.version -ne $Version -or $ready.instance -ne $launch.Instance) {
      throw "Unexpected readiness marker for $($launch.Instance)."
    }
  }

  $directories = foreach ($launch in $launches) {
    if ($launch.Process.HasExited) { throw "$($launch.Instance) exited while the other instance was starting." }
    $filter = "ParentProcessId = $($launch.Process.Id) AND Name = 'Fleet Rental Bot 2.exe'"
    $app = Get-CimInstance Win32_Process -Filter $filter
    if (!$app.ExecutablePath -or @($app).Count -ne 1) { throw "Could not locate the running $($launch.Instance) executable." }
    Split-Path -Parent $app.ExecutablePath
  }
  if (@($directories | Sort-Object -Unique).Count -ne $launches.Count) { throw 'Portable instances share an extraction directory.' }
  Write-Host "Verified simultaneous MUD and ONI startup with separate extraction directories for v$Version."
} finally {
  foreach ($launch in $launches) {
    if (!$launch.Process.HasExited) {
      taskkill.exe /PID $launch.Process.Id /T /F | Out-Host
      $launch.Process.WaitForExit(10000) | Out-Null
    }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
