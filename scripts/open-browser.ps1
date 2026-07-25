# 等待本地服务就绪后自动打开浏览器（端口被占用时 vinext 会顺延，故扫描 3000-3005）
$ports = 3000..3005
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
