package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"strconv"
	"time"
)

// turnCredentials 生成 coturn use-auth-secret 模式下的临时凭据。
// username = "<过期unix时间戳>:<peerId>"，credential = base64(HMAC-SHA1(secret, username))。
func turnCredentials(secret, peerID string, ttl int64) (string, string) {
	if secret == "" || peerID == "" {
		return "", ""
	}
	exp := time.Now().Unix() + ttl
	user := strconv.FormatInt(exp, 10) + ":" + peerID
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(user))
	return user, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
