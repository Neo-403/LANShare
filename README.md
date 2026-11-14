# LANShare

浏览器打开即用的局域网 / 跨网络分享工具：房间制、文本与文件、内网直连优先、外网打洞、TURN 兜底。两人时走连续流直传，多人时启用多源 P2P 分片；支持断点续传与息屏保护，服务器不保存聊天记录与文件。

完整设计与协议见 [`docs/开发文档.md`](docs/开发文档.md)。

## 构建

```bash
go build -o lanshare.exe .        # Windows
# go build -o lanshare .          # Linux / macOS
```

零第三方依赖，编译产物只有一个可执行文件（静态页面已 `go:embed` 内置）。

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

---

## 证书与密钥分工

| 项目 | 谁负责 | 说明 |
|---|---|---|
| HTTPS 证书 / 私钥 | **Nginx** | 生产环境不进容器；`LANSHARE_NO_TLS=1` |
| `TURN_SECRET` | `.env` → 同时注入两个容器 | 唯一需要保密的值，`lanshare` 用它签发 1 小时临时凭据，coturn 用它校验；前端只见临时凭据，永远看不到主密钥 |
| 房间密码 | 用户 | 只做 `PBKDF2(password+salt)` 内存准入校验；内容加密用独立的随机会话密钥，密码仅用来「包装」该密钥，服务端两者都拿不到 |
| 自签证书 | `-export-cert` | **仅局域网试用**，生产不用 |

`deploy/turnserver.conf` 只用于裸机；Docker 版不读它，密钥不写死在任何会被提交的文件里。

### 反向代理的三个必配项

1. `LANSHARE_TRUST_PROXY=1`（或 `-trust-proxy`）：否则所有用户的出口 IP 都变成 `127.0.0.1`，**跨城市的用户会被误判为同一局域网并互相看到房间列表**。服务在非回环地址以 HTTP 启动且未开此项时会打印警告。
2. Nginx 必须设置 `proxy_set_header Host $host;`：WS 升级会校验 `Origin`，Host 与浏览器域名不一致会被拒绝。也支持 `X-Forwarded-Host`。
3. Nginx 必须设置 `proxy_set_header X-Forwarded-For $remote_addr;`（**覆盖**而非追加 `$proxy_add_x_forwarded_for`），避免客户端伪造 XFF 骗取同网分组。同时需要 `Upgrade` / `Connection` 头，`/ws` 才能升级。

完整示例见 `deploy/nginx.conf.example`。

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
