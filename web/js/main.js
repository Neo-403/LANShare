import { Net } from './net.js';
import { Mesh } from './rtc.js';
import { RoomState } from './room.js';
import { FileMesh } from './file.js';
import { UI } from './ui.js';
import { detectLAN, randHex, RESUME_KEY } from './util.js';
import { randomRoomKey, deriveRoomKey, wrapRoomKey } from './crypto.js';

const ui = new UI();
const net = new Net();

let self = '';
let nick = localStorage.getItem('lanshare.nick') || '';
let netId = localStorage.getItem('lanshare.netId') || '';
let lan = '';
let lanReady = null;
let ice = { iceServers: [], noIceServers: true };
let scope = { kind: 'approx', label: '推测同网' };
let mesh = null;
let room = null;
let files = null;
let joinedInfo = null;
let pendingPassword = '';
let pendingKeyBytes = null; // 仅创建房间时由本端生成的会话密钥
let pendingEnterKey = null; // enter 预生成；只有服务端确认「新建」才成为会话密钥
let seedOnCellular = localStorage.getItem('lanshare.seedCellular') === '1';
let listTimer = 0;
let lastRoomName = '';
let resumeInfo = null;   // 仅本标签页有效：断线/重载后自动重进房
let entering = false;    // 进房流程进行中：避免「自身 hello 触发的 welcome」再触发一次进房
let wakeLock = null;
let wakeWanted = false;

try { resumeInfo = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null'); } catch { resumeInfo = null; }

function saveResume(rid, pwd, name) {
  resumeInfo = { rid, pwd, name };
  try { sessionStorage.setItem(RESUME_KEY, JSON.stringify(resumeInfo)); } catch { /* 隐私模式 */ }
}
function clearResume() {
  resumeInfo = null;
  try { sessionStorage.removeItem(RESUME_KEY); } catch { /* 隐私模式 */ }
}

// 传输期间保持屏幕常亮：手机息屏会冻结 JS 定时器与网络，直接断流。
// Wake Lock 需要安全上下文（HTTPS / localhost），不支持时静默降级为「落盘续传」。
async function requestWakeLock() {
  if (!wakeWanted || wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; ui.setWakeLock(false); });
    ui.setWakeLock(true);
  } catch { ui.setWakeLock(false); }
}
function setTransferActive(on) {
  wakeWanted = on;
  if (!on) {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    ui.setWakeLock(false);
  } else if (!('wakeLock' in navigator)) {
    ui.setWakeLock(true, false);
  } else {
    requestWakeLock();
  }
}

// 房间号/密码放在 fragment 中：不经过服务端、不落日志、不出现在 Referer。
function parseShare() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const rid = (p.get('rid') || '').trim().toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{6}$/.test(rid)) return null;
  return { rid, pwd: p.get('pwd') || '' };
}

function shareLink() {
  let h = 'rid=' + encodeURIComponent(joinedInfo?.rid || room?.rid || '');
  if (pendingPassword) h += '&pwd=' + encodeURIComponent(pendingPassword);
  return location.origin + location.pathname + '#' + h;
}

const autoJoin = parseShare();
let autoJoinDone = false;

ui.el.nickInput.value = nick;
document.getElementById('seedOnCellular').checked = seedOnCellular;
ui.setScope('检测网络中…', 'approx');

function identity() { return { nick, netId, lan }; }

function pollRooms() {
  clearInterval(listTimer);
  net.send({ t: 'list' });
  listTimer = setInterval(() => {
    if (!room) net.send({ t: 'list' });
  }, 5000);
}

// 连续重连时可能有多个 teardown，必须串成链：后一次恢复进度要等前一次写完。
let pendingPersist = Promise.resolve();

function teardown() {
  const oldFiles = files;
  const persisted = pendingPersist
    .then(() => (oldFiles ? oldFiles.dispose() : Promise.resolve()))
    .catch(() => {});
  pendingPersist = persisted;
  if (room) room.reset();
  ui.file = null;
  mesh = null; room = null; files = null; joinedInfo = null;
  setTransferActive(false);
  ui.el.messages.innerHTML = '';
  return persisted;
}

function leaveRoom(notify = true) {
  if (notify) net.send({ t: 'leave' });
  clearResume();
  // 主动离开不是断线：进度保存为暂停，下次进房由用户决定要不要继续。
  if (files) for (const t of files.transfers.values()) {
    if (t.state === 'running') t.state = 'paused';
  }
  teardown();
  ui.showView('home');
  pollRooms();
}

