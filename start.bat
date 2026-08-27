@echo off
title YouTube Downloader Multi-Audio
echo ==================================================
echo   YOUTUBE DOWNLOADER - MULTI AUDIO & DUBBING
echo ==================================================
echo.

echo [1/2] Memeriksa dependensi Python...
cd /d "%~dp0backend"
pip install -r requirements.txt

echo.
echo [2/2] Menjalankan Server Flask...
echo.
echo Buka browser Anda di: http://localhost:5000
echo.

python app.py
pause
