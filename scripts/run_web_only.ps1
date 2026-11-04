# Static frontend only (no vision backend): needs just Node or Python.
Set-Location "$(Split-Path $PSScriptRoot)\web"
Start-Process "http://127.0.0.1:8080"
python -m http.server 8080 --bind 127.0.0.1
