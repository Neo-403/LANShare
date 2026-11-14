import { Emitter, utf8ToB64, b64ToUtf8, b64encode, sleep, RELAY_DATA_MAX } from './util.js';

export class Net extends Emitter {
  constructor() {
    super();
    this.ws = null;
    this.closed = false;
    this.retry = 0;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.emit('open'); };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      this.emit(m.t, m);
      this.emit('frame', m);
    };
    ws.onclose = () => {
      this.emit('close');
      if (!this.closed) this.reconnectSoon();
    };
    ws.onerror = () => {};
  }

  async reconnectSoon() {
    await sleep(Math.min(800 * (2 ** this.retry++), 8000));
    if (!this.closed) this.connect();
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

// WS 兜底帧：只在 TURN 也不可用时承载小体积控制消息，服务端仅内存转发。
export function relayCtrl(net, to, obj) {
  net.send({ t: 'relay', to, bin: utf8ToB64(JSON.stringify(obj)) });
}

export function parseRelay(msg) {
  try { return JSON.parse(b64ToUtf8(msg.bin)); } catch { return null; }
}

// WS 兜底数据帧：无 TURN 时承载已加密的文件分片 / 直传帧，服务端仅内存透传。
// 发送的是上层构造好的整帧（含帧头与 AES-GCM tag），中继链路不改变帧格式。
export function relayData(net, to, kind, u8) {
  if (!u8 || u8.byteLength > RELAY_DATA_MAX) return false;
  return net.send({ t: 'relay_data', to, k: kind, bin: b64encode(u8) });
}
