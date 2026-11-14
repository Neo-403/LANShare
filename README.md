# LANShare

浏览器打开即用的局域网 / 跨网络分享工具：房间制、文本与文件、内网直连优先、外网打洞、TURN 兜底。两人时走连续流直传，多人时启用多源 P2P 分片；支持断点续传与息屏保护，服务器不保存聊天记录与文件。

完整设计与协议见 [`docs/开发文档.md`](docs/开发文档.md)。

## 构建

```bash
go build -o lanshare.exe .        # Windows
# go build -o lanshare .          # Linux / macOS
```

零第三方依赖，编译产物只有一个可执行文件（静态页面已 `go:embed` 内置）。

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

| 触发 | 二进制 artifact | GitHub Release | 镜像标签 |
|---|---|---|---|
| `push` tag `v*` | ✅ | ✅ 附带全部平台二进制 + `SHA256SUMS.txt` | `1.2.3` / `1.2` / `latest` |
| `push` `main` | ✅ | — | `main` / `sha-xxxxxxx` |
| 手动运行 workflow | ✅ | 填 `version` 才创建 | 可勾选 `push_latest` |

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

自动构建的版本号来自 git tag：**必须 `v` 开头且符合语义化版本**（`vMAJOR.MINOR.PATCH`）。推送 tag 会同时触发 Release 与镜像构建。

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

**手动运行 workflow 的区别**：`workflow_dispatch` 的 `version` 输入只用于创建名为该值的 Release（`tag_name`），**镜像拿不到版本号标签** —— `type=semver` 只认 tag 事件，手动运行时镜像仅有 `main` / `sha-xxxxxxx`（勾 `push_latest` 会多一个 `latest`）。要让镜像带版本号必须走 git tag。

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

**这是证书由 Nginx 提供时的标准形态**：容器内 `lanshare` 跑纯 HTTP，TLS 在 Nginx 终止，coturn 随 compose 一起启动。

```bash
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
# 编辑 .env：PUBLIC_HOST=你的域名、TURN_SECRET=随机密钥、TURN_EXTERNAL_IP（NAT 后必填）
openssl rand -hex 24          # 生成 TURN_SECRET

docker compose up -d --build         # 若提示 unknown command，改用 docker-compose up -d --build
curl http://127.0.0.1:8080/health     # {"ok":true,"rooms":0,"peers":0}
```

> 若拉取镜像超时请配置镜像加速；若 `golang:1.27-alpine` 或 `coturn/coturn:4.6.2` 标签不可用，可分别改成 `golang:alpine`、`coturn/coturn:latest`（版本锁定会变弱）。校验 compose 配置无需拉取镜像：本机用的是独立 CLI `docker-compose --env-file .env.example config --quiet`。

然后把 `deploy/nginx.conf.example` 复制到 Nginx 站点配置，替换域名与证书路径，`nginx -t && nginx -s reload`。浏览器访问 `https://<PUBLIC_HOST>`。

compose 内置两个服务：

| 服务 | 作用 | 端口 |
|---|---|---|
| `lanshare` | 页面 + WS 信令（HTTP） | `127.0.0.1:8080`，仅本机可达 |
| `coturn` | STUN 打洞 + TURN 中继 | `3478 udp/tcp`、`40000-40200 udp` |

防火墙 / 安全组需放行：`443 tcp`（Nginx）、`3478 udp+tcp`、`40000-40200 udp`。

### 4. 裸机部署（不用 Docker）

```bash
# 进程 1：改好 deploy/turnserver.conf 里的 static-auth-secret 与 external-ip
turnserver -c deploy/turnserver.conf

# 进程 2：Nginx 反代场景（对外 HTTPS 由 Nginx 提供）
LANSHARE_TURN_SECRET=<同一个密钥> \
LANSHARE_TURN_URLS='turn:share.example.com:3478?transport=udp,turn:share.example.com:3478?transport=tcp' \
./lanshare -no-tls -addr 127.0.0.1:8080 -trust-proxy
```

若不用反代、直接由程序持有正式证书：`./lanshare -addr :443 -cert fullchain.pem -key privkey.pem`。

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

跨网络（不同局域网）才需要 coturn 与临时凭据；同局域网可跳过：

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

    # 业务数据只走 WebRTC / TURN，服务端不接收文件上传
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
3. 两台同网设备进同一房间互发文本 / 文件；跨网场景再用 4G 设备验证一次（需要 coturn）。
4. `lanshare.log` 里不应出现 `ws upgrade rejected ... origin not allowed` 或「必须加 -trust-proxy」警告。

完整通用示例见 [`deploy/nginx.conf.example`](deploy/nginx.conf.example)；群晖适配要点见该文件顶部注释。

---

## 证书与密钥分工

| 项目 | 谁负责 | 说明 |
|---|---|---|
| HTTPS 证书 / 私钥 | **Nginx** | 生产环境不进容器；`LANSHARE_NO_TLS=1` |
| `TURN_SECRET` | `.env` → 同时注入两个容器 | 唯一需要保密的值，`lanshare` 用它签发 1 小时临时凭据，coturn 用它校验；前端只见临时凭据，永远看不到主密钥 |
| 房间密码 | 用户 | 只做 `PBKDF2(password+salt)` 内存准入校验；内容加密用独立的随机会话密钥，密码仅用来「包装」该密钥，服务端两者都拿不到 |
| 自签证书 | `-export-cert` | **仅局域网试用**，生产不用 |

