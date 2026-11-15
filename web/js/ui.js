import { escapeHTML, fmtSize, fmtTime, Emitter, MAX_TEXT_CHARS, TEXT_HINT_LEFT } from './util.js';
import { renderQR } from './qr.js';

const $ = id => document.getElementById(id);

export class UI extends Emitter {
  constructor() {
    super();
    this.el = {
      app: $('app'), home: $('home'), chat: $('chat'), conn: $('connState'), scope: $('scopeBtn'),
      scopeNote: $('scopeNote'), roomList: $('roomList'), peerList: $('peerList'),
      peerCount: $('peerCount'), messages: $('messages'), toast: $('toast'),
      modal: $('modal'), netIdInput: $('netIdInput'), textInput: $('textInput'),
      textHint: $('textHint'),
      fileInput: $('fileInput'), roomTitle: $('roomTitle'), roomCode: $('roomCode'),
      roomBadge: $('roomBadge'), closeRoomBtn: $('closeRoomBtn'), linkInfo: $('linkInfo'),
      enterForm: $('enterForm'), nickInput: $('nickInput'), roomName: $('roomName'),
      enterRid: $('enterRid'), enterPwd: $('enterPwd'),
      shareBtn: $('shareBtn'), shareModal: $('shareModal'), shareQr: $('shareQr'),
      shareLink: $('shareLink'), wakeState: $('wakeState'),
      nickBtn: $('nickBtn'), roomSettingsBtn: $('roomSettingsBtn'),
      nickModal: $('nickModal'), nickModalInput: $('nickModalInput'),
      pwdModal: $('pwdModal'), pwdState: $('pwdState'),
      newPwd: $('newPwd'), newPwd2: $('newPwd2'), pwdRemove: $('pwdRemove'),
    };
    this.self = '';
    this.nick = '';
    this.private = false;
    this.file = null;
    this.toastTimer = 0;
  }

