@echo off
rem Shared cargo / wasm-pack environment for every WebSurf app entrypoint.
rem Called by the 9 app scripts apps/{debug,game,viewer}/{build-dist,play,start-dev}.cmd.
rem Redirects caches and temp dirs into the REPOSITORY ROOT so all subprojects
rem share one copy:
rem   .cargo-home       CARGO_HOME (registry cache + prebuilt wasm-bindgen)
rem   .wasm-pack-cache  wasm-bindgen download / cargo-install cache
rem   .tmp              TMP/TEMP for build tooling
rem Usage (from any app root script):
rem   call "%~dp0..\..\src\scripts\cargo-env.cmd"
rem NOTE: keep this file pure ASCII with CRLF line endings.

for %%I in ("%~dp0..\..") do set "WSF_REPO_ROOT=%%~fI"
set "CARGO_HOME=%WSF_REPO_ROOT%\.cargo-home"
set "WASM_PACK_CACHE=%WSF_REPO_ROOT%\.wasm-pack-cache"
set "TMP=%WSF_REPO_ROOT%\.tmp"
set "TEMP=%WSF_REPO_ROOT%\.tmp"

if not exist "%CARGO_HOME%" mkdir "%CARGO_HOME%"
if not exist "%WASM_PACK_CACHE%" mkdir "%WASM_PACK_CACHE%"
if not exist "%TMP%" mkdir "%TMP%"

rem Prebuilt wasm-bindgen detection: enumerate the `.wasm-bindgen-cargo-install-*`
rem dirs under WASM_PACK_CACHE (put there by src/scripts/install-wasm-bindgen.cmd)
rem and keep the LAST one that has bin\wasm-bindgen.exe; if none matched, fall back
rem to CARGO_HOME\bin. The variable is set for callers and downstream build tooling --
rem no .cmd script in this repo reads it back.
if not defined WASM_BINDGEN for /d %%D in (%WASM_PACK_CACHE%\.wasm-bindgen-cargo-install-*) do (
    if exist "%%D\bin\wasm-bindgen.exe" set "WASM_BINDGEN=%%D\bin\wasm-bindgen.exe"
)
if not defined WASM_BINDGEN if exist "%CARGO_HOME%\bin\wasm-bindgen.exe" set "WASM_BINDGEN=%CARGO_HOME%\bin\wasm-bindgen.exe"
exit /b 0
