@echo off
setlocal EnableDelayedExpansion
title Instalar Nomic Embed v2 MoE - Q8_0
chcp 65001 >nul
cd /d "%~dp0"

set "MODEL_NAME=nomic-embed-text-v2-moe:q8_0"
set "GGUF=nomic-embed-text-v2-moe.Q8_0.gguf"
set "MODELFILE=Modelfile"

echo ============================================================
echo   Instalador de modelo Ollama
echo   Modelo a crear : %MODEL_NAME%
echo   Carpeta        : %CD%
echo ============================================================
echo.

rem ---------- 1) Ollama instalado -------------------------------
echo [1/6] Comprobando Ollama...
where ollama >nul 2>&1
if not errorlevel 1 goto :OLLAMA_OK
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
    goto :OLLAMA_OK
)
echo.
echo   [ERROR] No se encontro 'ollama'. Descargalo e instalalo desde
echo           https://ollama.com/download y vuelve a ejecutar este script.
goto :FIN_ERROR

:OLLAMA_OK
for /f "usebackq delims=" %%V in (`ollama --version 2^>^&1`) do set "OLLAMA_VER=%%V"
echo       OK  -  !OLLAMA_VER!
echo.

rem ---------- 2) Servicio de Ollama activo ----------------------
echo [2/6] Comprobando que el servicio de Ollama responde...
ollama list >nul 2>&1
if not errorlevel 1 goto :SERVICIO_OK

echo       No responde. Iniciando "ollama serve" en segundo plano...
start "Ollama Serve" /min cmd /c "ollama serve"
set /a intentos=0

:ESPERA_SERVIDOR
set /a intentos+=1
timeout /t 2 /nobreak >nul
ollama list >nul 2>&1
if not errorlevel 1 goto :SERVICIO_OK
if !intentos! LSS 10 goto :ESPERA_SERVIDOR

echo.
echo   [ERROR] El servicio de Ollama no respondio tras varios intentos.
echo           Abre otra ventana, ejecuta 'ollama serve' y vuelve a correr esto.
goto :FIN_ERROR

:SERVICIO_OK
echo       OK
echo.

rem ---------- 3) Archivo GGUF presente --------------------------
echo [3/6] Comprobando el archivo del modelo en esta carpeta...
if exist "%GGUF%" goto :GGUF_EXISTE
echo.
echo   [ERROR] Falta el archivo: %GGUF%
echo.
echo   Copialo en esta carpeta desde Hugging Face:
echo     https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe-GGUF
echo     (archivo: nomic-embed-text-v2-moe.Q8_0.gguf, 488 MiB)
echo.
echo   Destino: %CD%
goto :FIN_ERROR

:GGUF_EXISTE
rem Los marcadores "Pega aqui ..." que trae la carpeta estan vacios (0 bytes):
rem si el usuario no copio el modelo, hay que avisar con un mensaje claro.
for %%S in ("%GGUF%") do set "GGUF_SIZE=%%~zS"
if not "!GGUF_SIZE!"=="0" goto :GGUF_BIEN
echo.
echo   [ERROR] El archivo "%GGUF%" esta vacio (0 bytes).
echo           Ese es el marcador de posicion: aun no copiaste el modelo.
echo.
echo   Descargalo desde:
echo     https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe-GGUF
echo.
echo   Debe quedar en: %CD%\%GGUF%
goto :FIN_ERROR

:GGUF_BIEN
echo       OK    %GGUF%  ^(!GGUF_SIZE! bytes^)
echo.

rem ---------- 4) Modelfile presente y valido ---------------------
echo [4/6] Comprobando "%MODELFILE%"...
if exist "%MODELFILE%" goto :MF_EXISTE
echo.
echo   [ERROR] No se encontro '%MODELFILE%' en esta carpeta.
echo           Descargalo junto al modelo y vuelve a ejecutar esto.
goto :FIN_ERROR

:MF_EXISTE
for %%S in ("%MODELFILE%") do set "MF_SIZE=%%~zS"
if not "%MF_SIZE%"=="0" goto :MF_BIEN
echo.
echo   [ERROR] '%MODELFILE%' esta vacio.
goto :FIN_ERROR

:MF_BIEN
findstr /r /c:"^FROM" "%MODELFILE%" >nul 2>&1
if not errorlevel 1 goto :MF_OK
echo.
echo   [ERROR] '%MODELFILE%' no contiene ninguna linea FROM.
echo           Revisa que copiaste el contenido completo.
goto :FIN_ERROR

:MF_OK
rem Quita el BOM UTF-8 si Notepad lo agrego (rompe el parser de Ollama)
powershell -NoProfile -Command "$p='%MODELFILE%'; $b=[IO.File]::ReadAllBytes($p); if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { [IO.File]::WriteAllBytes($p,$b[3..($b.Length-1)]); Write-Host '      BOM UTF-8 eliminado' }" >nul 2>&1
echo       OK
echo.

rem ---------- 5) Limpiar intentos previos -----------------------
echo [5/6] Eliminando pruebas anteriores del mismo modelo...
ollama rm "%MODEL_NAME%" >nul 2>&1
ollama rm nomic-embed-text-v2-moe:latest >nul 2>&1
ollama rm nomic-embed-text-v2-moe:512 >nul 2>&1
ollama rm nomic-v2-moe:latest >nul 2>&1
echo       OK
echo.

rem ---------- 6) Crear el modelo -------------------------------
echo [6/6] Creando el modelo "%MODEL_NAME%"...
echo       (puede tardar un momento la primera vez)
echo.
ollama create "%MODEL_NAME%" -f "%MODELFILE%"
if errorlevel 1 goto :CREATE_ERROR

ollama list | findstr /i "nomic-embed" >nul 2>&1
if errorlevel 1 (
    echo       AVISO: no aparece en el listado, aunque 'create' no reporto error.
) else (
    echo       OK - "%MODEL_NAME%" aparece en la lista
)

echo.
echo ============================================================
echo   INSTALACION COMPLETADA
echo.
echo   Este modelo sirve para la busqueda semantica del Chat IA
echo   y el panel de Recomendaciones. WebPlay lo detecta solo.
echo.
echo   En WebPlay, abre los ajustes del Chat IA y elige
echo   "%MODEL_NAME%" en el desplegable de modelo.
echo ============================================================
echo.
pause
exit /b 0

:CREATE_ERROR
echo.
echo   [ERROR] 'ollama create' fallo. Revisa los mensajes de arriba.
goto :FIN_ERROR

:FIN_ERROR
echo.
echo El proceso se detuvo. Revisa el mensaje de arriba.
pause
exit /b 1
