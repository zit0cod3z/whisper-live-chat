@echo off
setlocal

cd /d "%~dp0"

if "%WHISPER_HOST%"=="" set WHISPER_HOST=127.0.0.1
if "%WHISPER_PORT%"=="" set WHISPER_PORT=8787

echo Starting Whisper Room Live on %WHISPER_HOST%:%WHISPER_PORT%
python server.py
