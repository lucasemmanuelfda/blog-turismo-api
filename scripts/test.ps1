# Executa a suite completa de testes (API Pytest + Cloudflare Worker)
$ErrorActionPreference = "Stop"

Write-Host "=== EXECUTANDO TESTES DA API (PYTEST) ===" -ForegroundColor Cyan
$env:PYTHONPATH = "."
.\.venv\Scripts\python.exe -m pytest tests

Write-Host "`n=== EXECUTANDO TESTES DO WORKER (NODE.JS) ===" -ForegroundColor Cyan
node worker/test-worker.mjs

Write-Host "`n[OK] Todos os testes passaram com sucesso!" -ForegroundColor Green
