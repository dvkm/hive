@echo off
setlocal

set "HIVE_BUN=bun"
where bun >nul 2>nul
if errorlevel 1 set "HIVE_BUN=%USERPROFILE%\.bun\bin\bun.exe"

if not exist "%HIVE_BUN%" if /I not "%HIVE_BUN%"=="bun" (
  echo hive: bun not found ^(looked on PATH and %%USERPROFILE%%\.bun\bin^) 1>&2
  exit /b 127
)

"%HIVE_BUN%" "%~dp0..\cli\hive.ts" %*
exit /b %ERRORLEVEL%
