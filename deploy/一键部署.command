#!/usr/bin/env bash
# 双击运行:部署 Cloudflare + 把本机注册为执行节点
cd "$(dirname "$0")/.."
bash deploy/setup-all.sh
echo
read -p "按回车关闭窗口..." _
