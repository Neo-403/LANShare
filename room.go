package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	ridAlphabet   = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	pbkdf2Rounds  = 120000
	pbkdf2KeyLen  = 32
	maxNameLen    = 32
	maxNickLen    = 24
	passwordFails = 5
	passwordLock  = 30 * time.Second
	maxEncKeyLen  = 512 // 被包装的会话密钥（JSON 字符串）
	// 无 coturn 时的 WS 兜底转发：控制帧仍保持 64KB，兜底帧共用 1000/s；文件分片另走
	// relay_data，按 base64 文本长度限制（解码后不超过 192KB），并按字节配额限流。
	relayMaxBytes     = 64 * 1024
	relayDataMaxBytes = 256 * 1024
	relayDataRawMax   = 192 * 1024
)

var nickAdj = []string{"蓝色", "银色", "轻快", "安静", "明亮", "温柔", "勇敢", "好奇", "悠闲", "清澈"}
var nickNoun = []string{"鲸鱼", "狐狸", "海鸥", "山雀", "松鼠", "云朵", "星尘", "溪鱼", "小鹿", "猫头鹰"}

// randomNick 给每个首次访问的设备一个可读且易区分的名字。
func randomNick() string {
	b := randBytes(3)
	return nickAdj[int(b[0])%len(nickAdj)] + nickNoun[int(b[1])%len(nickNoun)] +
		strings.ToUpper(hex.EncodeToString(b[2:3]))
}

type appErr struct{ code, msg string }

func (e *appErr) Error() string { return e.msg }
func errf(code, msg string) error {
	return &appErr{code: code, msg: msg}
}
func errCode(err error) string {
	var e *appErr
	if errors.As(err, &e) {
		return e.code
	}
	return "internal"
}

// limiter 是每连接/每 IP 的令牌桶。
type limiter struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
	rate   float64
	burst  float64
}

func newLimiter(rate, burst float64) *limiter {
	return &limiter{tokens: burst, last: time.Now(), rate: rate, burst: burst}
}

func (l *limiter) allow(cost float64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.tokens += now.Sub(l.last).Seconds() * l.rate
	l.last = now
	if l.tokens > l.burst {
		l.tokens = l.burst
	}
	if l.tokens < cost {
		return false
	}
	l.tokens -= cost
	return true
}

// relayDataLimiter 按配置创建每连接的中继字节配额限流器。
// 返回 nil 表示不限速（默认），此时由 WS 背压与 relay_pause 负责流控。
func relayDataLimiter(cfg Config) *limiter {
	if cfg.RelayRateMB <= 0 {
		return nil
	}
	kb := cfg.RelayRateMB * 1024
	return newLimiter(kb, kb*2)
}

type Client struct {
	id, nick       string
	ws             *WS
	hub            *Hub
	ip             string // 出口 IP
	lan            string // 客户端上报的私网 /24
	netID          string // 用户绑定的网络标识
	scope          string
	room           string
	send           chan []byte
	done           chan struct{}
	closeOnce      sync.Once
	limit          *limiter
	relayLimit     *limiter
	relayDataLimit *limiter // 可选：按 KB 计的字节配额，nil 表示不限速
}

func (c *Client) sendJSON(v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	select {
	case c.send <- b:
		return true
	case <-c.done:
		return false
	default:
		c.close() // 背压过大，断开以免状态不一致
		return false
	}
}

func (c *Client) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.ws.Close()
	})
}

func (c *Client) inRoom() bool { return c.room != "" }

type Member struct {
	ID, Nick, IP, LAN, Scope string
}

type failRec struct {
	count int
	until time.Time
}

type Room struct {
	RID, Name, HostID, Salt, ScopeKey string
	// Salt 是会话密钥的包装盐（前端生成），EncKey 是用密码 KEK 加密后的会话密钥密文。
	// 服务端只存密文，永远拿不到会话密钥本身；改密码只是重新包装同一把密钥。
	EncKey           string
	Private          bool
	PwdSalt, PwdHash []byte
	Fails            map[string]*failRec
	Members          map[string]*Member
	Order            []string
	Created          time.Time
}

