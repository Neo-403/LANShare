#!/bin/sh
# LANShare · coturn 容器入口
# 密钥只从环境变量读取，不写进配置文件、镜像或 compose 命令行。
# 注意：本文件必须保持 LF 换行（见 .gitattributes），否则 /bin/sh 会报 \r 错误。
set -eu

: "${TURN_SECRET:?TURN_SECRET is required}"
: "${PUBLIC_HOST:?PUBLIC_HOST is required}"

set -- \
  --log-file stdout \
  --listening-port 3478 \
  --min-port 40000 \
  --max-port 40200 \
  --fingerprint \
  --use-auth-secret \
  --static-auth-secret "$TURN_SECRET" \
  --realm "$PUBLIC_HOST" \
  --no-tls \
  --no-dtls \
  --no-cli \
  --no-multicast-peers \
  --mobility

# 服务器位于 NAT 之后时填写 TURN_EXTERNAL_IP=公网IP/内网IP
if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
  set -- "$@" --external-ip "$TURN_EXTERNAL_IP"
fi

exec turnserver "$@"
