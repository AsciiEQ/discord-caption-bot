@echo off
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js not found. Run setup.cmd first. & pause & exit /b 1)
if not exist "node_modules" (echo Dependencies missing. Run setup.cmd first. & pause & exit /b 1)
if not exist ".env" (echo No .env found. Run setup.cmd, then paste your token into .env. & pause & exit /b 1)
echo Starting AsciiEQ caption bot. Keep this window open while you want captions.
echo Press Ctrl+C to stop.
echo.
node index.js
echo.
echo Bot stopped.
pause
