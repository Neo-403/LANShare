package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	wsGUID        = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	wsMaxMessage  = 1 << 20
	wsReadTimeout = 60 * time.Second
	wsPingEvery   = 25 * time.Second

	opContinue = 0x0
	opText     = 0x1
	opBinary   = 0x2
	opClose    = 0x8
	opPing     = 0x9
	opPong     = 0xA
)

var errWSClosed = errors.New("websocket closed")

// WS 是一个最小 RFC6455 服务端连接，只依赖标准库。
type WS struct {
	conn net.Conn
	rw   *bufio.ReadWriter
	wmu  sync.Mutex
}

func upgrade(w http.ResponseWriter, r *http.Request, trustProxy bool) (*WS, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		return nil, errors.New("not a websocket upgrade")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, errors.New("unsupported websocket version")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	raw, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(raw) != 16 {
		return nil, errors.New("invalid Sec-WebSocket-Key")
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, e := url.Parse(origin)
		if e != nil {
			return nil, errors.New("origin not allowed")
		}
		// 反代后 r.Host 常是后端地址（lanshare:8080），此时用 X-Forwarded-Host 校验外部域名。
		hosts := []string{hostOnly(r.Host)}
		if trustProxy {
			if x := r.Header.Get("X-Forwarded-Host"); x != "" {
				hosts = append(hosts, hostOnly(strings.TrimSpace(strings.Split(x, ",")[0])))
			}
		}
		allowed := false
		for _, h := range hosts {
			if strings.EqualFold(u.Hostname(), h) {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil, errors.New("origin not allowed")
		}
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("hijack not supported")
	}
	conn, buf, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])
	_, err = fmt.Fprintf(buf,
		"HTTP/1.1 101 Switching Protocols\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: Upgrade\r\n"+
			"Sec-WebSocket-Accept: %s\r\n\r\n", accept)
	if err != nil || buf.Flush() != nil {
		_ = conn.Close()
		return nil, errors.New("handshake write failed")
	}
	return &WS{conn: conn, rw: buf}, nil
}

func hostOnly(h string) string {
	if strings.HasPrefix(h, "[") {
		if i := strings.IndexByte(h, ']'); i >= 0 {
			return strings.Trim(h[:i], "[]")
		}
		return h
	}
	if i := strings.LastIndexByte(h, ':'); i >= 0 {
		return h[:i]
	}
	return h
}

func (s *WS) RemoteAddr() net.Addr { return s.conn.RemoteAddr() }

func (s *WS) Close() error { return s.conn.Close() }

func (s *WS) readFrame() (bool, byte, []byte, error) {
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(s.rw, hdr); err != nil {
		return false, 0, nil, err
	}
	fin := hdr[0]&0x80 != 0
	op := hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	n := uint64(hdr[1] & 0x7f)
	switch n {
	case 126:
		b := make([]byte, 2)
		if _, err := io.ReadFull(s.rw, b); err != nil {
			return false, 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(b))
	case 127:
		b := make([]byte, 8)
		if _, err := io.ReadFull(s.rw, b); err != nil {
			return false, 0, nil, err
		}
		n = binary.BigEndian.Uint64(b)
		if n&(1<<63) != 0 {
			return false, 0, nil, errors.New("invalid frame length")
		}
	}
	if n > wsMaxMessage {
		return false, 0, nil, errors.New("frame too large")
	}
	if op >= 0x8 && (!fin || n > 125) {
		return false, 0, nil, errors.New("invalid control frame")
	}
	if !masked {
		return false, 0, nil, errors.New("client frame must be masked")
	}
	mask := make([]byte, 4)
	if _, err := io.ReadFull(s.rw, mask); err != nil {
		return false, 0, nil, err
	}
	payload := make([]byte, int(n))
	if _, err := io.ReadFull(s.rw, payload); err != nil {
		return false, 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return fin, op, payload, nil
}

// ReadMessage 返回一条完整消息（自动处理分片、ping/pong、close 与读超时）。
func (s *WS) ReadMessage() (byte, []byte, error) {
	var opcode byte
	var buf []byte
	for {
		_ = s.conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
		fin, op, payload, err := s.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case opPing:
			if err := s.WriteFrame(opPong, payload); err != nil {
				return 0, nil, err
			}
			continue
		case opPong:
			continue
		case opClose:
			_ = s.WriteFrame(opClose, nil)
			return 0, nil, errWSClosed
		case opText, opBinary:
			if opcode != 0 {
				return 0, nil, errors.New("unexpected new data frame")
			}
			opcode = op
		case opContinue:
			if opcode == 0 {
				return 0, nil, errors.New("unexpected continuation frame")
			}
		default:
			return 0, nil, errors.New("unknown opcode")
		}
		buf = append(buf, payload...)
		if len(buf) > wsMaxMessage {
			return 0, nil, errors.New("message too large")
		}
		if fin {
			if opcode == opText && !utf8.Valid(buf) {
				return 0, nil, errors.New("invalid utf8 text frame")
			}
			return opcode, buf, nil
		}
	}
}

func (s *WS) WriteFrame(op byte, payload []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	hdr := make([]byte, 0, 10)
	hdr = append(hdr, 0x80|op)
	switch n := len(payload); {
	case n < 126:
		hdr = append(hdr, byte(n))
	case n <= 65535:
		hdr = append(hdr, 126)
		b := make([]byte, 2)
		binary.BigEndian.PutUint16(b, uint16(n))
		hdr = append(hdr, b...)
	default:
		hdr = append(hdr, 127)
		b := make([]byte, 8)
		binary.BigEndian.PutUint64(b, uint64(n))
		hdr = append(hdr, b...)
	}
	if _, err := s.rw.Write(hdr); err != nil {
		return err
	}
	if _, err := s.rw.Write(payload); err != nil {
		return err
	}
	return s.rw.Flush()
}

func (s *WS) WriteJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.WriteFrame(opText, b)
}

// PingLoop 维持 NAT 映射并让浏览器回 pong 以刷新读超时。
func (s *WS) PingLoop(done <-chan struct{}) {
	t := time.NewTicker(wsPingEvery)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if err := s.WriteFrame(opPing, nil); err != nil {
				return
			}
		case <-done:
			return
		}
	}
}
