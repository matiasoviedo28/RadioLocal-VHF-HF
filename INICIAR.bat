@echo off
title RadioLocal-VHF-HF - Iniciar
cd /d "%~dp0"

echo ============================================
echo   RadioLocal-VHF-HF - Iniciando...
echo ============================================
echo.

docker info >nul 2>&1
if errorlevel 1 (
    echo No se pudo conectar con Docker.
    echo.
    echo Abri Docker Desktop y espera a que diga "Docker Desktop is running".
    echo Despues, volve a hacer doble click en este archivo.
    echo.
    pause
    exit /b 1
)

echo Levantando los servicios ^(puede tardar unos segundos la primera vez^)...
echo.
docker compose up -d

if errorlevel 1 (
    echo.
    echo ============================================
    echo   Algo fallo al iniciar.
    echo ============================================
    echo Copia este mensaje y avisale a quien te dio este programa.
    echo.
    pause
    exit /b 1
)

echo.
echo Listo. Abriendo RadioLocal-VHF-HF en el navegador...
timeout /t 2 >nul
start http://localhost:8080

echo.
echo ============================================
echo   RadioLocal-VHF-HF esta funcionando.
echo ============================================
echo Podes cerrar esta ventana: el programa sigue funcionando solo.
echo Para apagarlo, usa "Apagar RadioLocal.bat".
echo.
pause
