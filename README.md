# LANShare

浏览器打开即用的局域网 / 跨网络分享工具：房间制、文本与文件、内网直连优先、外网打洞、TURN 或服务器 WS 中继兜底。**不部署 coturn 也能跨网使用**——打洞失败时由 LANShare 自身经 WebSocket 中转聊天与文件，只需 443 端口。两人时走连续流直传，多人时启用多源 P2P 分片；支持断点续传与息屏保护，服务器不保存聊天记录与文件。

完整设计与协议见 [`docs/开发文档.md`](docs/开发文档.md)。

## 构建

```bash
go build -o lanshare.exe .        # Windows
# go build -o lanshare .          # Linux / macOS
```

零第三方依赖，编译产物只有一个可执行文件（静态页面已 `go:embed` 内置）。

### 图标

网页标签与 Windows `lanshare.exe` 共用顶栏的 **LS** 徽标（`#2563eb` 圆角方块 + 白色 LS）：

| 文件 | 用途 |
|---|---|
| `web/favicon.svg` / `web/favicon.ico` / `web/apple-touch-icon.png` | 浏览器标签、书签、iOS 桌面图标；由 `//go:embed all:web` 自动提供，无需额外路由 |
| `rsrc_windows_amd64.syso` / `rsrc_windows_arm64.syso` | Windows exe 的图标资源；Go 在 `GOOS=windows` 时按文件名后缀自动链接，Linux / macOS / 容器构建会忽略 |

改图标只需编辑 `tools/mkicon/main.go` 顶部的 `glyph` / `corner` / `blue`，再在项目根目录重新生成并提交（纯标准库，无需 `rsrc` / `windres` 等外部工具）：

```bash
go generate ./...     # 等价于 go run ./tools/mkicon
```

CI 与 Docker 构建直接使用仓库中的生成物，不运行生成器。

### 交叉编译到 NAS（Linux）

`go:embed` 把**构建时磁盘上的** `web/` 一起打进二进制；改过前端必须重新编译并替换 NAS 上的文件，只更新 `web/` 无效。

群晖 x86_64（`uname -m` = `x86_64`），在项目根目录用 PowerShell：

```powershell
$env:GOOS = "linux"; $env:GOARCH = "amd64"; $env:CGO_ENABLED = "0"
go build -trimpath -ldflags="-s -w" -o lanshare .
go version -m lanshare          # 应含 GOOS=linux / GOARCH=amd64 / CGO_ENABLED=0
```

Linux / macOS / WSL：

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o lanshare .
```

| 目标 | `GOARCH` |
|---|---|
| 群晖 x86_64（Intel/AMD CPU） | `amd64` |
| 群晖 ARM（`uname -m` = `aarch64`） | `arm64` |

产物约 7.3 MB、纯静态。`CGO_ENABLED=0` 必须带，否则在精简系统上会报 `No such file or directory`。校验格式：

```bash
file lanshare                              # ELF 64-bit ... x86-64
head -c 4 lanshare | od -An -tx1           # 7f 45 4c 46 = ELF；4d 5a = Windows PE（传错了）
```

> `lanshare` 是二进制，**不能**用 `bash lanshare` / `sh lanshare` 启动（会报 `cannot execute binary file`），必须 `chmod +x` 后 `./lanshare`。

### CI 自动发布（GitHub Actions）

[`.github/workflows/release.yml`](.github/workflows/release.yml) 每次都从当前源码重新构建，不使用本地产物。

**普通提交推送（push 到分支）不会触发构建**，只有打了 `v*` 标签或在 Actions 页面手动运行才会构建 —— 避免「一次提交 + 一次 tag」跑两遍。

| 触发 | 二进制 artifact | GitHub Release | 镜像标签 |
|---|---|---|---|
| `push` tag `v*` | ✅ | ✅ 附带全部平台二进制 + `SHA256SUMS.txt` | `1.2.3` / `1.2` / `latest` / `sha-xxxxxxx` |
| 手动运行 workflow | ✅ | 填 `version` 才创建 | `sha-xxxxxxx`（可勾 `push_latest` 加 `latest`） |

Release 产物（文件名固定，便于脚本 / 文档用固定链接）：

| 文件 | 目标 |
|---|---|
| `lanshare-windows-amd64.exe` / `lanshare-windows-arm64.exe` | Windows x64 / ARM64 |
| `lanshare-linux-amd64` / `lanshare-linux-arm64` / `lanshare-linux-armv7` | Linux x86_64（含群晖）/ ARM64 / ARMv7 |

均为 `CGO_ENABLED=0` 静态二进制，已内置 `web/`。固定下载地址示例：`https://github.com/Neo-403/LANShare/releases/latest/download/lanshare-linux-amd64`。

镜像同时推送到（`linux/amd64`、`linux/arm64`、`linux/arm/v7` 三架构 manifest）：

- `ghcr.io/neo-403/lanshare` —— 用内置 `GITHUB_TOKEN` 推送，**无需配置任何 secret**；`org.opencontainers.image.source` 指向本仓库，推送后出现在仓库的 Packages 页面。
- `docker.io/<DOCKERHUB_USERNAME>/lanshare` —— 需要配置凭据，仓库需先在 Docker Hub 创建。

在 `Settings → Secrets and variables → Actions` 配置：

| 类型 | 名称 | 说明 |
|---|---|---|
| Secret | `DOCKERHUB_TOKEN` | Docker Hub Access Token（不要用登录密码） |
| Variable | `DOCKERHUB_USERNAME` | Docker Hub 用户名 |
| Variable | `DOCKERHUB_REPO` | 可选，默认 `lanshare` |

未配置 Docker Hub 凭据时自动跳过该推送，GHCR 仍正常发布（会输出一条 notice）。

