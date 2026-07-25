# 等待本地服务就绪后自动打开浏览器（端口固定为 3939，见 vite.config.ts strictPort）
$ports = @(3939)
$deadline = (Get-Date).AddMinutes(2)

while ((Get-Date) -lt $deadline) {
  foreach ($p in $ports) {
    try {
      $c = New-Object System.Net.Sockets.TcpClient
      $c.Connect('127.0.0.1', $p)
      $c.Close()
      Start-Process "http://localhost:$p/"
      exit 0
    } catch {}
  }
  Start-Sleep -Milliseconds 800
}
exit 1
