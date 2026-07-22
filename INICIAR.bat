@echo off
title RadioLocal-VHF-HF - Iniciar
cd /d "%~dp0"

echo ============================================
echo   RadioLocal-VHF-HF - Iniciando...
echo ============================================
echo.

docker info >nul 2>&1
if not errorlevel 1 goto DOCKER_OK

echo No se pudo conectar con Docker.
echo.

set "VIRT_OK="
for /f %%v in ('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled" 2^>nul') do set "VIRT_OK=%%v"

if /i "%VIRT_OK%"=="False" goto VIRT_OFF

echo Abri Docker Desktop y espera a que diga "Docker Desktop is running".
echo Despues, volve a hacer doble click en este archivo.
echo.
pause
exit /b 1

:VIRT_OFF
echo Tu PC tiene la VIRTUALIZACION DESACTIVADA en la BIOS/UEFI.
echo Docker necesita que este activada para poder funcionar.
echo.
echo Como activarla:
echo   1. Reinicia la PC y entra a la BIOS/UEFI ^(generalmente con F2, F10, Supr o Esc al prender^).
echo   2. Busca una opcion como "Virtualization Technology", "Intel VT-x" o "AMD-V / SVM Mode".
echo   3. Activala, guarda los cambios ^(F10 suele ser "Guardar y salir"^) y reinicia.
echo.
echo Si no encontras la opcion, busca en Google: el modelo de tu PC + "activar virtualizacion BIOS".
echo.
pause
exit /b 1

:DOCKER_OK
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
echo Para apagarlo, usa "APAGAR.bat".
echo.
pause