> `Dockerfile` 的编译阶段固定跑在 `$BUILDPLATFORM` 上，用 `TARGETOS` / `TARGETARCH` / `TARGETVARIANT` 交叉编译，多平台构建不必用 QEMU 模拟 Go 工具链；本地 `docker compose build` 下这三个 ARG 为空，会回退到构建机架构。

#### 版本标签与发版

自动构建的版本号来自 git tag：**必须 `v` 开头且符合语义化版本**（`vMAJOR.MINOR.PATCH`）。推送 tag 会同时触发 Release 与镜像构建；下面第一步的 `git push origin main` 只是让 tag 指向远端已存在的提交，本身不会触发 workflow。

```bash
git status --short  # 检查状态
git push origin main  # 先让 tag 指向远端已存在的提交
git tag -a v1.2.3 -m "LANShare v1.2.3"  # 附注标签
git push origin v1.2.3  # 精确推送这一个标签
```

不要用 `git push --tags`：会把本地所有历史标签一并推上去，可能同时触发多个构建；必要时先 `git tag -l` 核对清单。

| 位置 | 取自 | `v1.2.3` 的结果 |
|---|---|---|
| 触发条件 | `on.push.tags: ['v*']` | 命中，运行 binaries / release / docker 三个 job |
| GitHub Release 名与 tag | `github.ref_name` | `v1.2.3`（带 `v`） |
| Release 二进制附件 | 固定文件名 | `lanshare-linux-amd64` 等，不含版本号 |
| 镜像标签 | `type=semver` | `1.2.3` / `1.2` / `latest`（不带 `v`）；GHCR 与 Docker Hub 同一组 |

规则：

- `1.2.3`（无 `v`）不触发 workflow；`release-2026` 也不触发。
- `v1.2` / `v2` 会触发并创建 Release，但 `type=semver` 匹配不上，镜像只剩 `latest` + `sha-xxxxxxx`。
- tag 含 `-`（如 `v1.2.3-rc1`）时 Release 自动标记为预发布，镜像标签为 `1.2.3-rc1`。
- 打错版本号建议直接换新号；确需删除：`git tag -d v1.2.3` + `git push --delete origin v1.2.3`。同名 tag 再次 push 会重跑构建并覆盖已有 Release 附件。

**手动运行 workflow 的区别**：`workflow_dispatch` 的 `version` 输入只用于创建名为该值的 Release（`tag_name`），**镜像拿不到版本号标签** —— `type=semver` 只认 tag 事件，手动运行时镜像仅有 `sha-xxxxxxx`（勾 `push_latest` 会多一个 `latest`）。要让镜像带版本号必须走 git tag。

**版本号不写入二进制**：构建参数是 `-ldflags="-s -w"`，程序没有版本变量也没有 `-version`，版本号只体现在 Release 与镜像标签上。

可选增强（当前未启用，需要时再改）：

- 让手动运行也带版本标签：在 `docker/metadata-action` 的 `tags:` 中加 `type=raw,value=${{ inputs.version }},enable=${{ github.event_name == 'workflow_dispatch' && inputs.version != '' }}`。
- 让 `./lanshare -version` 输出版本号：Go 侧加 `var version = "dev"` 与对应 flag，构建改成 `-ldflags="-s -w -X main.version=<tag>"`，Dockerfile 侧用 `ARG VERSION` 传入。

---

## 快速开始

### 1. 本机体验（仅 localhost）

```powershell
.\lanshare.exe -no-tls -addr :8080
```

打开 `http://localhost:8080`。**手机不能这样访问**：WebRTC 要求 HTTPS 安全上下文，`http://192.168.x.x` 不可用。日志现在会显示成完整 URL：`LANShare listening on http://localhost:8080`。

### 2. 局域网试用（手机 + 电脑，自签证书）

```powershell
.\lanshare.exe -addr :8443 -export-cert deploy\cert\lanshare
```

日志会同时给出 `https://localhost:8443` 与本机私网 IP 的访问地址。把生成的 `.crt` 装到手机并信任（Android：设置 → 加密与凭据 → 从存储安装；iOS：安装描述文件后需在「证书信任设置」中开启完全信任）。之后可用 `-cert/-key` 固定复用，避免重启换证书。

### 3. 生产部署（Docker + Nginx，推荐）

**证书由 Nginx 提供**：容器内 `lanshare` 跑纯 HTTP，TLS 在 Nginx 终止。**默认只启动 `lanshare` 一个容器**，不依赖 coturn，也不需要开放任何 UDP 端口；coturn 是按需开启的可选 profile。

```bash
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
# 编辑 .env：HTTP_PORT=反代后端端口（默认 8080）；PUBLIC_HOST 仅启用可选 coturn 时才需要
docker compose up -d          # 使用已发布镜像，无需源码、无需 --build
curl http://127.0.0.1:8080/health   # {"ok":true,"rooms":0,"peers":0}
```

> `docker-compose.yml` 已把 coturn 入口脚本内联，所以**只需 `docker-compose.yml` + `.env` 两个文件**即可部署，不必拉取仓库。校验 compose 配置无需拉取镜像：`docker compose --env-file .env.example config --quiet`。若镜像拉取超时请配置镜像加速。

Nginx 站点配置可参考 `deploy/nginx.conf.example`（独立参考文件，不是运行依赖）：替换域名与证书路径后 `nginx -t && nginx -s reload`。浏览器访问 `https://<PUBLIC_HOST>`。反代只需正常支持 WebSocket 升级（`Upgrade` / `Connection`），**不需要转发 UDP**，也不需要为中继调整 `client_max_body_size`（WS 升级后是 TCP 流，不受 HTTP body 限制）。

