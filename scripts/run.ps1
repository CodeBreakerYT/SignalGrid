# Starts the backend and serves the web UI at http://127.0.0.1:8765
Set-Location (Split-Path $PSScriptRoot)
Start-Process "http://127.0.0.1:8765"
.\.venv\Scripts\python.exe -m backend
