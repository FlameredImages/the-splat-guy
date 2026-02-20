@echo off
title The Splat Guy
cd /d "%~dp0"
echo ================================================
echo   THE SPLAT GUY
echo   http://127.0.0.1:7861
echo ================================================
echo.
echo Starting server - browser will open automatically...
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:7861"
python app.py
pause
