# One-time setup: Python virtual environment + vision dependencies.  Use -NoYolo for an OpenCV-only install.
param([switch]$NoYolo)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot)
python -m venv .venv
$py = ".\.venv\Scripts\python.exe"
& $py -m pip install --upgrade pip
& $py -m pip install -r requirements.txt
if (-not $NoYolo) { & $py -m pip install -r requirements-yolo.txt }
Write-Host "Setup complete. Run .\scripts\run.ps1"
