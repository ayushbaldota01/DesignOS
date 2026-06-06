@echo off
title DesignOS
color 0A
echo.
echo  ██████╗ ███████╗███████╗██╗ ██████╗ ███╗   ██╗ ██████╗ ███████╗
echo  ██╔══██╗██╔════╝██╔════╝██║██╔════╝ ████╗  ██║██╔═══██╗██╔════╝
echo  ██║  ██║█████╗  ███████╗██║██║  ███╗██╔██╗ ██║██║   ██║███████╗
echo  ██║  ██║██╔══╝  ╚════██║██║██║   ██║██║╚██╗██║██║   ██║╚════██║
echo  ██████╔╝███████╗███████║██║╚██████╔╝██║ ╚████║╚██████╔╝███████║
echo  ╚═════╝ ╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝
echo.
echo  Starting services...
echo.

:: Check Ollama
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe">NUL
if "%ERRORLEVEL%"=="1" (
    echo  [1/3] Starting Ollama...
    start /B "" ollama serve
    timeout /t 3 /nobreak >nul
) else (
    echo  [1/3] Ollama already running
)

:: Check CadQuery
echo  [2/3] Verifying CadQuery...
H:\Miniconda3\python.exe -c "import cadquery; print('  CadQuery OK')" 2>nul
if errorlevel 1 (
    echo  ERROR: CadQuery not found. Run: conda install -c conda-forge cadquery
    pause
    exit
)

:: Start DesignOS
echo  [3/3] Starting DesignOS server...
echo.
echo  Open browser: http://localhost:5000
echo  Press Ctrl+C to stop
echo.

cd /d H:\DesignOS
start "" http://localhost:5000
H:\Miniconda3\python.exe app.py
pause
