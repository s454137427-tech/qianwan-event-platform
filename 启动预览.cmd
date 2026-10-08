@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% equ 0 (
  set "PREVIEW_NODE=node"
) else (
  set "PREVIEW_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
"%PREVIEW_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install Node.js and retry.
  pause
  exit /b 1
)
if not exist "node_modules\express" (
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo Install pnpm 11.25.0, then run: pnpm install --frozen-lockfile --ignore-scripts
    pause
    exit /b 1
  )
  call pnpm install --frozen-lockfile --ignore-scripts
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
"%PREVIEW_NODE%" scripts\setup.js
if errorlevel 1 (
  pause
  exit /b 1
)
"%PREVIEW_NODE%" --env-file-if-exists=.env -e "const c=require('./lib/config');fetch(c.origin+'/api/health',{signal:AbortSignal.timeout(1500)}).then(r=>r.json()).then(d=>process.exit(d.service==='qianwan-events'?0:1)).catch(()=>process.exit(1))"
if %errorlevel% equ 0 (
  "%PREVIEW_NODE%" --env-file-if-exists=.env -e "const c=require('./lib/config');console.log('Preview is already running: '+c.origin+'\nAdmin: '+c.origin+'/admin.html')"
) else (
  "%PREVIEW_NODE%" --env-file-if-exists=.env server.js
)
pause
