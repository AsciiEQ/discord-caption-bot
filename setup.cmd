@echo off
cd /d "%~dp0"
echo === AsciiEQ Discord Caption Bot - setup ===
echo.
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found.
  echo Install it from https://nodejs.org ^(LTS^), then run this again.
  echo.
  pause
  exit /b 1
)
echo Installing dependencies ^(this can take a minute^)...
call npm install
if errorlevel 1 (
  echo.
  echo Install failed. See the Troubleshooting section in README.md.
  pause
  exit /b 1
)
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created .env
)
echo.
echo Setup complete.
echo Next: open .env in Notepad, paste your bot token after DISCORD_BOT_TOKEN=,
echo then run start.cmd
echo.
pause
