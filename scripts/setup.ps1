# Script de configuração inicial do ambiente Blog Turismo
$ErrorActionPreference = "Stop"

Write-Host "=== CONFIGURACAO DO BLOG TURISMO ===" -ForegroundColor Cyan

# 1. Verifica ambiente virtual
if (-not (Test-Path ".venv")) {
    Write-Host "Criando ambiente virtual Python..."
    python -m venv .venv
}

# 2. Instala dependencias
Write-Host "Instalando dependencias Python..."
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\pip.exe install -r requirements.txt pytest pytest-mock httpx

# 3. Cria arquivo .env se nao existir
if (-not (Test-Path ".env")) {
    Write-Host "Criando .env a partir de .env.example..."
    Copy-Item ".env.example" ".env"
}

# 4. Inicializa o banco de dados e sementes
Write-Host "Inicializando banco e categorias padrao..."
$env:PYTHONPATH = "."
.\.venv\Scripts\python.exe -m app.cli seed

Write-Host "`n[OK] Setup concluido com sucesso! Para iniciar o servidor, execute: .\scripts\dev.ps1" -ForegroundColor Green
