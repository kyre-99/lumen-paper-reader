#!/usr/bin/env bash
# 文枢 Wenshu 一键启动：检查环境 → 安装依赖 → 生成本地配置 → 初始化数据库并启动
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "[文枢] 未检测到 Node.js，请先安装 22.13 或更高版本：https://nodejs.org/"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "[文枢] 当前 Node.js 版本过低（$(node -v)），需要 22.13 或更高版本：https://nodejs.org/"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[文枢] 首次运行，正在安装依赖（可能需要几分钟）…"
  npm install
fi

if [ ! -f .dev.vars ]; then
  echo "[文枢] 正在生成本地配置 .dev.vars（含随机密钥）…"
  GUEST_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  MODEL_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > .dev.vars <<EOF
LOCAL_ONLY=true
GUEST_SESSION_SECRET=${GUEST_SECRET}
MODEL_CONFIG_SECRET=${MODEL_SECRET}
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
EOF
fi

echo "[文枢] 正在初始化本地数据库并启动…"
npm run local
