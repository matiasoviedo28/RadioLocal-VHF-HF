@echo off
title RadioLocal-VHF-HF - Apagar
cd /d "%~dp0"

echo ============================================
echo   RadioLocal-VHF-HF - Apagando...
echo ============================================
echo.

docker info >nul 2>&1
if errorlevel 1 (
    echo Docker no esta corriendo, asi que el programa ya esta apagado.
    echo.
    pause
    exit /b 0
)

docker compose down

if errorlevel 1 (
    echo.
    echo No se pudo apagar. Copia este mensaje y avisale a quien te dio este programa.
) else (
    echo.
    echo ============================================
    echo   RadioLocal-VHF-HF esta apagado.
    echo ============================================
)

echo.
pause
