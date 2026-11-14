package main

import (
	"flag"
	"os"
	"strings"
)

// Config 是服务端的全部运行时配置，均可通过 flag 或 LANSHARE_* 环境变量覆盖。
type Config struct {
	Addr       string
	NoTLS      bool
	SelfSigned bool
	CertFile   string
	KeyFile    string
	ExportCert string // 把内存自签证书导出为 <prefix>.crt/.key，便于手机信任与固定复用

	TurnSecret string
	TurnURLs   []string
	StunURLs   []string
	TurnTTL    int64
	TrustProxy bool

	MaxRooms   int
	MaxMembers int
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func splitURLs(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func loadConfig() Config {
	c := Config{}
	flag.StringVar(&c.Addr, "addr", env("LANSHARE_ADDR", ":8443"), "HTTPS/HTTP 监听地址")
	flag.BoolVar(&c.NoTLS, "no-tls", env("LANSHARE_NO_TLS", "") == "1", "关闭 TLS（Nginx 反代提供 HTTPS，或 localhost 开发）")
	flag.StringVar(&c.CertFile, "cert", env("LANSHARE_CERT", ""), "证书 PEM 文件")
	flag.StringVar(&c.KeyFile, "key", env("LANSHARE_KEY", ""), "私钥 PEM 文件")
	flag.StringVar(&c.ExportCert, "export-cert", env("LANSHARE_EXPORT_CERT", ""), "导出自签证书的前缀（生成 <prefix>.crt / .key）")
	flag.StringVar(&c.TurnSecret, "turn-secret", env("LANSHARE_TURN_SECRET", ""), "coturn static-auth-secret")
	flag.StringVar(&turnURLsRaw, "turn-urls", env("LANSHARE_TURN_URLS", ""), "逗号分隔的 TURN URLs")
	flag.StringVar(&stunURLsRaw, "stun-urls", env("LANSHARE_STUN_URLS", "stun:stun.l.google.com:19302"), "逗号分隔的 STUN URLs")
	flag.BoolVar(&c.TrustProxy, "trust-proxy", env("LANSHARE_TRUST_PROXY", "") == "1", "信任 X-Forwarded-For（仅在有反向代理时开启）")
	flag.IntVar(&c.MaxRooms, "max-rooms", 200, "房间总数上限")
	flag.IntVar(&c.MaxMembers, "max-members", 10, "单房间人数上限")
	flag.Int64Var(&c.TurnTTL, "turn-ttl", 3600, "TURN 临时凭据有效期（秒）")
	flag.Parse()

	c.TurnURLs = splitURLs(turnURLsRaw)
	c.StunURLs = splitURLs(stunURLsRaw)
	if !c.NoTLS && (c.CertFile == "" || c.KeyFile == "") {
		c.SelfSigned = true // 未配置证书时自动生成内存自签证书，方便局域网试用
	}
	return c
}

var turnURLsRaw, stunURLsRaw string

// ICEConfig 下发给浏览器。
func (c Config) ICEConfig(turnUser, turnCred string) map[string]any {
	servers := make([]map[string]any, 0, len(c.StunURLs)+len(c.TurnURLs))
	for _, u := range c.StunURLs {
		servers = append(servers, map[string]any{"urls": u})
	}
	// 只下发展明确配置过的 TURN URL；绝不下发指向客户端自身 localhost 的无效配置。
	if c.TurnSecret != "" && turnUser != "" && len(c.TurnURLs) > 0 {
		servers = append(servers, map[string]any{
			"urls":       c.TurnURLs,
			"username":   turnUser,
			"credential": turnCred,
		})
	}
	return map[string]any{"iceServers": servers}
}
