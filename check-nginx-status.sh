#!/bin/bash
# 检查 Nginx 配置和状态

echo "=== 检查 Nginx 端口监听 ==="
sudo netstat -tlnp | grep nginx || sudo ss -tlnp | grep nginx

echo ""
echo "=== 检查配置文件中的端口 ==="
sudo grep -r "listen" /etc/nginx/conf.d/toptu.top.conf

echo ""
echo "=== 检查是否有 HTTPS server 块 ==="
sudo grep -B 5 -A 20 "listen.*443\|ssl_certificate" /etc/nginx/conf.d/toptu.top.conf

echo ""
echo "=== 测试 HTTP 访问 ==="
curl -I http://toptu.top 2>&1 | head -5

echo ""
echo "=== 测试 HTTPS 访问 ==="
curl -I -k https://toptu.top 2>&1 | head -5 || echo "HTTPS 无法访问"
