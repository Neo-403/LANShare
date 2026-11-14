import { Emitter, utf8ToB64, b64ToUtf8, sleep } from './util.js';

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
