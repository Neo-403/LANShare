package main

//go:generate go run ./tools/mkicon

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/json"
	"encoding/pem"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed all:web
var webAssets embed.FS

func main() {
	cfg := loadConfig()
	hub := newHub(cfg)

	static, err := fs.Sub(webAssets, "web")
	if err != nil {
		log.Fatal(err)
	}
	files := http.FileServer(http.FS(static))

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWS(hub, w, r)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		hub.mu.Lock()
		rooms, peers := len(hub.rooms), len(hub.clients)
		hub.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "rooms": rooms, "peers": peers,
		})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		files.ServeHTTP(w, r)
	})

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	if cfg.NoTLS {
		if !cfg.TrustProxy && !isLoopbackBind(cfg.Addr) {
			log.Printf("警告：HTTP 模式若位于 Nginx 等反向代理之后，必须加 -trust-proxy（或 LANSHARE_TRUST_PROXY=1），否则所有用户会被判定为同一局域网")
		}
		log.Printf("LANShare listening on %s (HTTP；对外 HTTPS/WSS 由反向代理提供)", listenURL("http", cfg.Addr))
		log.Fatal(srv.ListenAndServe())
	}

	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.SelfSigned {
		cert, e := selfSignedCert()
		if e != nil {
			log.Fatal(e)
		}
		tlsCfg.Certificates = []tls.Certificate{cert}
		// 自签证书必然被未信任它的浏览器拒绝，这类握手告警是预期噪音，不刷屏。
		srv.ErrorLog = log.New(tlsErrorFilter{}, "", log.LstdFlags)
		log.Printf("使用内存自签证书（手机需手动信任）；生产建议由 Nginx 反代并提供正式证书")
		if cfg.ExportCert != "" {
			if e := exportCert(cert, cfg.ExportCert); e != nil {
				log.Fatal(e)
			}
			log.Printf("证书已导出：%s.crt / %s.key", cfg.ExportCert, cfg.ExportCert)
		}
		ln, e := net.Listen("tcp", cfg.Addr)
		if e != nil {
			log.Fatal(e)
		}
		log.Printf("LANShare listening on %s", listenURL("https", cfg.Addr))
		if lan := lanURLs(cfg.Addr); lan != "" {
			log.Printf("局域网设备请访问：%s（需先信任导出的证书）", lan)
		}
		log.Printf("提示：浏览器未信任证书时的 TLS 握手拒绝已静默；安装 .crt 后即不再出现")
		log.Fatal(srv.Serve(tls.NewListener(ln, tlsCfg)))
	}
	log.Printf("LANShare listening on %s", listenURL("https", cfg.Addr))
	log.Fatal(srv.ListenAndServeTLS(cfg.CertFile, cfg.KeyFile))
}

// tlsErrorFilter 静默「客户端不信任自签证书」造成的握手告警，其余服务端错误照常输出。
type tlsErrorFilter struct{}

func (tlsErrorFilter) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte("TLS handshake error")) && bytes.Contains(p, []byte("certificate")) {
		return len(p), nil
	}
	return os.Stderr.Write(p)
}

// listenURL 把 ":8443" 这类监听地址转成可直接点击的 URL。
func listenURL(scheme, addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return scheme + "://" + addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "localhost"
	}
	return scheme + "://" + net.JoinHostPort(host, port)
}

func isLoopbackBind(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		return false
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// lanURLs 列出最多 4 个本机私网 IPv4 地址，方便手机直接访问。
func lanURLs(addr string) string {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return ""
	}
	seen := map[string]bool{}
	var out []string
	ifaces, _ := net.Interfaces()
	for _, i := range ifaces {
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.To4() == nil || !ip.IsPrivate() {
				continue
			}
			u := "https://" + net.JoinHostPort(ip.String(), port)
			if seen[u] {
				continue
			}
			seen[u] = true
			out = append(out, u)
			if len(out) >= 4 {
				return strings.Join(out, "  ")
			}
		}
	}
	return strings.Join(out, "  ")
}

// selfSignedCert 生成含 localhost 与本机所有私网 IP 的内存证书，零文件即可起 HTTPS。
func selfSignedCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	ips := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	ifaces, _ := net.Interfaces()
	for _, i := range ifaces {
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip != nil && !ip.IsLoopback() {
				ips = append(ips, ip)
			}
		}
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "LANShare", Organization: []string{"LANShare"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return tls.X509KeyPair(certPEM, keyPEM)
}

// exportCert 让手机可以安装并信任同一张证书，也可用 -cert/-key 固定复用。
func exportCert(cert tls.Certificate, base string) error {
	if dir := filepath.Dir(base); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]})
	keyDER, err := x509.MarshalECPrivateKey(cert.PrivateKey.(*ecdsa.PrivateKey))
	if err != nil {
		return err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(base+".crt", certPEM, 0644); err != nil {
		return err
	}
	return os.WriteFile(base+".key", keyPEM, 0600)
}
