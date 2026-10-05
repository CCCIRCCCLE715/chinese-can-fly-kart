#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if ! command -v node >/dev/null; then
  print '请先安装 Node.js 24 或更新版本，再双击启动。'
  read '?按回车关闭'
  exit 1
fi
node runtime/start.mjs --background || { read '?启动失败，按回车关闭'; exit 1; }
/usr/bin/open -a 'Google Chrome' "http://127.0.0.1:${KART_PORT:-18765}/" 2>/dev/null || /usr/bin/open "http://127.0.0.1:${KART_PORT:-18765}/"
