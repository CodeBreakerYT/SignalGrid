<#
Builds the Windows desktop app with PyInstaller.
  .\scripts\build_exe.ps1            -> dist\SignalGrid\SignalGrid.exe  (YOLOv8 included, ~1 GB: PyTorch)
  .\scripts\build_exe.ps1 -Lite      -> lightweight build (OpenCV motion detector, ~120 MB)
#>
param([switch]$Lite)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot)
if (-not (Test-Path .venv)) { & "$PSScriptRoot\setup.ps1" }
$py = ".\.venv\Scripts\python.exe"
& $py -m pip install -q pyinstaller pywebview
$args = @("--noconfirm", "--clean", "--name", "SignalGrid", "--windowed", "--onedir",
  "--add-data", "web;web", "--hidden-import", "uvicorn.logging", "--hidden-import", "uvicorn.loops.auto", "--hidden-import", "uvicorn.protocols.http.auto", "--hidden-import", "uvicorn.lifespan.on", "--hidden-import", "backend.app")
if ($Lite) { $args += @("--exclude-module", "torch", "--exclude-module", "torchvision", "--exclude-module", "ultralytics") }
else { $args += @("--add-data", "backend\models;backend\models", "--collect-all", "ultralytics") }
& $py -m PyInstaller @args desktop\signalgrid_desktop.py
Write-Host "Built: dist\SignalGrid\SignalGrid.exe"