function doJoin(rid, password) {
  if (!rid) { ui.toast('请输入房间号'); return; }
  if (room) leaveRoom();
  nick = ui.el.nickInput.value.trim() || nick;
  localStorage.setItem('lanshare.nick', nick);
  pendingPassword = password || '';
  pendingKeyBytes = null;
  saveResume(rid, pendingPassword, '');
  entering = true;
  net.send({ t: 'hello', v: 1, ...identity() });
  net.send({ t: 'join', rid, password: pendingPassword, netId, lan });
}

// 单一入口：指定房间号交给服务端判定「已存在则加入 / 不存在则新建」；
// 留空则沿用随机新建。enter 需要预生成密钥材料，但只有服务端回 created 才采用它。
async function doEnter(rid, password, name, n) {
  nick = n || nick;
  localStorage.setItem('lanshare.nick', nick);
  if (room) leaveRoom();
  pendingPassword = password || '';
  pendingKeyBytes = null;
  pendingEnterKey = null;
  lastRoomName = name || '';
  saveResume(rid, pendingPassword, lastRoomName);
  entering = true;
  const bytes = randomRoomKey();
  const keySalt = randHex(16);
  let encKey = '';
  try {
    if (pendingPassword) {
      const kek = await deriveRoomKey(pendingPassword, keySalt);
      encKey = JSON.stringify(await wrapRoomKey(kek, bytes));
    }
  } catch (e) { ui.toast('进入房间失败：' + e.message); return; }
  net.send({ t: 'hello', v: 1, ...identity() });
  if (!rid) {
    pendingKeyBytes = bytes; // 随机新建必然走 create
    net.send({ t: 'create', name, password: pendingPassword, netId, lan, keySalt, encKey });
    return;
  }
  pendingEnterKey = bytes;
  net.send({ t: 'enter', rid, name, password: pendingPassword, netId, lan, keySalt, encKey });
}

function isHost() { return !!room && room.host === self; }

function wireRoom() {
  room.on('members', list => ui.renderPeers(list, room.host, isHost()));
  room.on('message', item => ui.addMessage(item));
  // 历史同步只回传卡片，必须为每个历史文件补建 leecher，
  // 否则卡片有记录却没有 transfer，accept / file_have / schedule 全部拿不到目标。
  room.on('history', items => {
    if (files) {
      for (const it of items) {
        if (it.t === 'file_offer' && it.file?.fid) files.registerOffer(it);
      }
    }
    ui.renderHistory(items);
  });
  room.on('system', text => ui.addSystem(text));
  room.on('ctrl', (from, obj) => files.handleCtrl(from, obj).catch(e => console.warn('[file]', e)));
  room.on('wsonly', on => ui.toast(on
    ? '打洞失败，已切换到服务器中继（聊天与文件可用，速度受服务器带宽限制）'
    : '已恢复 P2P 连接'));
  files.on('update', t => ui.updateTransfer(t));
  files.on('activity', on => setTransferActive(on));
  mesh.on('peers', () => { if (room) ui.renderPeers(room.memberList(), room.host, isHost()); });
}

async function onJoined(m) {
  entering = false;
  await teardown();
  saveResume(m.rid, pendingPassword, lastRoomName);
  joinedInfo = m;
  if (m.nick) {
    nick = m.nick; // 服务端保证房间内唯一后的最终昵称
    localStorage.setItem('lanshare.nick', nick);
    ui.setNick(nick);
  }
  mesh = new Mesh(net, m.ice || ice, self);
  room = new RoomState(net, mesh, self, nick);
  files = new FileMesh(mesh, room, { seedOnCellular: () => seedOnCellular });
  ui.self = self;
  ui.file = files;
  wireRoom();
  room.init(m);
  for (const p of m.peers || []) mesh.addPeer(p.id, p.nick, p.sameLan);

  // 建立会话密钥：创建者用自己生成的；加入者从 encKey 解包或向 syncFrom 索取。
  let keyReady = false;
  try {
    if (pendingKeyBytes) {
      await room.adoptKey(pendingKeyBytes);
      keyReady = true;
    } else {
      keyReady = await room.applyJoinedKey(m, pendingPassword);
    }
  } catch (e) {
    ui.toast('房间密钥建立失败：' + e.message);
  }
  pendingKeyBytes = null;
  if (m.private && !keyReady) ui.toast('缺少房间密码，无法读取本房间内容');

  ui.setRoomInfo(m, m.host === self);
  ui.showView('chat');
  ui.addSystem(`已加入房间 ${m.rid} · ${m.private ? '私有（端到端加密）' : '公开（DTLS 链路加密）'}`);
  ui.renderPeers(room.memberList(), room.host, isHost());
  if (keyReady && m.syncFrom) room.requestSync(m.syncFrom).catch(() => {});
  clearInterval(listTimer);
}

