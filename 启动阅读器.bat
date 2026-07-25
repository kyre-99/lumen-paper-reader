@echo off
cd /d "%~dp0"

REM 情况 1：服务已在健康运行（比如重复双击）——直接打开浏览器，不重复启动
curl -sf -o nul --max-time 2 http://localhost:3939/ >nul 2>&1
if not errorlevel 1 (
  echo 文枢服务已在运行，直接为你打开浏览器。
  start "" http://localhost:3939/
  timeout /t 3 >nul
  exit /b 0
)

REM 情况 2：端口被上次残留的异常进程（僵尸）占用——先清理再启动
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3939 " ^| findstr "LISTENING"') do (
  echo 检测到 3939 端口被异常残留进程占用，正在自动清理...
  taskkill /PID %%a /F >nul 2>&1
)

REM 情况 3：正常启动
echo ============================================
echo   文枢 Wenshu 阅读器启动中...
echo   服务就绪后浏览器会自动打开。
echo   关闭本窗口即可停止阅读器。
echo ============================================
echo.
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-browser.ps1"
npm run dev