| 服务 | 作用 | 端口 | 默认 |
|---|---|---|---|
| `lanshare` | 页面 + WS 信令 + 无 TURN 时的 WS 中继 | `8080 tcp`（由 Nginx 反代） | 启动 |
| `coturn` | 可选：标准 STUN/TURN 中继 | `3478 udp/tcp`、`40000-40200 udp` | 不启动（`profiles: turn`） |

默认模式防火墙只需放行 `443 tcp`。若确需标准 TURN（对称 NAT 下追求更高吞吐）：

```bash
openssl rand -hex 24          # 生成 TURN_SECRET
# .env 中填 TURN_SECRET、TURN_URLS、TURN_EXTERNAL_IP（NAT 后必填），然后：
docker compose --profile turn up -d
# 再放行 3478 udp+tcp 与 40000-40200 udp
```

#### 3.1 两种部署模式与服务器中继

服务端在 `welcome` / `joined` 的 `ice` 里同时下发 `iceServers` 与 `noIceServers`，前端据此决定链路，**不再靠运行时猜测**。`noIceServers=true` 的准确条件是「最终没有下发任何 STUN/TURN」——除了两个变量都留空，配了 `TURN_URLS` 却没配 `TURN_SECRET` 导致 TURN 无法下发时也一样。

| 配置 | `iceServers` | 行为 |
|---|---|---|
| `LANSHARE_STUN_URLS` 和 `LANSHARE_TURN_URLS` **都留空**（默认） | 空 | 内网仍走 `host` 直连；跨网无法打洞，给内网直连留 2.5s 窗口后直接切服务器 WS 完整中继 |
| 配了 STUN / TURN（任一或两者） | 按配置下发 | 正常走 ICE 协商；只有 ICE 明确失败才落 WS 兜底 |

两种模式共同的链路优先级：

```text
host（内网直连） → srflx（STUN 打洞） → relay（外部 TURN） → WS 完整中继
```

默认模式专门用于**没有可用外网 STUN/TURN 的环境**（纯内网、公共 STUN 不可达），也是「不部署 coturn」的兜底：只要 443 能通，聊天和文件都能传。想跨网打洞就在 `.env` 里填 `STUN_URLS`；想要标准 TURN 再填 `TURN_URLS` + `TURN_SECRET` 并启用 `--profile turn`。

配置了 STUN/TURN 时**不启用抢跑定时器**，完全交给 ICE，避免 TURN 还没建好就被切到慢链路；只有所有 PeerConnection 进入 `failed` / `disconnected` / `closed` 才落 WS 兜底。P2P 恢复后自动切回。UI 会把该链路标为「中继」，并提示速度受服务器带宽限制。

三类帧都只在服务端内存透传 / 处理，不解析业务内容、不落盘：

| 帧 | 方向 | 承载 | 限制 |
|---|---|---|---|
| `relay` | C→S→C | 聊天、历史、文件控制帧（base64 JSON） | ≤64KB/帧 |
| `relay_data` | C→S→C | 文件分片 128KB、两人直传整帧（`k=data\|direct`，base64） | base64 文本 ≤256KB / 解码后 ≤192KB |
| `relay_pause` | S→C | 接收端队列拥塞时通知发送方暂停 `ms` 毫秒 | 尽力而为，满队列时可丢弃 |

`relay` 与 `relay_data` 共用 **1000 帧/s**（突发 2000）的次数限制，仅用于防小帧洪泛。中继带宽**默认不设上限**，尽可能跑满实际链路；需要限速时用 `-relay-rate` / `LANSHARE_RELAY_RATE_MB`（单位 MB/s，按单个 WS 连接计），compose 里对应 `.env` 的 `RELAY_RATE_MB`，默认 `0` 即不限速。例如 `RELAY_RATE_MB=20` 把每连接限制在 20MB/s，内部令牌桶 `rate=20MB/s`、`burst=2×rate`。单帧大小与 `k` 白名单仍作为协议/防滥用硬限制保留。

前端 `Mesh` 在中继模式下用 WebSocket 整体替换 DataChannel，因此文件网格、多源分工、直传与断点续传逻辑都不变；私有房的文件帧仍是 AES-GCM 密文，服务端看不到内容。

注意：

- 所有数据都走服务器现有的 443 连接，上下行都占用服务器带宽；服务端默认不限速，但速度仍取决于实际链路，通常慢于 P2P。
- 私有房的 `key_req` / `key_sync` 明文握手帧在极端降级时会经过服务端内存（不落盘）；正常 P2P 链路下服务端只见密文。自建服务器时这是可接受的取舍。
- 若把 `STUN_URLS` 指向了 coturn 的 `3478`，停用 coturn 时要改成其它 STUN，或干脆留空直接走服务器中继；否则浏览器会一直等一个不存在的打洞服务器。
- `docker-compose.yml` 目前把后端端口硬编码为 `"8080:8080"`（监听所有网卡），`HTTP_PORT` 只用于说明 Nginx 的反代目标。生产环境建议改成 `"127.0.0.1:8080:8080"` 或用防火墙限制：后端开启了 `LANSHARE_TRUST_PROXY=1`，外部若绕过 Nginx 直连 8080 可伪造 `X-Forwarded-For`。

### 4. 裸机部署（不用 Docker）

**默认只需要一个进程**：不配置任何 STUN/TURN 时，内网仍走 `host` 直连，跨网直接由服务器 WS 完整中继，不需要外部打洞服务器：

```bash
./lanshare -no-tls -addr 127.0.0.1:8080 -trust-proxy
```

可选：另起 coturn 做标准 TURN（`deploy/turnserver.conf` 改好 `static-auth-secret` 与 `external-ip`），并把同一个密钥与 TURN URL 传给 `lanshare`：

```bash
# 进程 1（可选）
turnserver -c deploy/turnserver.conf

# 进程 2：Nginx 反代场景（对外 HTTPS 由 Nginx 提供）
LANSHARE_TURN_SECRET=<同一个密钥> \
LANSHARE_TURN_URLS='turn:share.example.com:3478?transport=udp,turn:share.example.com:3478?transport=tcp' \
./lanshare -no-tls -addr 127.0.0.1:8080 -trust-proxy
```

