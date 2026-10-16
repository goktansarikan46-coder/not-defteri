@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Not Defteri sunucusu
echo.
echo  Not Defteri calisiyor. Bu pencereyi KAPATMA, kapatirsan uygulama durur.
echo.
echo  Bilgisayarda:  http://localhost:5173
echo  Tablette (ayni Wi-Fi), Chrome adres cubuguna "http://" ile birlikte yaz:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do echo      http://%%b:5173
)
echo.
start "" http://localhost:5173
python -m http.server 5173
pause
