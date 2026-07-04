@echo off
rem Windows wrapper for the ComputerCraft MCP server (see README.md).
rem Keep this file ASCII-only: cmd.exe misparses UTF-8 under legacy code pages.
setlocal
set "SCRIPT_DIR=%~dp0"
rem Unique log per instance: cmd holds ">>" redirects exclusively for the process
rem lifetime, so a long-running server instance would block any second one
rem (gate2.py, another MCP client) from starting if they shared one log file.
set "LOG=%TEMP%\cc-mcp-wrapper-%RANDOM%%RANDOM%.log"
if not defined CC_ROOT for %%I in ("%SCRIPT_DIR%..") do set "CC_ROOT=%%~fI"
rem Keep the Windows venv separate from the WSL one (.venv), or each uv rebuilds the other's.
set "UV_PROJECT_ENVIRONMENT=%SCRIPT_DIR%.venv-win"
rem uv cache (C:) and this venv (D:) sit on different drives; hardlinks are impossible anyway.
set "UV_LINK_MODE=copy"

echo [%date% %time%] wrapper start cc_root=%CC_ROOT% >> "%LOG%"

where uv >nul 2>nul
if errorlevel 1 goto try_venv
echo [%date% %time%] runner=uv >> "%LOG%"
uv run --project "%SCRIPT_DIR%." python "%SCRIPT_DIR%server.py" 2>> "%LOG%"
exit /b %errorlevel%

:try_venv
if not exist "%SCRIPT_DIR%.venv-win\Scripts\python.exe" goto no_runner
echo [%date% %time%] runner=venv-win >> "%LOG%"
"%SCRIPT_DIR%.venv-win\Scripts\python.exe" "%SCRIPT_DIR%server.py" 2>> "%LOG%"
exit /b %errorlevel%

:no_runner
echo [%date% %time%] neither uv nor .venv-win python found >> "%LOG%"
exit /b 1