若不用反代、直接由程序持有正式证书：`./lanshare -addr :443 -cert fullchain.pem -key privkey.pem`。

#### 4.1 本地 Nginx + 自定义端口完整示例（以 6001 为例）

`8080` 只是 compose 的默认映射，裸机端口可任意：`-addr` 与 Nginx 的 `proxy_pass` 改成同一个空闲端口即可。下面给出把所有常用参数都显式写出的启动命令（默认无 STUN/TURN → 服务器 WS 完整中继）：

```bash
./lanshare \
  -no-tls \
  -trust-proxy \
  -addr 127.0.0.1:6001 \
  -stun-urls '' \
  -turn-urls '' \
  -relay-rate 0 \
  -max-rooms 200 \
  -max-members 10 \
  -turn-ttl 3600

# 查看Docker Nginx网关,开放的地址设为网关地址,并且Nginx中服务地址也配置为该网关地址
docker inspect <nginx容器名> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$v.Gateway}}{{end}}'
# 或 ip addr show docker0 | grep inet     → 常见 172.17.0.1
```

各参数含义见「主要参数」表。`-stun-urls '' -turn-urls ''` 可省略（默认即空），显式写出是为了锁定 `noIceServers=true`；`-relay-rate 0` 表示中继不限速，要限速就填 MB/s（如 `20`）。**必须用 `127.0.0.1` 而不是 `:6001`**：开了 `-trust-proxy` 又监听所有网卡时，外部可绕过 Nginx 直连后端并伪造 `X-Forwarded-For`，骗取「同局域网」的房间可见性。

等价的环境变量 / 后台常驻写法：

```bash
LANSHARE_NO_TLS=1 \
LANSHARE_TRUST_PROXY=1 \
LANSHARE_ADDR=127.0.0.1:6001 \
LANSHARE_STUN_URLS= \
LANSHARE_TURN_URLS= \
LANSHARE_RELAY_RATE_MB=0 \
nohup ./lanshare >> lanshare.log 2>&1 &
```

