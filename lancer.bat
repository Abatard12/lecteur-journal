@echo off
cd /d "%~dp0"
echo ===== %date% %time% ===== >> storage\veille.log
npm start >> storage\veille.log 2>&1