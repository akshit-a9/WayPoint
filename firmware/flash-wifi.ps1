# Build the firmware and flash it over WiFi: no USB cable, so the board can stay
# on the breadboard supply with its sensors powered.
#
# The build goes to firmware/build/, the API server hands it out at
# /api/device/firmware, and an "update" command tells the device to fetch it
# and reboot. Needs the API server running and the device online (dev build).
# The first time, flash over USB once so the device knows the "update" command.
#
#   .\firmware\flash-wifi.ps1               # the device that reported most recently
#   .\firmware\flash-wifi.ps1 -Device A4:F0:0F:5C:0C:AC
param(
  [string]$Device,
  [string]$Api = "http://localhost:8000"
)
$ErrorActionPreference = "Stop"
$cli = "$env:LOCALAPPDATA\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"
$sketch = Join-Path $PSScriptRoot "waypoint"
$build = Join-Path $PSScriptRoot "build"

$devices = (Invoke-RestMethod "$Api/api/telemetry").devices | Where-Object { $null -ne $_.age -and $_.age -lt 15 }
$dev = if ($Device) { $devices | Where-Object id -eq $Device } else { $devices | Sort-Object age | Select-Object -First 1 }
if (-not $dev) { throw "No device online$(if ($Device) { " with id $Device" }). Is it powered and on the hotspot?" }
Write-Host "Device $($dev.id), running $($dev.fw) ($($dev.health.md5))"

& $cli compile --fqbn esp32:esp32:esp32 --output-dir $build $sketch | Select-String "Sketch uses"
if ($LASTEXITCODE) { throw "Build failed" }
$md5 = (Get-FileHash (Join-Path $build "waypoint.ino.bin") -Algorithm MD5).Hash.ToLower()
if ($dev.health.md5 -eq $md5) { Write-Host "It already runs this build."; exit 0 }

Invoke-RestMethod "$Api/api/telemetry/$($dev.id)/command" -Method Post -ContentType "application/json" -Body '{"cmd":"update"}' | Out-Null
Write-Host "Told it to update; waiting for it to come back with the new build..."
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  Start-Sleep 3
  $now = (Invoke-RestMethod "$Api/api/telemetry").devices | Where-Object id -eq $dev.id
  if ($now.health.md5 -eq $md5 -and $now.age -lt 15) { Write-Host "Done: running the new build ($md5)."; exit 0 }
}
$log = (Invoke-RestMethod "$Api/api/telemetry/$($dev.id)?since=0").batches | ForEach-Object { $_.log } | Where-Object { $_ -and $_[1] -match "update" } | Select-Object -Last 3
throw "No new build after 2 minutes. Device log: $(($log | ForEach-Object { $_[1] }) -join ' / ')"