type Hub struct {
	mu          sync.Mutex
	cfg         Config
	rooms       map[string]*Room
	clients     map[string]*Client
	createLimit map[string]*limiter
}

func newHub(cfg Config) *Hub {
	h := &Hub{
		cfg:         cfg,
		rooms:       make(map[string]*Room),
		clients:     make(map[string]*Client),
		createLimit: make(map[string]*limiter),
	}
	go h.gc()
	return h
}

func (h *Hub) gc() {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for range t.C {
		h.mu.Lock()
		for ip, l := range h.createLimit {
			l.mu.Lock()
			idle := time.Since(l.last)
			l.mu.Unlock()
			if idle > 20*time.Minute {
				delete(h.createLimit, ip)
			}
		}
		h.mu.Unlock()
	}
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

func randHex(n int) string { return hex.EncodeToString(randBytes(n)) }

func randRID() string {
	b := randBytes(6)
	for i := range b {
		b[i] = ridAlphabet[int(b[i])%len(ridAlphabet)]
	}
	return string(b)
}

// validRID 只接受与随机房间号同字母表的 6 位短码：用户自定义房间号时
// 避免大小写与歧义字符，也避免超长标识被塞进分享链接。
func validRID(rid string) bool {
	if len(rid) != 6 {
		return false
	}
	for _, ch := range rid {
		if !strings.ContainsRune(ridAlphabet, ch) {
			return false
		}
	}
	return true
}

// pbkdf2SHA256 用标准库实现单块 PBKDF2-HMAC-SHA256（输出 32 字节）。
// 迭代数与 salt 必须与前端 WebCrypto 保持一致。
func pbkdf2SHA256(password, salt []byte, rounds int) []byte {
	mac := hmac.New(sha256.New, password)
	_, _ = mac.Write(salt)
	_, _ = mac.Write([]byte{0, 0, 0, 1})
	u := mac.Sum(nil)
	out := append([]byte(nil), u...)
	for i := 1; i < rounds; i++ {
		mac.Reset()
		_, _ = mac.Write(u)
		u = mac.Sum(nil)
		for j := range out {
			out[j] ^= u[j]
		}
	}
	return out[:pbkdf2KeyLen]
}

func cleanNick(s string) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > maxNickLen {
		r = r[:maxNickLen]
	}
	if len(r) == 0 || string(r) == "匿名" {
		return randomNick()
	}
	return string(r)
}

func cleanName(s string) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > maxNameLen {
		r = r[:maxNameLen]
	}
	return string(r)
}

// cleanKeySalt 由前端生成的包装盐，只接受短十六进制串；为空表示非法。
func cleanKeySalt(s string) string {
	if len(s) < 8 || len(s) > 64 {
		return ""
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') ||
			(r >= 'A' && r <= 'F') || r == '-' || r == '_') {
			return ""
		}
	}
	return s
}

// uniqueNickLocked 保证同一房间内昵称不重复；冲突时追加序号。
func (h *Hub) uniqueNickLocked(r *Room, want, self string) string {
	used := make(map[string]bool, len(r.Members))
	for id, m := range r.Members {
		if id != self {
			used[m.Nick] = true
		}
	}
	if !used[want] {
		return want
	}
	for i := 2; i < 100; i++ {
		cand := want + strconv.Itoa(i)
		if cr := []rune(cand); len(cr) > maxNickLen {
			cand = string(cr[:maxNickLen])
		}
		if !used[cand] {
			return cand
		}
	}
	return randomNick()
}

func cleanNetID(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
			if b.Len() >= 32 {
				break
			}
		}
	}
	return b.String()
}

// cleanLAN 只接受私网 IPv4 并归一到 /24，防止客户端伪造任意 scope。
func cleanLAN(s string) string {
	part, _, _ := strings.Cut(s, "/")
	ip := net.ParseIP(strings.TrimSpace(part)).To4()
	if ip == nil {
		return ""
	}
	private := ip[0] == 10 ||
		(ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) ||
		(ip[0] == 192 && ip[1] == 168)
	if !private {
		return ""
	}
	ip[3] = 0
	return ip.String() + "/24"
}