对应的 Nginx 站点配置（把 `deploy/nginx.conf.example` 里两处 `proxy_pass` 的 8080 改成 6001；`map` 必须放在 `http{}` 段）：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name share.example.com;          # 本地可换 localhost 或本机 IP
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name share.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # 服务端不接收 HTTP 文件上传；WS 升级后是 TCP 流，不受此限制，无需调大
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:6001;
        proxy_http_version 1.1;

        # 关键 1：Host 须与浏览器 Origin 域名一致，否则 /ws 升级被拒绝
        proxy_set_header Host               $host;
        proxy_set_header X-Forwarded-Host   $host;
        proxy_set_header X-Forwarded-Proto  $scheme;

        # 关键 2：$remote_addr 覆盖，不要用 $proxy_add_x_forwarded_for 追加
        proxy_set_header X-Forwarded-For    $remote_addr;

        # 关键 3：WebSocket 升级 + 关闭缓冲
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location = /health {
        proxy_pass http://127.0.0.1:6001/health;
        access_log off;
    }
}
```

三个必配项见「反向代理的必配项」。`Host` 的 Origin 校验只比较 hostname，用非标端口（如 `listen 8443`）不影响匹配。本地自签证书（手机访问需装进系统信任，且 SAN 要覆盖实际域名 / 内网 IP，也可用 `mkcert`）：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout privkey.pem -out fullchain.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

只在 `localhost` 单浏览器里试用时，可去掉 TLS 段、直接 `listen 80` 反代到 6001（`localhost` 属于安全上下文），跨设备一律要 HTTPS。Windows 本机把命令换成 `.\lanshare.exe ...`，Nginx 配置放 `conf\nginx.conf`，`proxy_pass` 不变。群晖 DSM 的 `map` 重复定义与配置存放位置见 5.3。

验收：

```bash
nginx -t && nginx -s reload
curl -i http://127.0.0.1:6001/health          # 后端直连：{"ok":true,"rooms":0,"peers":0}
curl -ik https://share.example.com/health     # 经 Nginx：同样的 200
```

DevTools → Network → WS 应见 `/ws` 返回 `101 Switching Protocols` 且连接保持；`lanshare.log` 不应出现 `ws upgrade rejected ... origin not allowed`。跨网用 4G 设备验证链路显示「中继」且文件可传；防火墙只需放行 `443 tcp`，WS 中继不需要任何 UDP 端口。

### 5. 群晖 NAS：裸机二进制 + Nginx 反代（DSM 7）

不装 Docker，只在 NAS 上跑一个 `lanshare`，由群晖自带 Nginx 对外提供 HTTPS/WSS。下面以 `/go` 为例，可换成任意目录。

```
浏览器 https://域名 ──443──> 群晖 Nginx（TLS 终止 + WS 升级透传）──127.0.0.1:8080──> ./lanshare -no-tls -trust-proxy
```

#### 5.1 上传并启动

先传成 `.new` 再 `mv` 覆盖：直接覆盖正在运行的二进制会报 `Text file busy`，`mv` 换 inode 不会。

开发机（PowerShell），或用 File Station 上传后重命名：

```powershell
scp .\lanshare root@<NAS的IP>:/go/lanshare.new
```

NAS（SSH，root）：

```sh
cd /go
mv -f lanshare.new lanshare
chmod +x lanshare
file lanshare                        # ELF 64-bit ... x86-64
PID=$(pidof lanshare 2>/dev/null); [ -n "$PID" ] && kill $PID
sleep 1
./lanshare -no-tls -addr 127.0.0.1:8080 -trust-proxy    # 前台试跑，Ctrl+C 结束
```

另开一个 SSH 窗口验证（前台进程占用当前窗口）：

```sh
curl -i http://127.0.0.1:8080/health   # 200 + {"ok":true,"rooms":0,"peers":0}
```

`-addr 127.0.0.1:8080` 只监听回环，外部一律经 Nginx；`-trust-proxy` 让程序从 `X-Forwarded-For` 取真实客户端 IP。若 8080 已被其它套件占用，换成空闲端口并同步修改后文所有的 `proxy_pass`。

后台常驻 + 开机自启：把下面存成 `/go/start-lanshare.sh` 并 `chmod +x`，再在 DSM「控制面板 → 任务计划 → 新增 → 触发的任务 → 开机」以 root 运行：

```sh
#!/bin/sh
cd /go || exit 1
PID=$(pidof lanshare 2>/dev/null); [ -n "$PID" ] && kill $PID
sleep 1
nohup ./lanshare -no-tls -addr 127.0.0.1:8080 -trust-proxy >> lanshare.log 2>&1 &
```

跨网络（不同局域网）**不配 STUN/TURN 时直接由服务器 WS 中继聊天与文件**，配了 `LANSHARE_STUN_URLS` 则走 STUN 打洞，两者都不需要 coturn。只有想要标准 TURN 中继时才额外配置：

```sh
LANSHARE_TURN_SECRET='与 coturn 相同的密钥' \
LANSHARE_TURN_URLS='turn:域名:3478?transport=udp,turn:域名:3478?transport=tcp' \
nohup ./lanshare -no-tls -addr 127.0.0.1:8080 -trust-proxy >> lanshare.log 2>&1 &
```

#### 5.2 域名与证书

1. DSM「控制面板 → 安全性 → 证书」为域名申请 / 导入证书（Let's Encrypt 最省事）。
2. 路由器把公网 `443/tcp` 转发到 NAS，群晖防火墙一并放行。
3. 查证书实际路径：群晖放在带随机 ID 的目录里，**不要猜**：

```sh
# 若提示 nginx.conf.run 不存在（部分 DSM 版本），去掉 -c 参数改用 sudo nginx -T
sudo nginx -T -c /etc/nginx/nginx.conf.run 2>/dev/null | grep -m3 ssl_certificate
sudo ls /usr/syno/etc/certificate/_archive/
```

记下 `fullchain.pem` / `privkey.pem` 两个绝对路径，填进 5.3 的配置。

#### 5.3 写 Nginx 站点配置（推荐）

群晖的 `nginx.conf` 由 `/usr/syno/share/nginx/*.mustache` 模板生成，**手改 `/etc/nginx/nginx.conf` 或 UI 生成的 `server.ReverseProxy.conf` 会在重启 / DSM 升级后被覆盖**。正确做法是往模板预留的 include 目录里放自己的文件：

| 目录 | 文件名规则 | 用途 |
|---|---|---|
| `/etc/nginx/sites-enabled/` | 任意 `.conf` | 自己的 `server{}` 反代，首选 |
| `/etc/nginx/conf.d/` | 必须 `http.*.conf` | `map` / `upstream` 等 http 段全局指令 |
| `/etc/nginx/app.d/` | 必须 `server.*.conf` | DSM 套件专用，别碰 |

`/usr/local/etc/nginx/` 下的同名目录是软链，改哪边都一样。这些文件不受 UI 反代规则管理，**不会显示在 DSM 图形界面里**，但重启 / 升级不会丢。

先探测 `$connection_upgrade` 是否已全局定义（DSM 通常已定义；重复定义会让 `nginx -t` 报 duplicate）：

```sh
sudo nginx -T -c /etc/nginx/nginx.conf.run 2>/dev/null | grep -n 'map \$http_upgrade'
```

- 有输出 → 配置里直接用 `$connection_upgrade`，**不要再写 `map`**。
- 无输出 → 新建 `/etc/nginx/conf.d/http.lanshare.conf`（文件名必须匹配 `http.*.conf`）：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

再新建 `/etc/nginx/sites-enabled/lanshare.conf`（替换域名与证书路径）：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name share.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name share.example.com;

    ssl_certificate     /usr/syno/etc/certificate/_archive/<ID>/fullchain.pem;
    ssl_certificate_key /usr/syno/etc/certificate/_archive/<ID>/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # 业务数据走 WebRTC DataChannel，或默认无外部 ICE 时经本 WS 连接由服务端内存中继；
    # 服务端不接收 HTTP 文件上传、不落盘；WS 升级后不受 client_max_body_size 影响。
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # 关键 1：Host 必须与浏览器 Origin 的域名一致，否则 /ws 的 Origin 校验会拒绝
        proxy_set_header Host               $host;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 关键 2：用 $remote_addr 覆盖而非 $proxy_add_x_forwarded_for 追加，
        # 防止客户端伪造 XFF 骗取「同局域网」分组（-trust-proxy 依赖此值）
        proxy_set_header X-Forwarded-For   $remote_addr;

        # 关键 3：WebSocket（/ws）
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location = /health {
        proxy_pass http://127.0.0.1:8080/health;
        access_log off;
    }
}
```

校验并生效。DSM 7 实际运行的是 `nginx.conf.run`；**务必先 `-t` 再 reload**，配置写错会让 DSM 自己的 5000 端口也起不来：

```sh
sudo nginx -t -c /etc/nginx/nginx.conf.run                 # 若提示文件不存在，退回 sudo nginx -t
sudo nginx -s reload -c /etc/nginx/nginx.conf.run          # 或 sudo systemctl restart nginx
```

> 443 已被 DSM 占用时，多个 `server{}` 靠 `server_name` + SNI 共存是允许的。若访问仍被 DSM 页面接管，把「控制面板 → 登录门户 → DSM 网页服务」的 HTTPS 端口挪开，或让自己的 server 改监听非标端口（如 8443）并在路由器转发。

#### 5.4 只用 DSM 图形界面（快速验证，有限制）

控制面板 → 登录门户 → 高级设置 → 反向代理服务器 → 新增：

| 项 | 值 |
|---|---|
| 来源 | HTTPS / `share.example.com` / 443 |
| 目的地 | HTTP / `127.0.0.1` / 8080 |
| 自定义标头 | 新增 WebSocket，让 DSM 写入 `Upgrade` / `Connection` |

DSM 生成的规则里 `Host $http_host` 是对的，但 `X-Forwarded-For` 用的是 `$proxy_add_x_forwarded_for`（**追加**），客户端可伪造 XFF 影响「同网」判定，且 UI 无法改成 `$remote_addr` 覆盖。因此仅建议在可信内网试用；对外服务请用 5.3。UI 规则渲染到 `/etc/nginx/sites-enabled/server.ReverseProxy.conf`，**不要手改这个文件**。

#### 5.5 验收清单

```sh
curl -i http://127.0.0.1:8080/health          # 后端直连：200 + {"ok":true,...}
curl -i https://share.example.com/health      # 经 Nginx：200 + 同样的 JSON
```

1. 浏览器打开 `https://share.example.com`，首页正常、无证书告警；手机也走这个域名（WebRTC 需要 HTTPS，不要用 `http://NAS的IP:8080`）。
2. 开发者工具 → Network → WS：`/ws` 返回 `101 Switching Protocols`，连接保持。
3. 两台同网设备进同一房间互发文本 / 文件；跨网场景再用 4G 设备验证一次（默认不配 STUN/TURN，应自动切「中继」且文件仍可传；填了 `STUN_URLS` 则验证打洞链路）。
4. `lanshare.log` 里不应出现 `ws upgrade rejected ... origin not allowed` 或「必须加 -trust-proxy」警告。

完整通用示例见 [`deploy/nginx.conf.example`](deploy/nginx.conf.example)；群晖适配要点见该文件顶部注释。

---

## 证书与密钥分工

| 项目 | 谁负责 | 说明 |
|---|---|---|
| HTTPS 证书 / 私钥 | **Nginx** | 生产环境不进容器；`LANSHARE_NO_TLS=1` |
| `TURN_SECRET`（可选） | `.env` → 启用 `--profile turn` 时注入两个容器 | 只在启用标准 TURN 时需要；`lanshare` 用它签发 1 小时临时凭据，coturn 用它校验；前端只见临时凭据，永远看不到主密钥。默认无 coturn 部署留空即可 |
| 房间密码 | 用户 | 只做 `PBKDF2(password+salt)` 内存准入校验；内容加密用独立的随机会话密钥，密码仅用来「包装」该密钥，服务端两者都拿不到 |
| 自签证书 | `-export-cert` | **仅局域网试用**，生产不用 |

`deploy/turnserver.conf` 只用于裸机；Docker 版不读它，密钥不写死在任何会被提交的文件里。

### 反向代理的必配项

1. `LANSHARE_TRUST_PROXY=1`（或 `-trust-proxy`）：否则所有用户的出口 IP 都变成 `127.0.0.1`，**跨城市的用户会被误判为同一局域网并互相看到房间列表**。服务在非回环地址以 HTTP 启动且未开此项时会打印警告。
2. Nginx 必须设置 `proxy_set_header Host $host;`：WS 升级会校验 `Origin`，Host 与浏览器域名不一致会被拒绝。也支持 `X-Forwarded-Host`。
3. Nginx 必须设置 `proxy_set_header X-Forwarded-For $remote_addr;`（**覆盖**而非追加 `$proxy_add_x_forwarded_for`），避免客户端伪造 XFF 骗取同网分组。同时需要 `Upgrade` / `Connection` 头，`/ws` 才能升级。
4. 群晖 DSM 图形界面生成的反代规则默认用 `$proxy_add_x_forwarded_for`（追加），且 UI 不能改成覆盖；对外服务请按「5.3 写 Nginx 站点配置」自建 `server{}`。另外 DSM 通常已全局定义 `map $http_upgrade $connection_upgrade`，自己的配置里**不要重复定义**，否则 `nginx -t` 报 duplicate。

#### 反代排错：房间列表跨网互见（真实客户端 IP 被替换）

现象：外网（不同网络）的客户端能在房间列表里直接看到其它网络的房间，违反「列表仅显示同局域网」的预期。建房的日志 `scope=` 形如 `approx|172.20.0.1|?`（或某个 Docker 网桥 / 网关地址），而不是客户端的真实公网 IP。

根因：房间列表按 `scope = approx|<客户端公网IP>|<私网/24>` 分组（`room.go` 的 `scopeKey` / `sameScope`）。跨网能否区分完全取决于 `<客户端公网IP>` 是否真实。若 lanshare 拿到的全是代理 / 网关地址，所有客户端会塌进同一个 IP；再叠加外部客户端无私网段时 `lan="?"` 的通配符（`sameScope` 把 `lan=="?` 视为同组），就会全员互见。

拿到真实 IP 需要**两个条件同时成立**：① lanshare 带 `-trust-proxy`（否则内部退化用 `r.RemoteAddr` 即反代地址）；② 反代把真实客户端 IP 写进 `X-Forwarded-For`。

最常见的「条件 ② 不成立」正是 **Docker 端口发布（docker-proxy / userland-proxy）**：`netstat -tlnp | grep 443` 看到监听者是 `docker-proxy` 时，容器里 `$remote_addr` 是宿主机网桥地址（如 `172.20.0.1`），真实客户端 IP 在 docker-proxy 这一跳被替换。此时即便 Nginx 配了 `X-Forwarded-For $remote_addr`，写进去的也是网关地址；改成 `$proxy_add_x_forwarded_for` 也没用——链路里根本没有真实 IP。`172.20.0.1` 就是这么来的。

修复（纯部署，不动 lanshare 代码）：

- **方案 A（推荐）**：让 Nginx 容器用 `network_mode: host` 并去掉 `ports:` 映射。Nginx 直接绑在宿主机端口，`$remote_addr` 即真实客户端 IP；`proxy_pass` 仍指向 lanshare 监听地址（如 `http://172.20.0.1:6001`）。只重启 Nginx 容器即可。
- **方案 B**：关闭 Docker userland-proxy，让发布端口走内核 DNAT 保留真实源 IP。`/etc/docker/daemon.json` 加 `{"userland-proxy": false}` 后重启 Docker 守护进程；原有 bridge 配置不动。

验证：修复后用外网设备建一个房，`lanshare.log` 的 `scope=` 应变成 `approx|<真实公网IP>|?`；不同 4G 网络的设备应**互不可见**（只能凭房间号加入）。仍未拿到真实 IP 时，先 `ps` 确认运行中的进程确实带 `-trust-proxy`，再用 `nginx -T` 确认实际加载的配置含 `X-Forwarded-For`，最后看 `scope=` 落在哪个 IP。

完整示例见 `deploy/nginx.conf.example`（默认 8080）；自定义端口的裸机完整示例见 4.1，群晖完整流程见第 5 节。

---

## 主要参数

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `-addr` | `LANSHARE_ADDR` | `:8443` | 监听地址 |
| `-no-tls` | `LANSHARE_NO_TLS=1` | 关 | 关闭 TLS（Nginx 反代提供 HTTPS，或 localhost 开发） |
| `-cert` / `-key` | `LANSHARE_CERT` / `LANSHARE_KEY` | 空 | 正式证书；为空则自动生成内存自签证书 |
| `-export-cert` | `LANSHARE_EXPORT_CERT` | 空 | 导出自签证书前缀，生成 `<前缀>.crt/.key` |
| `-turn-secret` | `LANSHARE_TURN_SECRET` | 空 | 可选 coturn 的 `static-auth-secret`；为空则不下发 TURN（无 coturn 部署保持为空） |
| `-turn-urls` | `LANSHARE_TURN_URLS` | 空 | 逗号分隔的 TURN URL；为空时不下发 TURN |
| `-stun-urls` | `LANSHARE_STUN_URLS` | **空** | 逗号分隔的 STUN URL；**与 `-turn-urls` 都为空时服务端下发 `noIceServers=true`，前端直接走服务器 WS 中继**（内网仍优先 host 直连） |
| `-trust-proxy` | `LANSHARE_TRUST_PROXY=1` | 关 | **仅在有可信反代时开启** |
| `-max-rooms` / `-max-members` | — | 200 / 10 | 房间数 / 单房人数 |
| `-turn-ttl` | — | 3600 | TURN 临时凭据有效期（秒） |
| `-relay-rate` | `LANSHARE_RELAY_RATE_MB` | `0` | 每连接 WS 数据中继带宽上限（MB/s）；**0 = 不限速**，compose 用 `.env` 的 `RELAY_RATE_MB` |

> 环境变量是各 flag 的默认值来源：显式传入的命令行 flag 优先于环境变量。裸机自定义端口的完整写法见 4.1。

---

## 常见日志与报错

| 日志 | 含义 | 处理 |
|---|---|---|
| `http: TLS handshake error from [::1]:xxxxx: remote error: tls: unknown certificate` | **客户端（浏览器）不信任自签证书而主动断开**，不是服务端故障。常见来源：`localhost` 上页面已点「继续访问」但 WS / 子资源连接仍被拒 | 生产改用 Nginx 正式证书；局域网试用请安装并信任导出的 `.crt`。自签模式下这类预期噪音已被静默 |
| `scope=approx\|::1\|?` | 经 `localhost`(IPv6) 访问时出口 IP 是 `::1`，且浏览器未上报私网段，因此是「推测同网 + 未知网段」 | 本机测试正常；真实设备会拿到实际出口 IP。绑定「网络标识」可精确分组 |
| `警告：HTTP 模式若位于 Nginx 等反向代理之后，必须加 -trust-proxy` | 反代模式下未开 `trust-proxy` | 见上节「必配项 1」 |
| `ws upgrade rejected ... origin not allowed` | Nginx 没把 `Host` 传给后端，或浏览器域名与 `Host` 不一致 | 见上节「必配项 2」 |
| `bash lanshare` / `sh lanshare` → `cannot execute binary file` | 把 ELF 二进制当 shell 脚本执行了 | `chmod +x lanshare` 后直接 `./lanshare ...`；若仍失败用 `file` 确认不是 Windows PE / 架构不符 |
| `Text file busy`（覆盖或启动时） | 旧 `lanshare` 进程仍在运行 | `PID=$(pidof lanshare); [ -n "$PID" ] && kill $PID`，再 `sleep 1` 后替换 / 启动 |
| `nginx: [emerg] duplicate "connection_upgrade" variable` | 群晖已全局定义该 `map`，自己的配置里又写了一遍 | 删掉自建文件里的 `map`，直接复用 `$connection_upgrade`；见 5.3 |
| `nginx -t` 通过但配置不生效 | 配置文件名没匹配 include 规则，或改到了会被模板覆盖的文件 | `conf.d/` 下必须是 `http.*.conf`；`server{}` 放 `sites-enabled/`；DSM 7 用 `-c /etc/nginx/nginx.conf.run` 校验 |

---

## 使用

1. 打开首页自动列出「同网络房间」。默认是**推测同网**（出口 IP + 私网 /24），可能有误判；点右上角胶囊绑定一个「网络标识」，同网设备填同一个标识即可精确归组。
2. 首页只有**一个入口**：输入 6 位房间号，已存在就直接加入、不存在就按该号码新建；留空则随机新建。密码留空 = 公开，填密码 = 私有。私有房内容端到端加密；公开房跳过应用层二次加密、由 WebRTC 的 DTLS 保护链路，以换取更高吞吐。会话密钥由创建者随机生成、全生命周期不变。
3. 跨网络的朋友用房间页「分享链接」按钮：手机扫二维码或复制 `…#rid=XXXXXX&pwd=…` 链接即可自动加入（房间号与密码放在 fragment，不经过服务端）。跨网房间不会出现在任何人的列表里。
4. 文件发送后只广播一张卡片，**接收方点「接收」才开始传输**。按房间人数自动选传输模式：
   - **两人 = 直连快传**：不切片、不做分片位图/多源分工，一次订阅后把文件当连续字节流推完；按 SCTP 单消息上限（最大 1MB）分帧、每 4MB 落一次盘，用无序可靠通道 + 2MB 水位（三人及以上分片模式为 8MB）+ 双缓冲预读跑满单连接。
   - **三人及以上 = P2P 分片**：128KB 分片、最多 4 源取模分工并行取片，下载完成者自动成为新的供种源，支持边下边传。
   
   两种模式都是流式推送（无逐片往返），卡片显示实时/峰值速率、模式、源数与已续传量。可用同网 HTTP 大文件下载作为链路基线对照。
5. **断点续传**：进度（分片位图或直传 offset）存在 IndexedDB，正常传输每秒写一次、每 4MB 段立即写、切后台/息屏/断线立即写。手机息屏断链或页面被重载后，WS 重连会按 `sessionStorage` 里的房间号自动重进房，之前的下载自动接着传，无需再点「接收」；传输期间会申请 Wake Lock 阻止自动息屏（需 HTTPS）。**注意**：分享方选中的 `File` 对象无法跨页面恢复，若分享端页面被系统重载仍需重新选文件；接收端已收数据不会丢。
6. 移动端默认仅 WiFi 供种，房间页底部可放开「允许移动流量供种」（与链路信息、右下角版权同一行）。
7. 首次打开自动获得一个随机昵称（如「蓝色云朵FC」）并保存在本机；首页昵称框或房间页「我：…」按钮可随时改名，房间内重名会自动追加序号。
8. 房主可点「房间密码」**添加 / 修改 / 移除密码**：只影响之后加入的人，已连接成员不会被踢、不用重输密码、聊天不中断；成员列表里的「踢出」可移出指定成员（需二次确认）。
9. 消息区独立滚动，底部输入框固定；输入框默认 5 行高，随内容自动增高，超过屏幕 2/3 后内部出现滚动条。右侧「文件」「发送」两枚按钮各占一半高度并随输入框同步伸缩。Enter 发送、Shift+Enter 换行。

## 端口

| 组件 | 端口 |
|---|---|
| Nginx | 443 tcp（对外 HTTPS/WSS） |
| `lanshare` | 8080 tcp（反代后端；compose 默认映射 `"8080:8080"`，生产建议限制为回环）/ 8443 tcp（自签直连） |
| WS 完整中继 | **复用上面的 443 tcp，无新增端口** |
| `coturn`（可选） | 3478 udp+tcp |
| `coturn` 中继（可选） | 裸机 49152–65535 udp / Docker 40000–40200 udp |

## 验证

```bash
go build ./... && go vet ./...
docker compose --env-file .env.example config --quiet   # 校验配置，无需拉取镜像

# 交叉编译产物（群晖 x86_64）；以下 grep 命令在 Linux / macOS / WSL 执行，
# PowerShell 用 go version -m lanshare | Select-String 'GOOS|GOARCH|CGO_ENABLED'
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o lanshare .
go version -m lanshare | grep -E 'GOOS|GOARCH|CGO_ENABLED'
grep -a -c 'chat_part' lanshare    # >0 说明最新前端已 go:embed 进去

curl https://<host>/health       # {"ok":true,"rooms":0,"peers":0}
```

真机验证建议按 `docs/开发文档.md` 第 11 节的 P1–P5 清单逐项做；跨网场景分别验证「默认 STUN/TURN 留空，4G 设备自动走服务器中继并传完一个文件」「填 `STUN_URLS` 后经打洞直连」「启用 `--profile turn` 后走标准 TURN 中继」三条路径。

## 已知限制

- 浏览器无法 UDP 广播 / 获取 SSID，"同 LAN 自动发现"只能是推测；绑定网络标识可消除误判。
- 历史只存在于在线设备内存，最后一人离线即消失；历史文件只有卡片元数据，本体需在线设备仍持有。接收端已下载的分片/段存在本机 IndexedDB，可断点续传；分享端的 `File` 对象无法跨页面恢复。
- 对称 NAT 且无 TURN 时会切到服务器 WS 中继，聊天与文件都可用；服务端默认不限速，但上下行都吃服务器带宽，速度仍取决于实际链路，通常慢于 P2P。接收端拥塞时服务端会下发 `relay_pause` 让发送方短暂降速，缺片由文件层重传补齐。
- Wake Lock 需要 HTTPS/localhost 且浏览器支持；系统仍可能挂起后台页面，此时靠进度落盘 + 自动重进房续传。iOS Safari 后台标签页会限流 WebRTC。
- 1200M/2400M 是 WiFi 协商速率，不是实际吞吐；两台无线终端经同一 AP 互传要占两次空口，单条 SCTP 流也受拥塞窗口限制，无法保证打满物理带宽。
- Docker Desktop（Windows/macOS）若要改用 `network_mode: host`，需先开启 host networking；只有启用 `turn` profile 时的 UDP 端口范围映射才用得上该特性，默认部署不涉及。

详见开发文档第 9、10 节。
