@echo off
rem Shared cargo/wasm-pack environment for all Websurf app entrypoints.
rem Redirects caches and temp dirs into the REPOSITORY ROOT so every
rem subproject (debug / game / viewer / test/*) shares a single copy
rem instead of each keeping its own (historically debug-only):
rem   .cargo-home       CARGO_HOME (registry cache + prebuilt wasm-bindgen)
rem   .wasm-pack-cache  wasm-bindgen download / cargo-install cache
rem   .tmp              TMP/TEMP for build tooling (bypasses system TEMP ACLs)
rem Usage (from any app root script):
rem   call "%~dp0..\src\scripts\cargo-env.cmd"
rem NOTE: keep this file pure ASCII with CRLF line endings.

for %%I in ("%~dp0..\..") do set "WSF_REPO_ROOT=%%~fI"
set "CARGO_HOME=%WSF_REPO_ROOT%\.cargo-home"
set "WASM_PACK_CACHE=%WSF_REPO_ROOT%\.wasm-pack-cache"
set "TMP=%WSF_REPO_ROOT%\.tmp"
set "TEMP=%WSF_REPO_ROOT%\.tmp"

if not exist "%CARGO_HOME%" mkdir "%CARGO_HOME%"
if not exist "%WASM_PACK_CACHE%" mkdir "%WASM_PACK_CACHE%"
if not exist "%TMP%" mkdir "%TMP%"

rem Prebuilt wasm-bindgen detection: pick the newest cargo-install copy under
rem WASM_PACK_CACHE (installed by debug/scripts/install-wasm-bindgen.cmd),
rem falling back to CARGO_HOME\bin. Callers may rely on WASM_BINDGEN after this.
if not defined WASM_BINDGEN for /d %%D in (%WASM_PACK_CACHE%\.wasm-bindgen-cargo-install-*) do (
    if exist "%%D\bin\wasm-bindgen.exe" set "WASM_BINDGEN=%%D\bin\wasm-bindgen.exe"
)
if not defined WASM_BINDGEN if exist "%CARGO_HOME%\bin\wasm-bindgen.exe" set "WASM_BINDGEN=%CARGO_HOME%\bin\wasm-bindgen.exe"
exit /b 0