func scopeKey(netID, ip, lan string) string {
	if netID != "" {
		return "net|" + netID
	}
	if lan == "" {
		return "approx|" + ip + "|?"
	}
	return "approx|" + ip + "|" + lan
}

type scopeInfo struct{ kind, ip, lan string }

func parseScope(s string) scopeInfo {
	p := strings.SplitN(s, "|", 3)
	if len(p) != 3 {
		return scopeInfo{}
	}
	return scopeInfo{kind: p[0], ip: p[1], lan: p[2]}
}

// sameScope：一方尚未探测到私网段（"?"）时按通配处理，
// 避免 LAN 探测延迟造成刚创建的房间从列表里"跳组"消失。
func sameScope(a, b string) bool {
	if a == b {
		return true
	}
	x, y := parseScope(a), parseScope(b)
	if x.kind != "approx" || y.kind != "approx" || x.ip == "" || x.ip != y.ip {
		return false
	}
	return x.lan == "?" || y.lan == "?" || x.lan == y.lan
}

func (h *Hub) refreshScope(c *Client) {
	c.scope = scopeKey(c.netID, c.ip, c.lan)
}

func sameLan(a, b *Client) bool {
	if a == nil || b == nil {
		return false
	}
	return sameScope(a.scope, b.scope) && a.ip == b.ip
}

func (h *Hub) add(c *Client) {
	h.mu.Lock()
	h.clients[c.id] = c
	h.mu.Unlock()
}

func (h *Hub) get(id string) *Client {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.clients[id]
}

func (h *Hub) listRooms(c *Client) []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	rooms := make([]map[string]any, 0, len(h.rooms))
	for _, r := range h.rooms {
		if !sameScope(r.ScopeKey, c.scope) {
			continue // 跨网房间永不下发，只能凭房间号加入
		}
		rooms = append(rooms, map[string]any{
			"rid":     r.RID,
			"name":    r.Name,
			"private": r.Private,
			"members": len(r.Order),
			"approx":  !strings.HasPrefix(r.ScopeKey, "net|"),
		})
	}
	return rooms
}

// rid 非空时使用调用方指定的房间号（自动建/入），为空时生成随机短码。
func (h *Hub) create(c *Client, name, password, keySalt, encKey, rid string) (*Room, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.room != "" {
		return nil, errf("in_room", "请先离开当前房间")
	}
	ks := cleanKeySalt(keySalt)
	if ks == "" || len(encKey) > maxEncKeyLen {
		return nil, errf("bad_frame", "会话密钥参数不合法")
	}
	if password != "" && encKey == "" {
		return nil, errf("bad_frame", "私有房缺少封装密钥")
	}
	if password == "" {
		encKey = ""
	}
	if len(h.rooms) >= h.cfg.MaxRooms {
		return nil, errf("rate_limited", "房间总数已达上限")
	}
	l := h.createLimit[c.ip]
	if l == nil {
		l = newLimiter(10.0/60.0, 10)
		h.createLimit[c.ip] = l
	}
	if !l.allow(1) {
		return nil, errf("rate_limited", "创建过于频繁，请稍后再试")
	}
	name = cleanName(name)
	if name == "" {
		name = "房间 " + randHex(2)
	}
	if rid == "" {
		rid = randRID()
		for h.rooms[rid] != nil {
			rid = randRID()
		}
	} else {
		rid = strings.ToUpper(strings.TrimSpace(rid))
		if !validRID(rid) {
			return nil, errf("bad_frame", "房间号须为 6 位数字/大写字母")
		}
		if h.rooms[rid] != nil {
			return nil, errf("exists", "该房间号已被占用")
		}
	}
	r := &Room{
		RID:      rid,
		Name:     name,
		HostID:   c.id,
		Salt:     ks,
		EncKey:   encKey,
		ScopeKey: c.scope,
		Private:  password != "",
		Fails:    make(map[string]*failRec),
		Members:  make(map[string]*Member),
		Created:  time.Now(),
	}
	if r.Private {
		r.PwdSalt = randBytes(16)
		r.PwdHash = pbkdf2SHA256([]byte(password), r.PwdSalt, pbkdf2Rounds)
	}
	h.rooms[rid] = r
	h.attachLocked(c, r)
	return r, nil
}