function wireNet() {
  net.on('open', () => {
    ui.setConn('检测网络中…');
    ui.setReady(false);
    net.send({ t: 'hello', v: 1, ...identity() });
    if (!lanReady) lanReady = detectLAN();
    lanReady.then(v => {
      lan = v;
      net.send({ t: 'bindnet', netId });
    });
  });
  net.on('close', () => {
    ui.setConn('连接断开，重连中…', false, true);
    ui.setReady(false);
    // 断线瞬间把进度写盘，避免手机被系统冻结后丢失已收的数据。
    files?.persistAll().catch(() => {});
  });

  net.on('welcome', m => {
    self = m.peerId;
    ice = m.ice || ice;
    scope = m.scope || scope;
    if (m.nick) {
      nick = m.nick;
      localStorage.setItem('lanshare.nick', nick);
      ui.setNick(nick);
    }
    ui.setConn('已连接', true);
    ui.setReady(true);
    ui.setScope(scope.label, scope.kind);
    pollRooms();
    // 这条 welcome 可能是我们对自身 hello 的应答（进房/重进房流程中发出的）。
    // 若是，不要再触发一次进房，否则会形成 hello→welcome→doEnter→hello 死循环。
    if (entering) return;
    // WS 重连不等于会话恢复：服务端已把旧连接移出房间，需要重新 enter。
    // 房间号/密码留在 sessionStorage，重连或页面被系统重载后自动进房，
    // 传输进度由 IndexedDB 按 fid 恢复，用户无需再点「接收」。
    const wasInRoom = !!room;
    if (wasInRoom) teardown();
    if (autoJoin && !autoJoinDone) {
      autoJoinDone = true;
      ui.toast('正在通过分享链接加入 ' + autoJoin.rid + ' …');
      doEnter(autoJoin.rid, autoJoin.pwd, '', '');
    } else if (resumeInfo?.rid) {
      ui.toast(`正在恢复房间 ${resumeInfo.rid} …`);
      doEnter(resumeInfo.rid, resumeInfo.pwd, resumeInfo.name || '', '');
    } else if (wasInRoom) {
      ui.showView('home');
      ui.toast('连接已恢复，请重新加入房间');
    }
  });
  net.on('scope', m => {
    scope = { key: m.key, kind: m.kind, label: m.label };
    ui.setScope(m.label, m.kind);
  });
  net.on('roomlist', m => { if (!room) ui.renderRooms(m.rooms || []); });
  net.on('created', m => {
    // 只有「新建」才会收到 created；加入已存在房间时不采用预生成密钥。
    entering = false;
    if (pendingEnterKey) pendingKeyBytes = pendingEnterKey;
    pendingEnterKey = null;
    saveResume(m.rid, pendingPassword, lastRoomName);
    ui.toast(`房间 ${m.rid} 已创建`);
  });
  net.on('joined', m => onJoined(m).catch(e => ui.toast('进入房间失败：' + e.message)));
  net.on('signal', m => mesh?.onSignal(m.from, m.data || {}));
  net.on('peer_join', m => room?.addMember(m.peer));
  net.on('peer_leave', m => room?.removeMember(m.id));
  net.on('peer_nick', m => { if (room) room.setNick(m.id, m.nick); });
  net.on('nick_set', m => {
    nick = m.nick;
    localStorage.setItem('lanshare.nick', nick);
    ui.setNick(nick);
    if (room) room.setNick(self, nick);
    ui.toast('昵称已更新为 ' + nick);
  });
  net.on('room_meta', m => {
    if (!room) return;
    room.private = !!m.private;
    room.salt = m.salt || room.salt;
    if (joinedInfo) joinedInfo.private = !!m.private;
    ui.setPrivate(!!m.private);
    ui.toast(m.private ? '房间已设为私有（在线成员不受影响）' : '房间密码已移除，现为公开');
  });
  net.on('host_changed', m => {
    if (!room) return;
    room.setHost(m.id);
    ui.setRoomInfo(joinedInfo, m.id === self);
    if (room.keyBytes && !room.history.length) room.requestSync(m.id).catch(() => {});
  });
  net.on('kicked', () => { ui.toast('你已被房主移出房间'); leaveRoom(false); });
  net.on('room_closed', () => { ui.toast('房间已解散'); leaveRoom(false); });
  net.on('left', () => {});
  net.on('error', m => {
    entering = false;
    ui.toast(m.msg || '操作失败');
    if (m.code === 'bad_password') ui.el.enterPwd.focus();
  });
  net.on('pong', () => {});
}

