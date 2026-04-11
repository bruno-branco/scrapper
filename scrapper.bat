@echo off
cd /d "%~dp0"

REM Run the Node app
node app.js

REM Keep window open to show output/errors
echo.
echo Press any key to exit...
pause >nul
