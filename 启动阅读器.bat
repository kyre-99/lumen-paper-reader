@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   文枢 Wenshu 阅读器启动中...
echo   服务就绪后浏览器会自动打开。
echo   关闭本窗口即可停止阅读器。
echo ============================================
echo.
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-browser.ps1"
npm run dev
