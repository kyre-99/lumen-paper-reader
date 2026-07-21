@echo off
rem 文枢 Wenshu 一键启动：检查环境 → 安装依赖 → 生成本地配置 → 初始化数据库并启动
chcp 65001 >nul
setlocal
cd /d "%~dp0\.."

where node >nul 2>nul
if errorlevel 1 (
  echo [文枢] 未检测到 Node.js，请先安装 22.13 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo [文枢] 首次运行，正在安装依赖（可能需要几分钟）…
  call npm install
  if errorlevel 1 (
    echo [文枢] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

if not exist .dev.vars (
  echo [文枢] 正在生成本地配置 .dev.vars（含随机密钥）…
  for /f %%i in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set GUEST_SECRET=%%i
  for /f %%i in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set MODEL_SECRET=%%i
  (
    echo LOCAL_ONLY=true
    echo GUEST_SESSION_SECRET=%GUEST_SECRET%
    echo MODEL_CONFIG_SECRET=%MODEL_SECRET%
    echo OPENAI_BASE_URL=https://api.openai.com/v1
    echo OPENAI_API_KEY=
    echo OPENAI_MODEL=gpt-4.1-mini
  ) > .dev.vars
)

echo [文枢] 正在初始化本地数据库并启动…
call npm run local
pause