// joinChallenge 返回盐与哈希副本；调用方在**释放全局锁之后**计算 PBKDF2，
// 避免慢哈希阻塞其它连接。
func (h *Hub) joinChallenge(c *Client, rid string) (private bool, salt, hash []byte, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.room != "" {
		return false, nil, nil, errf("in_room", "请先离开当前房间")
	}
	r := h.rooms[strings.ToUpper(rid)]
	if r == nil {
		return false, nil, nil, errf("not_found", "房间不存在或已解散")
	}
	if len(r.Order) >= h.cfg.MaxMembers {
		return false, nil, nil, errf("room_full", "房间已满（最多 "+strconv.Itoa(h.cfg.MaxMembers)+" 人）")
	}
	if !r.Private {
		return false, nil, nil, nil
	}
	fr := r.Fails[c.ip]
	if fr != nil && time.Now().Before(fr.until) {
		return false, nil, nil, errf("locked", "密码错误次数过多，请 30 秒后再试")
	}
	return true, append([]byte(nil), r.PwdSalt...), append([]byte(nil), r.PwdHash...), nil
}

func (h *Hub) joinVerify(c *Client, rid string, computed []byte) (*Room, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[strings.ToUpper(rid)]
	if r == nil {
		return nil, errf("not_found", "房间不存在或已解散")
	}
	if len(r.Order) >= h.cfg.MaxMembers {
		return nil, errf("room_full", "房间已满")
	}
	if r.Private {
		if subtle.ConstantTimeCompare(computed, r.PwdHash) != 1 {
			fr := r.Fails[c.ip]
			if fr == nil {
				fr = &failRec{}
				r.Fails[c.ip] = fr
			}
			fr.count++
			if fr.count >= passwordFails {
				fr.count = 0
				fr.until = time.Now().Add(passwordLock)
			}
			return nil, errf("bad_password", "房间密码不正确")
		}
		delete(r.Fails, c.ip)
	}
	h.attachLocked(c, r)
	return r, nil
}

func (h *Hub) attachLocked(c *Client, r *Room) {
	c.room = r.RID
	c.nick = h.uniqueNickLocked(r, c.nick, c.id)
	r.Members[c.id] = &Member{ID: c.id, Nick: c.nick, IP: c.ip, LAN: c.lan, Scope: c.scope}
	r.Order = append(r.Order, c.id)
}

// announceJoin 给老成员 peer_join，给新成员完整的 joined（含 peers / salt / ICE）。
func (h *Hub) announceJoin(c *Client, r *Room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, id := range r.Order {
		to := h.clients[id]
		if to == nil {
			continue
		}
		if id != c.id {
			to.sendJSON(map[string]any{
				"t": "peer_join",
				"peer": map[string]any{
					"id": c.id, "nick": c.nick, "sameLan": sameLan(to, c),
				},
			})
			continue
		}
		peers := make([]map[string]any, 0, len(r.Order)-1)
		for _, other := range r.Order {
			if other == c.id {
				continue
			}
			peers = append(peers, map[string]any{
				"id":      other,
				"nick":    r.Members[other].Nick,
				"sameLan": sameLan(c, h.clients[other]),
			})
		}
		syncFrom := ""
		if r.HostID != c.id {
			syncFrom = r.HostID
		}
		user, cred := turnCredentials(h.cfg.TurnSecret, c.id, h.cfg.TurnTTL)
		to.sendJSON(map[string]any{
			"t":        "joined",
			"rid":      r.RID,
			"name":     r.Name,
			"private":  r.Private,
			"salt":     r.Salt,   // 包装会话密钥用的 keySalt
			"encKey":   r.EncKey, // 私有房：用准入密码解包得到会话密钥；公开房为空
			"nick":     c.nick,   // 服务端保证房间内唯一后的昵称
			"host":     r.HostID,
			"peers":    peers,
			"syncFrom": syncFrom,
			"ice":      h.cfg.ICEConfig(user, cred),
		})
	}
}

