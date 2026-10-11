# Inicia a API em modo de desenvolvimento local com hot-reload
$ErrorActionPreference = "Stop"

$env:PYTHONPATH = "."
Write-Host "Iniciando Blog Turismo API em http://127.0.0.1:8000 (docs: http://127.0.0.1:8000/docs)..." -ForegroundColor Cyan
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