  bind(h) {
    this.handlers = h;
    const e = this.el;

    e.enterForm.addEventListener('submit', ev => {
      ev.preventDefault();
      h.onEnter(e.enterRid.value.trim().toUpperCase(), e.enterPwd.value,
                e.roomName.value.trim(), e.nickInput.value.trim());
    });
    $('refreshRooms').addEventListener('click', () => h.onRefresh());
    e.scope.addEventListener('click', () => h.onScopeClick());
    $('leaveBtn').addEventListener('click', () => h.onLeave());
    e.closeRoomBtn.addEventListener('click', () => h.onCloseRoom());
    $('copyCode').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(e.roomCode.textContent); this.toast('房间号已复制'); }
      catch { this.toast('复制失败：' + e.roomCode.textContent); }
    });
    e.shareBtn.addEventListener('click', () => h.onShare());
    $('shareClose').addEventListener('click', () => this.closeShare());
    $('shareCopy').addEventListener('click', () => this.copyShareLink());
    e.shareLink.addEventListener('click', () => this.copyShareLink());

    // 昵称：首页输入框失焦即改，房间页按钮打开弹窗，两处都由服务端保证唯一。
    e.nickInput.addEventListener('change', () => {
      const v = e.nickInput.value.trim();
      if (v && v !== this.nick) h.onNickChange(v);
    });
    e.nickBtn.addEventListener('click', () => this.openNickModal());
    $('nickModalCancel').addEventListener('click', () => this.closeNickModal());
    $('nickModalSave').addEventListener('click', () => {
      const v = e.nickModalInput.value.trim();
      if (!v) { this.toast('昵称不能为空'); return; }
      h.onNickChange(v);
      this.closeNickModal();
    });

    // 房主密码管理
    e.roomSettingsBtn.addEventListener('click', () => this.openPwdModal());
    $('pwdCancel').addEventListener('click', () => this.closePwdModal());
    $('pwdSave').addEventListener('click', () => {
      const p = e.newPwd.value;
      if (p !== e.newPwd2.value) { this.toast('两次输入的密码不一致'); return; }
      if (!p) { this.toast('如需移除密码请点「移除密码」'); return; }
      h.onSetPassword(p);
      this.closePwdModal();
    });
    $('pwdRemove').addEventListener('click', () => {
      if (!confirm('移除密码后房间将变为公开，确定吗？')) return;
      h.onSetPassword('');
      this.closePwdModal();
    });

    // 房主踢人
    e.peerList.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-kick]');
      if (!btn) return;
      if (confirm(`确定将 ${btn.dataset.nick || '该成员'} 移出房间？`)) h.onKick(btn.dataset.kick);
    });

    $('pickFile').addEventListener('click', () => e.fileInput.click());
    e.fileInput.addEventListener('change', () => {
      const files = [...e.fileInput.files];
      e.fileInput.value = '';
      if (files.length) h.onFiles(files);
    });
    $('sendText').addEventListener('click', () => this.submitText(h));
    e.textInput.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); this.submitText(h); }
    });
    // 上限由常量统一设置：HTML 不写死 maxlength，避免两处口径不一致。
    e.textInput.maxLength = MAX_TEXT_CHARS;
    e.textInput.addEventListener('input', () => { this.autoGrow(); this.updateTextHint(); });
    window.addEventListener('resize', () => this.autoGrow());
    this.autoGrow();
    this.updateTextHint();
    $('seedOnCellular').addEventListener('change', ev => h.onSeedToggle(ev.target.checked));

    e.messages.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      // 按钮可能由 updateTransfer 重渲染而来，兜底从所属卡片取 fid，避免传空导致动作被静默忽略。
      const card = btn.closest('[data-fid]');
      h.onFileAction(btn.dataset.action, btn.dataset.fid || card?.dataset.fid);
    });
    e.roomList.addEventListener('click', ev => {
      const card = ev.target.closest('[data-rid]');
      if (card) h.onRoomClick(card.dataset.rid, card.dataset.private === '1');
    });

    $('netIdRandom').addEventListener('click', () => { e.netIdInput.value = 'net-' + Math.random().toString(36).slice(2, 10); });
    $('netIdCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(e.netIdInput.value); this.toast('标识已复制，发给同网设备即可'); }
      catch { this.toast('复制失败'); }
    });
    $('netIdClear').addEventListener('click', () => h.onNetIdSave(''));
    $('netIdSave').addEventListener('click', () => h.onNetIdSave(e.netIdInput.value.trim()));
    $('netIdCancel').addEventListener('click', () => this.closeModal());
  }

  // 默认 5 行由 CSS min-height 保证；内容更多时增高，到屏高 2/3 为止并显示内部滚动条。
  autoGrow() {
    const el = this.el.textInput;
    el.style.height = 'auto';
    const max = Math.floor(window.innerHeight * 2 / 3);
    el.style.height = Math.min(el.scrollHeight, max) + 'px';
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }

  // 只在临近上限时出现，平时完全隐藏，不干扰输入；剩余很少时转为警示色。
  updateTextHint() {
    const left = MAX_TEXT_CHARS - this.el.textInput.value.length;
    const hint = this.el.textHint;
    if (left > TEXT_HINT_LEFT) {
      hint.classList.add('hidden');
      hint.textContent = '';
      return;
    }
    hint.textContent = left > 0
      ? `剩余可用 ${left} 字（上限 ${MAX_TEXT_CHARS}）`
      : `已达 ${MAX_TEXT_CHARS} 字上限`;
    hint.classList.toggle('warn', left <= 100);
    hint.classList.remove('hidden');
  }

  openShare(link) {
    this.shareURL = link;
    this.el.shareLink.textContent = link;
    try { renderQR(this.el.shareQr, link, 220); }
    catch (err) { this.toast('二维码生成失败：' + err.message); }
    this.el.shareModal.classList.remove('hidden');
  }

  closeShare() { this.el.shareModal.classList.add('hidden'); }

  async copyShareLink() {
    const link = this.shareURL || this.el.shareLink.textContent;
    try { await navigator.clipboard.writeText(link); this.toast('链接已复制'); }
    catch { this.toast('复制失败，请长按选择链接'); }
  }

  submitText(h) {
    const v = this.el.textInput.value.trim();
    if (!v) return;
    // maxLength 之外再兜一层：脚本/输入法写入超长内容时不静默截断。
    if (v.length > MAX_TEXT_CHARS) { this.toast(`最多输入 ${MAX_TEXT_CHARS} 字`); return; }
    this.el.textInput.value = '';
    this.autoGrow();
    this.updateTextHint();
    h.onSendText(v);
  }

  setReady(v) {
    document.querySelectorAll('#home button, #home input, #home textarea')
      .forEach(el => { el.disabled = !v; });
    this.el.scope.disabled = !v;
  }

  setConn(text, ok = false, bad = false) {
    this.el.conn.textContent = text;
    this.el.conn.className = 'conn' + (ok ? ' ok' : '') + (bad ? ' bad' : '');
  }

  setWakeLock(on, supported = true) {
    this.el.wakeState.textContent = on
      ? (supported ? '传输中 · 屏幕保持常亮' : '传输中 · 息屏可从断点续传')
      : '';
  }

  setNick(nick) {
    this.nick = nick;
    this.el.nickInput.value = nick;
    this.el.nickBtn.textContent = '我：' + nick;
    this.el.nickModalInput.value = nick;
  }

  setScope(label, kind) {
    this.el.scope.textContent = (kind === 'net' ? '● ' : '◌ ') + label;
    this.el.scopeNote.textContent = kind === 'net'
      ? '已绑定网络标识：只显示同标识设备创建的房间。'
      : '默认按「出口 IP + 私网段」推测同网，可能有误判。点击右上角绑定网络标识可精确到本局域网。';
  }

  showView(v) {
    this.el.home.classList.toggle('hidden', v !== 'home');
    this.el.chat.classList.toggle('hidden', v !== 'chat');
    this.el.app.classList.toggle('in-home', v === 'home');
    // 隐藏时 textarea 的 scrollHeight 不可信，进入房间后重新计算初始高度。
    if (v === 'chat') requestAnimationFrame(() => { this.autoGrow(); this.updateTextHint(); });
  }

  renderRooms(rooms) {
    if (!rooms.length) {
      this.el.roomList.innerHTML = '<div class="empty">当前网络还没有房间，创建一个吧</div>';
      return;
    }
    this.el.roomList.innerHTML = rooms.map(r => `
      <button class="room-card" data-rid="${escapeHTML(r.rid)}" data-private="${r.private ? 1 : 0}">
        <div>
          <div class="name">${escapeHTML(r.name)}</div>
          <div class="meta">
            ${r.private ? '<span class="tag lock">私有 · 需密码</span>' : '<span class="tag">公开</span>'}
            ${r.approx ? '<span class="tag approx">推测同网</span>' : ''}
            ${r.members} 人在线
          </div>
        </div>
        <span class="rid">${escapeHTML(r.rid)}</span>
      </button>`).join('');
  }

  setRoomInfo(info, isHost) {
    this.el.roomTitle.textContent = info.name;
    this.el.roomCode.textContent = info.rid;
    this.setPrivate(info.private);
    this.el.closeRoomBtn.classList.toggle('hidden', !isHost);
    this.el.roomSettingsBtn.classList.toggle('hidden', !isHost);
  }

  setPrivate(v) {
    this.private = !!v;
    this.el.roomBadge.textContent = this.private ? '私有 · 需密码' : '公开';
  }

  renderPeers(list, host, isHost = false) {
    this.el.peerCount.textContent = list.length;
    const label = { LAN: '内网', P2P: '打洞', TURN: '转发', RELAY: '中继', SELF: '我' };
    this.el.peerList.innerHTML = list.map(m => `
      <div class="peer">
        <span class="dot ${m.ready ? '' : 'wait'}"></span>
        <span>${escapeHTML(m.nick)}${m.id === host ? ' 👑' : ''}</span>
        <span class="link">${label[m.link] || m.link}</span>
        ${isHost && !m.self
          ? `<button class="kick-btn" data-kick="${escapeHTML(m.id)}" data-nick="${escapeHTML(m.nick)}" title="移出房间">踢出</button>`
          : ''}
      </div>`).join('');
    const kinds = new Set(list.filter(m => !m.self).map(m => m.link));
    this.el.linkInfo.textContent = kinds.size
      ? '链路：' + [...kinds].map(k => label[k] || k).join(' / ')
      : '';
  }

  addSystem(text) { this.appendSystem(text); }

  appendSystem(text) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = text;
    this.el.messages.appendChild(div);
    this.scroll();
  }

  scroll() {
    const m = this.el.messages;
    if (m.scrollHeight - m.scrollTop - m.clientHeight < 180) m.scrollTop = m.scrollHeight;
  }

  addMessage(item) {
    const wrap = document.createElement('div');
    wrap.dataset.id = item.id;
    if (item.t === 'chat') {
      wrap.className = 'msg' + (item.from === this.self ? ' mine' : '');
      wrap.innerHTML = `
        <div class="from">${escapeHTML(item.nick || item.from)}</div>
        <div class="text">${escapeHTML(item.text)}</div>
        <div class="time">${fmtTime(item.ts)}</div>`;
    } else if (item.t === 'file_offer') {
      const f = item.file;
      wrap.className = 'msg file-card' + (item.from === this.self ? ' mine' : '');
      wrap.dataset.fid = f.fid;
      wrap.innerHTML = `
        <div class="fname">📄 ${escapeHTML(f.name)}</div>
        <div class="fsize">${fmtSize(f.size)} · 来自 ${escapeHTML(item.nick || item.from)} · ${fmtTime(item.ts)}</div>
        <div class="fstatus">等待接收</div>
        <div class="progress"><div></div></div>
        <div class="factions"><button class="btn btn-sm btn-primary" data-action="accept" data-fid="${escapeHTML(f.fid)}">接收</button></div>`;
    } else return;
    this.el.messages.appendChild(wrap);
    if (item.t === 'file_offer' && this.file) this.updateTransfer(this.file.get(item.file.fid));
    this.scroll();
  }

  renderHistory(items) {
    this.el.messages.innerHTML = '';
    for (const it of items) this.addMessage(it);
    if (this.file) for (const it of items) if (it.t === 'file_offer') this.updateTransfer(this.file.get(it.file.fid));
  }

  updateTransfer(t) {
    if (!t) return;
    // 同一文件可能在历史里出现多张卡片；只更新第一张会让其余卡片的按钮停留在旧状态，
    // 用户点那些按钮就像「没反应」。全部同步更新。
    // 按钮自身也带 data-fid，必须限定为卡片容器，否则会在按钮上找不到 .fstatus。
    const els = this.el.messages.querySelectorAll(`.file-card[data-fid="${t.fid}"]`);
    if (!els.length) return;
    const isSender = t.role === 'seeder';
    const metric = isSender ? (t.bytesSent || 0) : t.bytesDone;
    const pct = t.meta.size ? Math.min(100, (metric / t.meta.size) * 100) : 0;
    const sources = this.file ? this.file.ownerCount(t) : 0;
    let status = '';
    let actions = '';
    switch (t.state) {
      case 'seeding':
        status = `已就绪，等待其它设备点击接收 · ${sources} 个下载源`;
        actions = '';
        break;
      case 'idle':
        if (isSender) {
          status = '已停止分享';
          actions = '';
        } else {
          status = t.resumed
            ? `已保存进度 ${fmtSize(t.bytesDone)} / ${fmtSize(t.meta.size)}，点接收继续`
            : t.expired
              ? (sources ? `历史文件：${sources} 个在线设备持有，可重新接收` : '历史文件：暂无在线设备持有，需重新发布')
              : (sources ? `未接收 · ${sources} 个可用源` : '未接收 · 点击接收后才会开始传输');
          actions = `<button class="btn btn-sm btn-primary" data-action="accept">${t.resumed ? '继续接收' : '接收'}</button>`;
        }
        break;
      case 'running': {
        const s = t.stats || {};
        const rate = s.rate ? fmtSize(s.rate) + '/s' : '测速中';
        const peak = s.peak ? ' · 峰值 ' + fmtSize(s.peak) + '/s' : '';
        const resumed = s.restoredBytes ? ' · 已续传 ' + fmtSize(s.restoredBytes) : '';
        const extra = (s.stalled ? ' · 等待在线源' : '') +
          (s.dupes ? ' · 去重 ' + s.dupes : '') +
          (t.errors ? ' · 异常 ' + t.errors : '');
        if (isSender) {
          status = metric > 0
            ? `供种中${rate}${peak} · 已发送 ${fmtSize(metric)} / ${fmtSize(t.meta.size)}${extra}`
            : '供种中 · 等待对方接收';
        } else {
          const mode = t.mode === 'direct' ? '直连' : 'P2P';
          status = `下载中（${mode}）${rate}${peak} · ${fmtSize(metric)} / ${fmtSize(t.meta.size)} · ${s.sources ?? sources} 源${extra}${resumed}`;
        }
        actions = '<button class="btn btn-sm" data-action="pause">暂停</button><button class="btn btn-sm btn-danger" data-action="cancel">取消</button>';
        break;
      }
      case 'paused':
        status = isSender
          ? `已暂停供种 · 已发送 ${fmtSize(metric)} / ${fmtSize(t.meta.size)}`
          : `已暂停 ${fmtSize(metric)} / ${fmtSize(t.meta.size)}${t.resumed ? ' · 可断点续传' : ''}`;
        actions = '<button class="btn btn-sm btn-primary" data-action="resume">继续</button><button class="btn btn-sm btn-danger" data-action="cancel">取消</button>';
        break;
      case 'done':
        status = t.error ? '完成但组装失败：' + escapeHTML(t.error) : '已完成，文件已保存并可作为下载源供种';
        actions = (t.error ? '' : '<button class="btn btn-sm btn-primary" data-action="save">再次保存</button>') +
          '<button class="btn btn-sm" data-action="clear">清理缓存</button>';
        break;
      default:
        status = '';
    }
    const html = actions
      ? actions.replace(/data-action="([a-z]+)"/g, `data-action="$1" data-fid="${t.fid}"`)
      : '';
    for (const el of els) {
      el.querySelector('.fstatus').textContent = status;
      el.querySelector('.progress > div').style.width = pct + '%';
      el.querySelector('.factions').innerHTML = html;
    }
  }

  toast(msg) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
  }

  openModal(current) {
    this.el.netIdInput.value = current || '';
    this.el.modal.classList.remove('hidden');
  }
  closeModal() { this.el.modal.classList.add('hidden'); }

  openNickModal() {
    this.el.nickModalInput.value = this.nick;
    this.el.nickModal.classList.remove('hidden');
    this.el.nickModalInput.focus();
  }
  closeNickModal() { this.el.nickModal.classList.add('hidden'); }

  openPwdModal() {
    this.el.pwdState.textContent = this.private
      ? '当前：私有房间（加入需要密码）'
      : '当前：公开房间（无需密码）';
    this.el.pwdRemove.classList.toggle('hidden', !this.private);
    this.el.newPwd.value = '';
    this.el.newPwd2.value = '';
    this.el.pwdModal.classList.remove('hidden');
  }
  closePwdModal() { this.el.pwdModal.classList.add('hidden'); }

  fillJoin(rid, focusPwd) {
    this.el.enterRid.value = rid;
    this.el.enterPwd.value = '';
    if (focusPwd) this.el.enterPwd.focus();
  }
}