func (h *Hub) leave(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.leaveLocked(c)
}

// leaveLocked 必须在持 h.mu 时调用；全员离线时房间与其中所有内存状态立即销毁。
func (h *Hub) leaveLocked(c *Client) {
	if c.room == "" {
		return
	}
	r := h.rooms[c.room]
	c.room = ""
	if r == nil {
		return
	}
	wasHost := r.HostID == c.id
	delete(r.Members, c.id)
	for i, id := range r.Order {
		if id == c.id {
			r.Order = append(r.Order[:i], r.Order[i+1:]...)
			break
		}
	}
	if len(r.Order) == 0 {
		delete(h.rooms, r.RID)
		return
	}
	if wasHost {
		r.HostID = r.Order[0]
		h.broadcastLocked(r, map[string]any{"t": "host_changed", "id": r.HostID})
	}
	h.broadcastLocked(r, map[string]any{"t": "peer_leave", "id": c.id})
}

func (h *Hub) remove(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.leaveLocked(c)
	delete(h.clients, c.id)
}

func (h *Hub) broadcastLocked(r *Room, msg any) {
	for _, id := range r.Order {
		if c := h.clients[id]; c != nil {
			c.sendJSON(msg)
		}
	}
}

// setPassword 由房主添加 / 修改 / 移除准入密码。
// 只替换「用密码包装的会话密钥密文」和准入哈希，会话密钥本身不变，
// 因此已连接成员不会被踢、不会被要求重新输密码、聊天也不会中断。
func (h *Hub) setPassword(c *Client, password, keySalt, encKey string) error {
	ks := cleanKeySalt(keySalt)
	if ks == "" || len(encKey) > maxEncKeyLen {
		return errf("bad_frame", "会话密钥参数不合法")
	}
	if password != "" && encKey == "" {
		return errf("bad_frame", "私有房缺少封装密钥")
	}
	if password == "" {
		encKey = ""
	}

	h.mu.Lock()
	r := h.rooms[c.room]
	if r == nil || r.HostID != c.id {
		h.mu.Unlock()
		return errf("forbidden", "只有房主可以修改房间密码")
	}
	h.mu.Unlock()

	// 慢哈希在全局锁之外计算，避免阻塞其它连接。
	var pwdSalt, pwdHash []byte
	if password != "" {
		pwdSalt = randBytes(16)
		pwdHash = pbkdf2SHA256([]byte(password), pwdSalt, pbkdf2Rounds)
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	r = h.rooms[c.room]
	if r == nil || r.HostID != c.id {
		return errf("forbidden", "只有房主可以修改房间密码")
	}
	r.Private = password != ""
	r.PwdSalt, r.PwdHash = pwdSalt, pwdHash
	r.Salt = ks
	r.EncKey = encKey
	r.Fails = make(map[string]*failRec)
	h.broadcastLocked(r, map[string]any{
		"t": "room_meta", "private": r.Private, "salt": r.Salt,
	})
	return nil
}

// setNick 允许随时改名；房间内昵称唯一，重名自动追加序号并广播给所有成员。
func (h *Hub) setNick(c *Client, want string) error {
	newNick := cleanNick(want)
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[c.room]
	if r != nil {
		newNick = h.uniqueNickLocked(r, newNick, c.id)
		if m := r.Members[c.id]; m != nil {
			m.Nick = newNick
		}
		h.broadcastLocked(r, map[string]any{"t": "peer_nick", "id": c.id, "nick": newNick})
	}
	c.nick = newNick
	c.sendJSON(map[string]any{"t": "nick_set", "nick": newNick})
	return nil
}

func (h *Hub) kick(host *Client, target string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[host.room]
	if r == nil || r.HostID != host.id {
		return errf("forbidden", "只有房主可以踢人")
	}
	t := h.clients[target]
	if t == nil || t.room != r.RID {
		return errf("not_found", "成员不在线")
	}
	t.room = ""
	delete(r.Members, target)
	for i, id := range r.Order {
		if id == target {
			r.Order = append(r.Order[:i], r.Order[i+1:]...)
			break
		}
	}
	t.sendJSON(map[string]any{"t": "kicked", "rid": r.RID})
	h.broadcastLocked(r, map[string]any{"t": "peer_leave", "id": target})
	return nil
}

func (h *Hub) closeRoom(host *Client) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[host.room]
	if r == nil || r.HostID != host.id {
		return errf("forbidden", "只有房主可以解散房间")
	}
	ids := append([]string(nil), r.Order...)
	delete(h.rooms, r.RID)
	for _, id := range ids {
		c := h.clients[id]
		if c != nil {
			c.room = ""
			c.sendJSON(map[string]any{"t": "room_closed", "rid": r.RID})
		}
	}
	return nil
}

