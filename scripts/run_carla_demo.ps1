# One-click CARLA demo: starts the CARLA server (if needed), the SignalGrid backend, and the bridge that lets the
# neural agent control the real traffic lights. Open the app -> Vision Monitor -> CARLA to watch it with YOLO.
# Needs: CARLA 0.9.16 + Python 3.12 (the CARLA wheel). Edit $Carla below or pass -Carla "path".
param([string]$Carla = "F:\pluginFiles\simulation\CARLA_0.9.16", [int]$Seconds = 600, [switch]$Fixed)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot)
if (-not (Test-Path .venv-carla)) {
  py -3.12 -m venv .venv-carla
  .\.venv-carla\Scripts\python -m pip install -q "$Carla\PythonAPI\carla\dist\carla-0.9.16-cp312-cp312-win_amd64.whl" numpy "opencv-python-headless<5"
}
if (-not (Get-Process CarlaUE4 -ErrorAction SilentlyContinue)) {
  Start-Process "$Carla\CarlaUE4.exe" -ArgumentList "-RenderOffScreen","-quality-level=Low","-carla-rpc-port=2000"
  Write-Host "Waiting for CARLA to start..."; Start-Sleep 25
}
if (-not (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)) { Start-Process .\.venv\Scripts\python.exe -ArgumentList "-m","backend" ; Start-Sleep 5 }
Start-Process "http://127.0.0.1:8765/?mode=carla#vision"
$mode = if ($Fixed) { "fixed" } else { "ai" }
.\.venv-carla\Scripts\python -m carla_link.bridge --mode $mode --seconds $Seconds --warmup 20 --vehicles 100 --camera --ambulance --backend http://127.0.0.1:8765
