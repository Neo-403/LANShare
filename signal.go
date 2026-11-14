package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
)

// InMsg 是客户端能发给服务端的**全部**字段。
// 业务数据正常只走 WebRTC；Bin 仅在无 TURN 的 WS 兜底场景承载 base64 帧，
// 服务端只做内存透传，不解析内容、不落盘。
type InMsg struct {
	T        string          `json:"t"`
	V        int             `json:"v"`
	Nick     string          `json:"nick"`
	NetID    string          `json:"netId"`
	LAN      string          `json:"lan"`
	Name     string          `json:"name"`
	Password string          `json:"password"`
	RID      string          `json:"rid"`
	To       string          `json:"to"`
	ID       string          `json:"id"`
	Bin      string          `json:"bin"`
	Kind     string          `json:"k"`
	KeySalt  string          `json:"keySalt"`
	EncKey   string          `json:"encKey"`
	Data     json.RawMessage `json:"data"`
}

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if x := r.Header.Get("X-Forwarded-For"); x != "" {
			return strings.TrimSpace(strings.Split(x, ",")[0])
		}
		if x := r.Header.Get("X-Real-IP"); x != "" {
			return strings.TrimSpace(x)
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func serveWS(hub *Hub, w http.ResponseWriter, r *http.Request) {
	ws, err := upgrade(w, r, hub.cfg.TrustProxy)
	if err != nil {
		log.Printf("ws upgrade rejected from %s: %v", r.RemoteAddr, err)
		http.Error(w, "bad websocket handshake", http.StatusBadRequest)
		return
	}
	// 默认不限速：只有显式配置了 LANSHARE_RELAY_RATE_MB 才创建字节配额限流器。
	// 帧数限制始终保留以防小帧洪泛；1000/s 对 128KB 分片约 128MB/s，不构成吞吐瓶颈。
	dataLimit := relayDataLimiter(hub.cfg)
	c := &Client{
		id:             randHex(6),
		nick:           randomNick(),
		ws:             ws,
		hub:            hub,
		ip:             clientIP(r, hub.cfg.TrustProxy),
		send:           make(chan []byte, 512),
		done:           make(chan struct{}),
		limit:          newLimiter(100, 200),   // 信令 100/s
		relayLimit:     newLimiter(1000, 2000), // 兜底帧 1000/s（数据中继也用，防止小帧洪泛）
		relayDataLimit: dataLimit,              // nil = 不限速
	}
	hub.add(c)
	go c.writer()
	go ws.PingLoop(c.done)
	defer func() {
		hub.remove(c)
		c.close()
	}()

	for {
		op, payload, err := ws.ReadMessage()
		if err != nil {
			return
		}
		if op != opText {
			continue // 只接受文本帧：中继数据也以 base64 文本承载；P2P 业务帧走 DataChannel
		}
		var m InMsg
		if json.Unmarshal(payload, &m) != nil {
			c.sendError("bad_frame", "无法解析的 JSON")
			continue
		}
		// 数据中继有自己的字节配额限流，不再占用信令的 100/s 次数。
		if m.T != "relay_data" && !c.limit.allow(1) {
			c.sendError("rate_limited", "操作过于频繁")
			continue
		}
		hub.handle(c, &m)
	}
}

func (c *Client) writer() {
	for {
		select {
		case b := <-c.send:
			if err := c.ws.WriteFrame(opText, b); err != nil {
				c.close()
				return
			}
		case <-c.done:
			return
		}
	}
}

func (c *Client) sendError(code, msg string) {
	c.sendJSON(map[string]any{"t": "error", "code": code, "msg": msg})
}

// applyMeta 同步客户端上报的昵称、网络标识与私网段。
// lan 为空时不覆盖已探测到的值，避免重连/提前 hello 造成 scope 回退。
func (h *Hub) applyMeta(c *Client, m *InMsg) {
	// 空昵称或默认「匿名」时保留服务端下发的随机名，避免每次 hello 都换名字。
	if m.Nick != "" && m.Nick != "匿名" {
		c.nick = cleanNick(m.Nick)
	}
	if l := cleanLAN(m.LAN); l != "" {
		c.lan = l
	}
	c.netID = cleanNetID(m.NetID)
	h.mu.Lock()
	h.refreshScope(c)
	h.mu.Unlock()
}

func (h *Hub) handle(c *Client, m *InMsg) {
	switch m.T {
	case "hello":
		if m.V != 1 {
			c.sendError("bad_frame", "协议版本不匹配")
			return
		}
		h.applyMeta(c, m)
		user, cred := turnCredentials(h.cfg.TurnSecret, c.id, h.cfg.TurnTTL)
		kind := "approx"
		label := "推测同网"
		if c.netID != "" {
			kind = "net"
			label = "网络标识 " + c.netID
		} else if c.lan != "" {
			label = "推测同网 " + c.lan
		}
		c.sendJSON(map[string]any{
			"t":      "welcome",
			"peerId": c.id,
			"nick":   c.nick,
			"ice":    h.cfg.ICEConfig(user, cred),
			"scope":  map[string]any{"key": c.scope, "kind": kind, "label": label},
			"limits": map[string]any{
				"maxMembers":   h.cfg.MaxMembers,
				"maxRooms":     h.cfg.MaxRooms,
				"relayMax":     relayMaxBytes,
				"relayDataMax": relayDataRawMax,
			},
		})

	case "list":
		c.sendJSON(map[string]any{"t": "roomlist", "rooms": h.listRooms(c)})

	case "bindnet":
		h.applyMeta(c, m)
		kind := "approx"
		label := "推测同网"
		if c.netID != "" {
			kind = "net"
			label = "网络标识 " + c.netID
		} else if c.lan != "" {
			label = "推测同网 " + c.lan
		}
		c.sendJSON(map[string]any{"t": "scope", "key": c.scope, "kind": kind, "label": label})
		c.sendJSON(map[string]any{"t": "roomlist", "rooms": h.listRooms(c)})

	// enter：房间号已存在则加入，不存在则用该房间号创建，前端只需一个入口。
	case "enter":
		rid := strings.ToUpper(strings.TrimSpace(m.RID))
		if !validRID(rid) || len(m.Password) > 128 || len(m.Name) > 128 {
			c.sendError("bad_frame", "房间号或密码不合法")
			return
		}
		h.applyMeta(c, m)
		private, salt, _, err := h.joinChallenge(c, rid)
		if err == nil {
			var computed []byte
			if private {
				computed = pbkdf2SHA256([]byte(m.Password), salt, pbkdf2Rounds)
			}
			r, jerr := h.joinVerify(c, rid, computed)
			if jerr != nil {
				c.sendError(errCode(jerr), jerr.Error())
				return
			}
			h.announceJoin(c, r)
			log.Printf("peer %s entered room %s", c.id, r.RID)
			return
		}
		if errCode(err) != "not_found" {
			c.sendError(errCode(err), err.Error())
			return
		}
		r, err := h.create(c, m.Name, m.Password, m.KeySalt, m.EncKey, rid)
		if err != nil {
			c.sendError(errCode(err), err.Error())
			return
		}
		c.sendJSON(map[string]any{
			"t": "created", "rid": r.RID, "name": r.Name,
			"private": r.Private, "salt": r.Salt, "host": r.HostID,
		})
		h.announceJoin(c, r)
		log.Printf("room %s created by %s (enter, scope=%s)", r.RID, c.id, r.ScopeKey)

	case "create":
		if len(m.Password) > 128 || len(m.Name) > 128 {
			c.sendError("bad_frame", "名称或密码过长")
			return
		}
		h.applyMeta(c, m)
		r, err := h.create(c, m.Name, m.Password, m.KeySalt, m.EncKey, "")
		if err != nil {
			c.sendError(errCode(err), err.Error())
			return
		}
		c.sendJSON(map[string]any{
			"t": "created", "rid": r.RID, "name": r.Name,
			"private": r.Private, "salt": r.Salt, "host": r.HostID,
		})
		h.announceJoin(c, r)
		log.Printf("room %s created by %s (scope=%s)", r.RID, c.id, r.ScopeKey)

	case "join":
		rid := strings.ToUpper(strings.TrimSpace(m.RID))
		if len(rid) > 12 || len(m.Password) > 128 {
			c.sendError("bad_frame", "房间号或密码不合法")
			return
		}
		h.applyMeta(c, m)
		private, salt, _, err := h.joinChallenge(c, rid)
		if err != nil {
			c.sendError(errCode(err), err.Error())
			return
		}
		// 慢哈希在全局锁之外计算，避免阻塞其它连接。
		var computed []byte
		if private {
			computed = pbkdf2SHA256([]byte(m.Password), salt, pbkdf2Rounds)
		}
		r, err := h.joinVerify(c, rid, computed)
		if err != nil {
			c.sendError(errCode(err), err.Error())
			return
		}
		h.announceJoin(c, r)
		log.Printf("peer %s joined room %s", c.id, r.RID)

	case "signal":
		if !c.inRoom() || m.To == "" || len(m.Data) == 0 || len(m.Data) > 64*1024 {
			c.sendError("bad_frame", "非法的信令帧")
			return
		}
		if err := h.signalTo(c, m.To, json.RawMessage(m.Data)); err != nil {
			c.sendError(errCode(err), err.Error())
		}

	case "relay":
		if !c.relayLimit.allow(1) {
			c.sendError("rate_limited", "兜底转发频率过高")
			return
		}
		if err := h.relayTo(c, m.To, m.Bin); err != nil {
			c.sendError(errCode(err), err.Error())
		}

	case "relay_data":
		if !c.relayLimit.allow(1) {
			c.sendError("rate_limited", "兜底转发频率过高")
			return
		}
		if c.relayDataLimit != nil &&
			!c.relayDataLimit.allow(float64(len(m.Bin))/1024) {
			c.sendError("rate_limited", "中继数据速率超限")
			return
		}
		if err := h.relayDataTo(c, m.To, m.Kind, m.Bin); err != nil {
			c.sendError(errCode(err), err.Error())
		}

	case "leave":
		h.leave(c)
		c.sendJSON(map[string]any{"t": "left"})

	case "set_password":
		if len(m.Password) > 128 {
			c.sendError("bad_frame", "密码过长")
			return
		}
		if err := h.setPassword(c, m.Password, m.KeySalt, m.EncKey); err != nil {
			c.sendError(errCode(err), err.Error())
		}

	case "set_nick":
		if len(m.Nick) > 64 {
			c.sendError("bad_frame", "昵称过长")
			return
		}
		if err := h.setNick(c, m.Nick); err != nil {
			c.sendError(errCode(err), err.Error())
		}

	case "kick":
		if err := h.kick(c, m.ID); err != nil {
			c.sendError(errCode(err), err.Error())
		}

	case "close_room":
		if err := h.closeRoom(c); err != nil {
			c.sendError(errCode(err), err.Error())
		}

	case "ping":
		c.sendJSON(map[string]any{"t": "pong"})

	default:
		c.sendError("bad_frame", "未知帧类型")
	}
}