`deploy/turnserver.conf` 只用于裸机；Docker 版不读它，密钥不写死在任何会被提交的文件里。

### 反向代理的必配项

1. `LANSHARE_TRUST_PROXY=1`（或 `-trust-proxy`）：否则所有用户的出口 IP 都变成 `127.0.0.1`，**跨城市的用户会被误判为同一局域网并互相看到房间列表**。服务在非回环地址以 HTTP 启动且未开此项时会打印警告。
2. Nginx 必须设置 `proxy_set_header Host $host;`：WS 升级会校验 `Origin`，Host 与浏览器域名不一致会被拒绝。也支持 `X-Forwarded-Host`。
3. Nginx 必须设置 `proxy_set_header X-Forwarded-For $remote_addr;`（**覆盖**而非追加 `$proxy_add_x_forwarded_for`），避免客户端伪造 XFF 骗取同网分组。同时需要 `Upgrade` / `Connection` 头，`/ws` 才能升级。
4. 群晖 DSM 图形界面生成的反代规则默认用 `$proxy_add_x_forwarded_for`（追加），且 UI 不能改成覆盖；对外服务请按「5.3 写 Nginx 站点配置」自建 `server{}`。另外 DSM 通常已全局定义 `map $http_upgrade $connection_upgrade`，自己的配置里**不要重复定义**，否则 `nginx -t` 报 duplicate。

完整示例见 `deploy/nginx.conf.example`；群晖完整流程见第 5 节。

---

## 主要参数

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `-addr` | `LANSHARE_ADDR` | `:8443` | 监听地址 |
| `-no-tls` | `LANSHARE_NO_TLS=1` | 关 | 关闭 TLS（Nginx 反代提供 HTTPS，或 localhost 开发） |
| `-cert` / `-key` | `LANSHARE_CERT` / `LANSHARE_KEY` | 空 | 正式证书；为空则自动生成内存自签证书 |
| `-export-cert` | `LANSHARE_EXPORT_CERT` | 空 | 导出自签证书前缀，生成 `<前缀>.crt/.key` |
| `-turn-secret` | `LANSHARE_TURN_SECRET` | 空 | coturn `static-auth-secret`，为空则不下发 TURN |
| `-turn-urls` | `LANSHARE_TURN_URLS` | 空 | 逗号分隔的 TURN URL；**为空时不下发 TURN**，只走 STUN 打洞 |
| `-stun-urls` | `LANSHARE_STUN_URLS` | 公共 Google STUN | 逗号分隔；compose 中同时加入自建 coturn 的 STUN |
| `-trust-proxy` | `LANSHARE_TRUST_PROXY=1` | 关 | **仅在有可信反代时开启** |
| `-max-rooms` / `-max-members` | — | 200 / 10 | 房间数 / 单房人数 |
| `-turn-ttl` | — | 3600 | TURN 临时凭据有效期（秒） |

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
   - **两人 = 直连快传**：不切片、不做分片位图/多源分工，一次订阅后把文件当连续字节流推完；按 SCTP 单消息上限（最大 1MB）分帧、每 4MB 落一次盘，用无序可靠通道 + 8MB 水位 + 双缓冲预读跑满单连接。
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
| `lanshare` | 8080 tcp（反代后端）/ 8443 tcp（自签直连） |
| `coturn` | 3478 udp+tcp |
| `coturn` 中继 | 裸机 49152–65535 udp / Docker 40000–40200 udp |

## 验证

```bash
go build ./... && go vet ./...
docker-compose --env-file .env.example config --quiet   # 或用 docker compose config --quiet

# 交叉编译产物（群晖 x86_64）；以下 grep 命令在 Linux / macOS / WSL 执行，
# PowerShell 用 go version -m lanshare | Select-String 'GOOS|GOARCH|CGO_ENABLED'
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o lanshare .
go version -m lanshare | grep -E 'GOOS|GOARCH|CGO_ENABLED'
grep -a -c 'chat_part' lanshare    # >0 说明最新前端已 go:embed 进去

curl https://<host>/health       # {"ok":true,"rooms":0,"peers":0}
```

真机验证建议按 `docs/开发文档.md` 第 11 节的 P1–P5 清单逐项做；跨网场景务必再验证一次 4G 设备经 TURN 加入。

## 已知限制

- 浏览器无法 UDP 广播 / 获取 SSID，"同 LAN 自动发现"只能是推测；绑定网络标识可消除误判。
- 历史只存在于在线设备内存，最后一人离线即消失；历史文件只有卡片元数据，本体需在线设备仍持有。接收端已下载的分片/段存在本机 IndexedDB，可断点续传；分享端的 `File` 对象无法跨页面恢复。
- 对称 NAT 且 TURN 不可用时只剩 WS 兜底，仅保证文本可用。
- Wake Lock 需要 HTTPS/localhost 且浏览器支持；系统仍可能挂起后台页面，此时靠进度落盘 + 自动重进房续传。iOS Safari 后台标签页会限流 WebRTC。
- 1200M/2400M 是 WiFi 协商速率，不是实际吞吐；两台无线终端经同一 AP 互传要占两次空口，单条 SCTP 流也受拥塞窗口限制，无法保证打满物理带宽。
- Docker Desktop（Windows/macOS）若要改用 `network_mode: host`，需先开启 host networking；默认端口范围映射无需该特性。

详见开发文档第 9、10 节。