ui.bind({
  onEnter: doEnter,
  onShare() {
    if (!room || !joinedInfo) { ui.toast('请先进入房间'); return; }
    ui.openShare(shareLink());
  },
  onRefresh: () => net.send({ t: 'list' }),
  onScopeClick: () => ui.openModal(netId),
  onNetIdSave(v) {
    netId = v;
    if (v) localStorage.setItem('lanshare.netId', v);
    else localStorage.removeItem('lanshare.netId');
    ui.closeModal();
    net.send({ t: 'bindnet', netId: v });
  },
  onRoomClick(rid, isPrivate) {
    ui.fillJoin(rid, isPrivate);
    if (isPrivate) { ui.toast('这是私有房间，请输入密码后加入'); return; }
    doJoin(rid, '');
  },
  onLeave: () => leaveRoom(),
  onCloseRoom() {
    if (confirm('确定解散房间？所有成员将被移出，历史立即消失。')) net.send({ t: 'close_room' });
  },
  onKick(id) {
    if (!room) return;
    net.send({ t: 'kick', id });
  },
  onNickChange(v) {
    if (!v || v === nick) return;
    net.send({ t: 'set_nick', nick: v });
  },
  async onSetPassword(newPwd) {
    if (!isHost()) { ui.toast('只有房主可以修改房间密码'); return; }
    if (!room.keyBytes) { ui.toast('会话密钥尚未就绪，请稍后再试'); return; }
    try {
      const keySalt = randHex(16);
      let encKey = '';
      if (newPwd) {
        const kek = await deriveRoomKey(newPwd, keySalt);
        encKey = JSON.stringify(await wrapRoomKey(kek, room.keyBytes));
      }
      pendingPassword = newPwd; // 之后生成的分享链接必须使用新密码
      net.send({ t: 'set_password', password: newPwd, keySalt, encKey });
      ui.toast('正在更新房间密码…');
    } catch (e) { ui.toast('更新失败：' + e.message); }
  },
  onSendText(text) {
    if (!room) { ui.toast('请先加入房间'); return; }
    room.sendText(text).catch(e => ui.toast('发送失败：' + e.message));
  },
  async onFiles(list) {
    if (!room) { ui.toast('请先加入房间'); return; }
    for (const f of list) {
      try {
        ui.toast(`正在准备 ${f.name} …`);
        await files.createOffer(f);
        ui.toast('文件已发布，等待其它设备点击接收');
      } catch (e) { ui.toast(e.message); }
    }
  },
  onFileAction(action, fid) {
    if (!files) return;
    // 卡片可能先于历史同步回调渲染；兜底从房间历史里补建 transfer，
    // 保证「接收」按钮在任何时序下都能真正启动下载。
    if (!files.get(fid)) {
      const item = room?.history.find(it => it.t === 'file_offer' && it.file?.fid === fid);
      if (item) files.registerOffer(item);
    }
    if (!files.get(fid)) return;
    switch (action) {
      case 'accept': files.accept(fid).catch(e => ui.toast(e.message)); break;
      case 'pause': files.pause(fid); break;
      case 'resume': files.resume(fid); break;
      case 'cancel': files.cancel(fid).catch(() => {}); break;
      case 'save': files.save(files.get(fid)).catch(() => {}); break;
      case 'clear': files.clearCache(fid).catch(() => {}); break;
      default: break;
    }
  },
  onSeedToggle(v) {
    seedOnCellular = v;
    if (v) localStorage.setItem('lanshare.seedCellular', '1');
    else localStorage.removeItem('lanshare.seedCellular');
  },
});

// 息屏 / 切后台 / 页面冻结：先把已收数据落盘，回到前台再恢复推流。
// 传输期间的 Wake Lock 会阻止自动息屏；不支持时至少不会丢进度。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    files?.persistAll().catch(() => {});
  } else {
    if (wakeWanted) requestWakeLock();
    files?.rebalanceAll();
  }
});
window.addEventListener('pagehide', () => { files?.persistAll().catch(() => {}); });
document.addEventListener('freeze', () => { files?.persistAll().catch(() => {}); });

wireNet();
ui.setReady(false);
ui.showView('home');
net.connect();
