@echo off
rem 雙擊啟動本機伺服器，之後用瀏覽器或 OBS 開 http://localhost:8788/
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Port 8788
pause
