@echo off
setlocal EnableDelayedExpansion
REM Minibee viewer - poll + caps in one terminal; opens browser when ready
cd /d "%~dp0"

set "PHP=php"
if defined FS_BRIDGE_PHP set "PHP=%FS_BRIDGE_PHP%"

where "%PHP%" >nul 2>&1
if errorlevel 1 (
  echo PHP not found on PATH.
  echo Install PHP with curl and sockets, or set FS_BRIDGE_PHP to php.exe.
  pause
  exit /b 1
)

set "PHP_FLAGS="
call :probe "%PHP%"
if errorlevel 1 (
  for /f "delims=" %%P in ('where "%PHP%" 2^>nul') do (
    set "PHP_EXE=%%P"
    goto :got_exe
  )
  :got_exe
  for %%I in ("%PHP_EXE%") do set "PHP_DIR=%%~dpI"
  call :probe_n "%PHP_EXE%" "%PHP_DIR%"
  if errorlevel 1 (
    echo PHP needs curl and sockets extensions.
    echo Enable them in php.ini or reinstall PHP with those extensions.
    pause
    exit /b 1
  )
  set "PHP_FLAGS=-n -d extension_dir=%PHP_DIR%ext -d extension=curl -d extension=sockets"
)

set "MINIBEE_OPEN_BROWSER=1"
echo Using: %PHP% %PHP_FLAGS%
echo Starting Minibee bridge - browser will open at http://127.0.0.1:8765/
echo.
%PHP% %PHP_FLAGS% bridge\run.php
set "EC=%ERRORLEVEL%"
if not "%EC%"=="0" pause
exit /b %EC%

:probe
"%~1" -r "exit(extension_loaded('curl') && extension_loaded('sockets') ? 0 : 1);" >nul 2>&1
exit /b %ERRORLEVEL%

:probe_n
"%~1" -n -d "extension_dir=%~2ext" -d extension=curl -d extension=sockets -r "exit(extension_loaded('curl') && extension_loaded('sockets') ? 0 : 1);" >nul 2>&1
exit /b %ERRORLEVEL%