// signalTo 只在同一房间内转发 SDP / ICE。
func (h *Hub) signalTo(from *Client, toID string, data any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[from.room]
	if r == nil {
		return errf("not_in_room", "不在房间内")
	}
	to := h.clients[toID]
	if to == nil || to.room != r.RID {
		return errf("not_found", "目标成员不在线")
	}
	to.sendJSON(map[string]any{"t": "signal", "from": from.id, "data": data})
	return nil
}

// relayTo 是 TURN 不可用时的最后兜底，仅在内存转发，绝不落盘。
func (h *Hub) relayTo(from *Client, toID, bin string) error {
	if len(bin) > relayMaxBytes {
		return errf("rate_limited", "relay 帧过大")
	}
	to, err := h.roomPeer(from, toID)
	if err != nil {
		return err
	}
	if !relayEnqueue(to, map[string]any{"t": "relay", "from": from.id, "bin": bin}) {
		from.trySendJSON(map[string]any{"t": "relay_pause", "ms": 200})
	}
	return nil
}

// relayDataTo 在没有 TURN 时经 WS 转发文件分片 / 直传帧。服务端只透传 base64
// 字符串，不解码业务内容、不缓存、不落盘；kind 白名单防止该通道被挪作它用。
func (h *Hub) relayDataTo(from *Client, toID, kind, bin string) error {
	if kind != "data" && kind != "direct" {
		return errf("bad_frame", "非法的数据类型")
	}
	if len(bin) == 0 || len(bin) > relayDataMaxBytes || len(bin)%4 != 0 ||
		base64.StdEncoding.DecodedLen(len(bin)) > relayDataRawMax {
		return errf("bad_frame", "中继数据帧过大或格式非法")
	}
	to, err := h.roomPeer(from, toID)
	if err != nil {
		return err
	}
	if !relayEnqueue(to, map[string]any{"t": "relay_data", "from": from.id, "k": kind, "bin": bin}) {
		// 接收端队列拥塞：给发送方一个短暂节流信号，避免持续冲刷把连接拖垮。
		// 丢弃的这一片由文件层的位图 / 段重组重传机制补齐。
		from.trySendJSON(map[string]any{"t": "relay_pause", "ms": 300})
	}
	return nil
}

// relayEnqueue 在全局锁之外入队。接收端较慢时先短暂等待其排空，仍放不下
// 才丢弃该帧；绝不因为兜底帧直接关闭接收端连接（sendJSON 的满队列策略）。
func relayEnqueue(to *Client, v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	select {
	case to.send <- b:
		return true
	case <-to.done:
		return false
	default:
	}
	t := time.NewTimer(time.Second)
	defer t.Stop()
	select {
	case to.send <- b:
		return true
	case <-to.done:
		return false
	case <-t.C:
		return false
	}
}

// trySendJSON 用于尽力而为的节流通知：队列满时直接丢弃，不影响连接。
func (c *Client) trySendJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case c.send <- b:
	default:
	}
}

// roomPeer 校验发送方与接收方同属一个在线房间，供两种中继帧共用。
func (h *Hub) roomPeer(from *Client, toID string) (*Client, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[from.room]
	if r == nil {
		return nil, errf("not_in_room", "不在房间内")
	}
	to := h.clients[toID]
	if to == nil || to.room != r.RID {
		return nil, errf("not_found", "目标成员不在线")
	}
	return to, nil
}
