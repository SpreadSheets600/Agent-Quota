@echo off
setlocal enabledelayedexpansion

set "REPO_URL=%~1"
set "TARGET_DIR=%~2"
if "%TARGET_DIR%"=="" set "TARGET_DIR=agent-status"

if not "%REPO_URL%"=="" (
  where git >nul 2>nul
  if errorlevel 1 (
    echo Error: git is not installed or not in PATH.
    exit /b 1
  )

  if exist "%TARGET_DIR%" (
    echo Error: target directory already exists: %TARGET_DIR%
    exit /b 1
  )

  echo [0/4] Cloning repository...
  git clone "%REPO_URL%" "%TARGET_DIR%"
  if errorlevel 1 exit /b 1
  cd /d "%TARGET_DIR%"
)

where bun >nul 2>nul
if errorlevel 1 (
  echo Error: Bun is not installed or not in PATH.
  echo Install Bun: https://bun.sh
  exit /b 1
)

echo [1/4] Installing dependencies...
call bun install
if errorlevel 1 exit /b 1

echo [2/4] Building standalone binary...
call bun run build
if errorlevel 1 exit /b 1

echo [3/4] Linking CLI globally...
call bun link
if errorlevel 1 exit /b 1

echo Installation complete. Run: agent-status
exit /b 0
