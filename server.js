'use strict';
// LAN Camera server.
//
// Two listeners:
//   1. Viewer  http://127.0.0.1:8440  - bound to loopback, so only this PC can
//      open it. Shows the pairing QR and the live feed, controls recording.
//   2. Camera  https://<lan-ip>:8443  - phone side. TLS via the private CA.
//      Only private IPv4 / loopback clients are accepted.
//
// Two kinds of phone client:
//   - Browser page (/cam): video goes phone -> PC browser directly over
//     WebRTC. The server only relays the WebRTC setup messages.
//   - Android app: sends hardware-encoded H.264 + AAC over the WebSocket.
//     The server forwards it to the viewer and can record it to disk.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const certs = require('./lib/certs');
const net = require('./lib/net');
const media = require('./lib/media');
const { Recorder } = require('./lib/recorder');

const VIEWER_PORT = Number(process.env.VIEWER_PORT) || 8440;
const CAM_PORT = Number(process.env.CAM_PORT) || 8443;
const OPEN_BROWSER = !process.argv.includes('--no-open');
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings');

const MAX_FAILS_PER_IP = 5;
const BLOCK_MS = 10 * 60 * 1000;
const MAX_CODE_FAILS = 5;
const AUTH_TIMEOUT_MS = 10 * 1000;
const MAX_PENDING_CAMS = 8;
const MAX_MSG_BYTES = 64 * 1024; // JSON messages (viewer, and phone before login)
const MAX_APP_MSG_BYTES = 4 * 1024 * 1024; // logged-in app (notification lists)
const MAX_NOTIFS = 300;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // one video frame from the app
const VIEWER_BUFFER_LIMIT = 4 * 1024 * 1024; // viewer too slow: skip to next key frame
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ---------------------------------------------------------------- state ---

const state = {
  key: '', // 128-bit secret, carried in the QR code URL fragment
  code: '', // 8-char fallback code for typing by hand
  codeFails: 0,
  locked: false, // when true, only the last paired phone may reconnect
  cameraOn: true, // PC switch: false = phone camera off to save battery
  notifOn: true, // PC switch: show phone notifications in the viewer
  viewer: null,
  cam: null, // ws; ws.kind is 'browser' or 'app'
  lastCamIp: null,
  addresses: [],
};
const fails = new Map(); // ip -> { count, until }

// App stream state (reset when the app disconnects).
function emptyMedia() {
  return {
    sps: null,
    pps: null,
    video: null, // { codec, avcC, width, height, rotation }
    audio: null, // { asc, sampleRate, channels }
    info: { width: 0, height: 0, rotation: 0 },
    audioExpected: false, // app says its mic is on
    viewerNeedsKey: true,
    lastKeyRequest: 0,
  };
}
let mediaState = emptyMedia();

function newKey() {
  state.key = crypto.randomBytes(16).toString('base64url');
}
function newCode() {
  let c = '';
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  state.code = c;
  state.codeFails = 0;
}
newKey();
newCode();

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function parseMessage(raw, isBinary, maxBytes = MAX_MSG_BYTES) {
  if (isBinary || raw.length > maxBytes) return null;
  try {
    const msg = JSON.parse(raw.toString('utf8'));
    return msg && typeof msg === 'object' && typeof msg.type === 'string' ? msg : null;
  } catch {
    return null;
  }
}

const isApp = () => !!state.cam && state.cam.kind === 'app';

// --------------------------------------------------------- certificates ---

const ca = certs.ensureCA();
if (ca.created) {
  log('Created a new private CA in ./data. Run "npm run setup" to install it on your phone.');
}
// The app pins this fingerprint (it comes in the QR code).
const CA_FP = certs.fingerprints(ca.certPem).sha256.replace(/:/g, '').toLowerCase();
const issueLeaf = certs.createLeafFactory(ca);
state.addresses = net.listLanAddresses();

// Send the CA after the leaf so the app can check the whole chain.
function tlsContext() {
  const leaf = issueLeaf(state.addresses.map((a) => a.address));
  return { key: leaf.key, cert: leaf.cert + ca.certPem };
}

// ------------------------------------------------------------ recording ---

const recorder = new Recorder({ dir: RECORDINGS_DIR, log, onChange: () => pushRecordStatus() });

function pushRecordStatus() {
  send(state.viewer, { type: 'record-status', ...recorder.status(), camKind: state.cam ? state.cam.kind : null });
}
setInterval(() => {
  if (recorder.status().active) pushRecordStatus();
  if (recorder.needsKeyframe() && isApp()) requestKeyframe();
}, 1000).unref();

// --------------------------------------------------------- static files ---

const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
const CSP =
  "default-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; " +
  "style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function serveFile(res, file, extraHeaders) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, body) => {
    if (err) {
      res.writeHead(500, BASE_HEADERS);
      return res.end('Server error');
    }
    res.writeHead(200, {
      ...BASE_HEADERS,
      ...extraHeaders,
      'Content-Security-Policy': CSP,
      'Content-Type': TYPES[path.extname(file)],
    });
    res.end(body);
  });
}

function notFound(res) {
  res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// Fixed whitelists: nothing else is ever served.
const VIEWER_ROUTES = { '/': 'viewer.html', '/viewer.js': 'viewer.js', '/style.css': 'style.css' };
const CAM_ROUTES = { '/cam': 'cam.html', '/cam.js': 'cam.js', '/style.css': 'style.css' };

// ------------------------------------------------------- host / origin ----

function viewerHosts() {
  return new Set([`127.0.0.1:${VIEWER_PORT}`, `localhost:${VIEWER_PORT}`]);
}
function camHosts() {
  const s = new Set([`127.0.0.1:${CAM_PORT}`, `localhost:${CAM_PORT}`]);
  for (const a of state.addresses) s.add(`${a.address}:${CAM_PORT}`);
  return s;
}
// Host header check blocks DNS-rebinding; Origin check blocks other web pages
// (in any browser tab) from opening our WebSockets.
function hostOk(req, hosts) {
  return hosts.has(String(req.headers.host || '').toLowerCase());
}
function originOk(req, scheme, hosts) {
  const origin = String(req.headers.origin || '').toLowerCase();
  for (const h of hosts) if (origin === `${scheme}://${h}`) return true;
  return false;
}

// ---------------------------------------------------- app media relay -----

function requestKeyframe() {
  const now = Date.now();
  if (!isApp() || now - mediaState.lastKeyRequest < 500) return;
  mediaState.lastKeyRequest = now;
  send(state.cam, { type: 'keyframe' });
}

// The app streams only while the PC camera switch is on and someone needs
// the video (viewer open or recording): saves phone battery.
function updateStream() {
  if (isApp()) send(state.cam, { type: 'stream', value: state.cameraOn && (!!state.viewer || recorder.wanted) });
}

// PC camera on/off switch.
function setCameraOn(on) {
  if (state.cameraOn === on) return;
  state.cameraOn = on;
  log(on ? 'Camera switched on from PC.' : 'Camera switched off from PC.');
  if (!on && recorder.wanted) {
    recorder.setWanted(false);
    log('Recording stopped (camera off).');
  }
  send(state.viewer, { type: 'camera-state', value: on });
  if (state.cam && state.cam.kind === 'browser') {
    send(state.cam, { type: 'camera', value: on });
    if (on && state.viewer) send(state.cam, { type: 'start' });
  }
  updateStream();
}

function mediaConfigMessage() {
  const v = mediaState.video;
  const a = mediaState.audio;
  return {
    type: 'media-config',
    video: v && { codec: v.codec, description: v.avcC.toString('base64'), width: v.width, height: v.height, rotation: v.rotation },
    audio: a && { codec: 'mp4a.40.2', description: a.asc.toString('base64'), sampleRate: a.sampleRate, channels: a.channels },
  };
}

function pushMediaConfig() {
  if (!state.viewer) return;
  send(state.viewer, mediaConfigMessage());
  mediaState.viewerNeedsKey = true;
  requestKeyframe();
}

function rebuildVideoConfig() {
  const m = mediaState;
  // Wait for both the codec config and the frame size from 'stream-info'.
  if (!m.sps || !m.pps || !m.info.width || !m.info.height) return;
  const next = {
    codec: media.avcCodecString(m.sps),
    avcC: media.buildAvcC(m.sps, m.pps),
    width: m.info.width,
    height: m.info.height,
    rotation: m.info.rotation,
  };
  const prev = m.video;
  const same =
    prev &&
    prev.avcC.equals(next.avcC) &&
    prev.width === next.width &&
    prev.height === next.height &&
    prev.rotation === next.rotation;
  if (same) return;
  m.video = next;
  recorder.finish(); // new format: next key frame starts a new file part
  pushMediaConfig();
}

function relay(type, key, pts, data) {
  const v = state.viewer;
  if (!v || v.readyState !== 1) return;
  if (v.bufferedAmount > VIEWER_BUFFER_LIMIT) {
    mediaState.viewerNeedsKey = true;
    requestKeyframe();
    return;
  }
  if (type === media.TYPE_VIDEO) {
    if (mediaState.viewerNeedsKey && !key) return;
    if (key) mediaState.viewerNeedsKey = false;
  }
  v.send(media.makePacket(type, key ? media.FLAG_KEY : 0, pts, data));
}

function handleAppMedia(buf) {
  const p = media.parsePacket(buf);
  if (!p) return;
  if (p.type === media.TYPE_VIDEO) {
    const nals = media.splitAnnexB(p.data);
    const sps = nals.find((n) => media.nalType(n) === media.NAL_SPS);
    const pps = nals.find((n) => media.nalType(n) === media.NAL_PPS);
    if (sps && pps) {
      mediaState.sps = Buffer.from(sps);
      mediaState.pps = Buffer.from(pps);
      rebuildVideoConfig();
    }
    if (p.config || !mediaState.video) return;
    const frame = media.toAvcc(nals);
    if (!frame.length) return;
    const key = p.key || nals.some((n) => media.nalType(n) === media.NAL_IDR);
    relay(media.TYPE_VIDEO, key, p.pts, frame);
    recorder.onVideo(p.pts, key, frame, { video: mediaState.video, audio: mediaState.audio, audioExpected: mediaState.audioExpected });
  } else {
    if (p.config) {
      const asc = Buffer.from(p.data);
      const info = media.parseAsc(asc);
      if (!info) return;
      if (!mediaState.audio || !mediaState.audio.asc.equals(asc)) {
        mediaState.audio = { asc, ...info };
        pushMediaConfig();
      }
      return;
    }
    if (!mediaState.audio) return;
    relay(media.TYPE_AUDIO, true, p.pts, p.data);
    recorder.onAudio(p.pts, p.data);
  }
}

function handleStreamInfo(msg) {
  const int = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : 0);
  const info = { width: int(msg.width, 8192), height: int(msg.height, 8192), rotation: [0, 90, 180, 270].includes(msg.rotation) ? msg.rotation : 0 };
  mediaState.info = info;
  mediaState.audioExpected = msg.audio === true;
  if (msg.audio === false && mediaState.audio) {
    mediaState.audio = null;
    recorder.finish();
    pushMediaConfig();
  }
  rebuildVideoConfig();
}

// ------------------------------------------------- phone notifications ---
// Held in memory only: never written to disk, never logged. Cleared when the
// phone disconnects or the PC switch is turned off.

const notifs = new Map(); // key -> notification
const notifIcons = new Map(); // package -> base64 PNG
let notifAccess = null; // app reports whether Android notification access is granted

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function cleanNotif(n) {
  if (!n || typeof n !== 'object' || typeof n.key !== 'string' || !n.key) return null;
  return {
    key: n.key.slice(0, 300),
    pkg: str(n.pkg, 200),
    app: str(n.app, 100),
    title: str(n.title, 300),
    text: str(n.text, 3000),
    sub: str(n.sub, 200),
    time: Number.isFinite(n.time) ? n.time : Date.now(),
    ongoing: n.ongoing === true,
  };
}

function trimNotifs() {
  if (notifs.size <= MAX_NOTIFS) return;
  const oldest = [...notifs.values()].sort((a, b) => a.time - b.time).slice(0, notifs.size - MAX_NOTIFS);
  for (const n of oldest) notifs.delete(n.key);
}

function clearNotifs() {
  notifs.clear();
  notifIcons.clear();
}

function pushNotifs(ws = state.viewer) {
  send(ws, {
    type: 'notif-list',
    on: state.notifOn,
    access: notifAccess,
    items: [...notifs.values()].sort((a, b) => b.time - a.time),
    icons: Object.fromEntries(notifIcons),
  });
}

function handleAppNotif(msg) {
  if (!state.notifOn) return;
  if (msg.type === 'notif-list') {
    notifs.clear();
    for (const raw of Array.isArray(msg.items) ? msg.items.slice(0, MAX_NOTIFS) : []) {
      const n = cleanNotif(raw);
      if (n) notifs.set(n.key, n);
    }
    pushNotifs();
  } else if (msg.type === 'notif-posted') {
    const n = cleanNotif(msg.n);
    if (!n) return;
    notifs.set(n.key, n);
    trimNotifs();
    send(state.viewer, { type: 'notif-posted', n });
  } else if (msg.type === 'notif-removed') {
    if (typeof msg.key === 'string' && notifs.delete(msg.key)) send(state.viewer, { type: 'notif-removed', key: msg.key });
  } else if (msg.type === 'notif-icon') {
    // Base64 PNG only, small: shown as <img src="data:image/png;base64,...">.
    if (typeof msg.pkg !== 'string' || typeof msg.png !== 'string') return;
    if (msg.png.length > 40000 || !/^[A-Za-z0-9+/=]+$/.test(msg.png)) return;
    const pkg = msg.pkg.slice(0, 200);
    notifIcons.set(pkg, msg.png);
    send(state.viewer, { type: 'notif-icon', pkg, png: msg.png });
  }
}

function setNotifOn(on) {
  if (state.notifOn === on) return;
  state.notifOn = on;
  if (!on) clearNotifs();
  if (isApp()) send(state.cam, { type: 'notifications', value: on });
  pushNotifs();
}

// ---------------------------------------------------------- viewer side ---

const viewerHttp = http.createServer((req, res) => {
  if (!net.isLoopback(req.socket.remoteAddress) || !hostOk(req, viewerHosts())) return notFound(res);
  if (req.method !== 'GET') return notFound(res);
  const file = VIEWER_ROUTES[new URL(req.url, 'http://x').pathname];
  if (!file) return notFound(res);
  serveFile(res, file, { 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
});

const viewerWss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

viewerHttp.on('upgrade', (req, socket, head) => {
  const ok =
    net.isLoopback(req.socket.remoteAddress) &&
    new URL(req.url, 'http://x').pathname === '/ws' &&
    hostOk(req, viewerHosts()) &&
    originOk(req, 'http', viewerHosts());
  if (!ok) return socket.destroy();
  viewerWss.handleUpgrade(req, socket, head, (ws) => viewerWss.emit('connection', ws));
});

async function pairingMessage() {
  const shown = net.pairingAddresses(state.addresses);
  const urls = await Promise.all(
    shown.map(async (a) => {
      const base = `https://${a.address}:${CAM_PORT}/cam`;
      // k = pairing key, fp = CA fingerprint (pinned by the Android app).
      const url = `${base}#k=${state.key}&fp=${CA_FP}`;
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return {
        ip: a.address,
        iface: a.name,
        base,
        qr: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'),
      };
    })
  );
  return {
    type: 'pairing',
    urls,
    code: `${state.code.slice(0, 4)}-${state.code.slice(4)}`,
    locked: state.locked,
  };
}

async function pushPairing() {
  if (!state.viewer) return;
  try {
    send(state.viewer, await pairingMessage());
  } catch (err) {
    log('QR generation failed:', err.message);
  }
}

function camLeft(cam) {
  if (cam.kind === 'app') {
    mediaState = emptyMedia();
    recorder.finish();
    clearNotifs();
    notifAccess = null;
    pushNotifs();
  }
  send(state.viewer, { type: 'cam-left' });
  pushRecordStatus();
}

function kickCam(reason) {
  const cam = state.cam;
  if (!cam) return;
  state.cam = null;
  send(cam, { type: 'kicked', reason });
  cam.close(4002, reason);
  camLeft(cam);
  log(`Camera ${cam.ip} disconnected (${reason}).`);
}

function openRecordingsFolder() {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  if (process.platform === 'win32') execFile('explorer.exe', [RECORDINGS_DIR], () => {});
}

viewerWss.on('connection', (ws) => {
  if (state.viewer) {
    send(state.viewer, { type: 'replaced' });
    state.viewer.close(4001, 'replaced');
  }
  state.viewer = ws;
  log('Viewer opened.');
  pushPairing();
  pushRecordStatus();
  send(ws, { type: 'camera-state', value: state.cameraOn });
  pushNotifs(ws);
  if (state.cam) {
    send(ws, { type: 'cam-joined', ip: state.cam.ip, kind: state.cam.kind });
    if (state.cam.kind === 'browser' && state.cameraOn) send(state.cam, { type: 'start' });
    else if (mediaState.video || mediaState.audio) pushMediaConfig();
  }
  updateStream();

  ws.on('message', (raw, isBinary) => {
    if (ws !== state.viewer) return;
    const msg = parseMessage(raw, isBinary);
    if (!msg) return;
    switch (msg.type) {
      case 'signal':
        if (msg.data && typeof msg.data === 'object') send(state.cam, { type: 'signal', data: msg.data });
        break;
      case 'kick':
        kickCam('disconnected from PC');
        break;
      case 'rotate':
        newKey();
        newCode();
        kickCam('pairing key changed');
        state.lastCamIp = null;
        log('Pairing key rotated.');
        pushPairing();
        break;
      case 'lock':
        state.locked = !!msg.value;
        log(state.locked ? 'Pairing locked.' : 'Pairing unlocked.');
        pushPairing();
        break;
      case 'settings':
        // Viewer asks phone to change camera settings.
        if (msg.data && typeof msg.data === 'object') send(state.cam, { type: 'settings', data: msg.data });
        break;
      case 'keyframe':
        // Viewer decoder lost track: needs a fresh key frame.
        mediaState.viewerNeedsKey = true;
        requestKeyframe();
        break;
      case 'camera':
        setCameraOn(!!msg.value);
        break;
      case 'notifications':
        setNotifOn(!!msg.value);
        break;
      case 'record':
        if (msg.value) setCameraOn(true); // recording needs the camera
        recorder.setWanted(!!msg.value);
        log(msg.value ? 'Recording requested.' : 'Recording stopped.');
        updateStream();
        if (msg.value) requestKeyframe();
        break;
      case 'open-recordings':
        openRecordingsFolder();
        break;
    }
  });

  ws.on('close', () => {
    if (state.viewer !== ws) return;
    state.viewer = null;
    if (state.cam && state.cam.kind === 'browser') send(state.cam, { type: 'viewer-left' });
    updateStream();
    log('Viewer closed.');
  });
});

// ---------------------------------------------------------- camera side ---

const camHttps = https.createServer({ ...tlsContext(), minVersion: 'TLSv1.2' }, (req, res) => {
  if (!hostOk(req, camHosts())) return notFound(res);
  if (req.method !== 'GET') return notFound(res);
  const file = CAM_ROUTES[new URL(req.url, 'https://x').pathname];
  if (!file) return notFound(res);
  serveFile(res, file, { 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()' });
});

// Drop any connection that does not come from a private/loopback address,
// before TLS even starts.
camHttps.on('connection', (socket) => {
  if (!net.isAllowedClient(socket.remoteAddress)) socket.destroy();
});
camHttps.on('tlsClientError', () => {}); // phones probing, cert not yet trusted, etc.

const camWss = new WebSocketServer({ noServer: true, maxPayload: MAX_MEDIA_BYTES });
let pendingCams = 0;

camHttps.on('upgrade', (req, socket, head) => {
  const ip = net.toV4(req.socket.remoteAddress);
  const ok =
    net.isAllowedClient(ip) &&
    new URL(req.url, 'https://x').pathname === '/ws' &&
    hostOk(req, camHosts()) &&
    originOk(req, 'https', camHosts()) &&
    pendingCams < MAX_PENDING_CAMS;
  if (!ok) return socket.destroy();
  camWss.handleUpgrade(req, socket, head, (ws) => camWss.emit('connection', ws, ip));
});

function blockedUntil(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now() ? f.until : 0;
}

function recordFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS_PER_IP) {
    f.until = Date.now() + BLOCK_MS;
    f.count = 0;
    log(`Blocked ${ip} for 10 minutes after repeated wrong keys.`);
  }
  fails.set(ip, f);
}

function rejectCam(ws, reason) {
  send(ws, { type: 'auth-fail', reason });
  ws.close(4003, reason);
}

function handleAuth(ws, msg, nonce) {
  const ip = ws.ip;
  if (blockedUntil(ip)) return rejectCam(ws, 'blocked');

  const secret = msg.method === 'key' ? state.key : msg.method === 'code' ? state.code : null;
  let ok = false;
  if (secret && typeof msg.mac === 'string' && /^[0-9a-f]{64}$/.test(msg.mac)) {
    const expected = crypto.createHmac('sha256', secret).update(nonce).digest();
    ok = crypto.timingSafeEqual(expected, Buffer.from(msg.mac, 'hex'));
  }

  if (!ok) {
    recordFail(ip);
    if (msg.method === 'code') {
      state.codeFails += 1;
      if (state.codeFails >= MAX_CODE_FAILS) {
        newCode();
        log('Too many wrong codes. Code changed.');
        pushPairing();
      }
    }
    log(`Rejected camera from ${ip}: wrong ${msg.method === 'code' ? 'code' : 'key'}.`);
    return rejectCam(ws, 'bad-key');
  }
  fails.delete(ip);

  if (state.locked && ip !== state.lastCamIp) {
    log(`Rejected camera from ${ip}: pairing locked.`);
    return rejectCam(ws, 'locked');
  }
  if (state.cam && state.cam !== ws) {
    if (state.cam.ip !== ip) {
      log(`Rejected camera from ${ip}: another phone is connected.`);
      return rejectCam(ws, 'busy');
    }
    // Same phone reconnecting (e.g. Wi-Fi blip, or switching app <-> browser):
    // replace the old connection.
    const old = state.cam;
    state.cam = null;
    send(old, { type: 'replaced' });
    old.close(4001, 'replaced');
    camLeft(old);
  }

  ws.authed = true;
  ws.kind = msg.client === 'app' ? 'app' : 'browser';
  state.cam = ws;
  state.lastCamIp = ip;
  if (ws.kind === 'app') mediaState = emptyMedia();
  // A typed code is single-use: hand the phone the long key for reconnects,
  // then change the code.
  send(ws, {
    type: 'auth-ok',
    key: msg.method === 'code' ? state.key : undefined,
    // App paired by typed code has no QR fingerprint yet: give it one to pin.
    caFp: ws.kind === 'app' ? CA_FP : undefined,
  });
  if (msg.method === 'code') newCode();
  log(`Camera connected from ${ip} (${ws.kind === 'app' ? 'Android app' : 'browser'}).`);
  send(state.viewer, { type: 'cam-joined', ip, kind: ws.kind });
  pushPairing();
  pushRecordStatus();
  if (ws.kind === 'browser') {
    send(ws, { type: 'camera', value: state.cameraOn });
    if (state.viewer && state.cameraOn) send(ws, { type: 'start' });
  } else {
    send(ws, { type: 'notifications', value: state.notifOn });
    updateStream();
  }
}

camWss.on('connection', (ws, ip) => {
  ws.ip = ip;
  ws.authed = false;
  ws.isAlive = true;
  pendingCams += 1;
  let pending = true;
  const donePending = () => {
    if (pending) {
      pending = false;
      pendingCams -= 1;
    }
  };

  const nonce = crypto.randomBytes(32).toString('hex');
  send(ws, { type: 'challenge', nonce });
  const authTimer = setTimeout(() => ws.terminate(), AUTH_TIMEOUT_MS);

  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      // Media is only accepted from the authenticated Android app.
      if (ws.authed && ws === state.cam && ws.kind === 'app') handleAppMedia(raw);
      else ws.terminate();
      return;
    }
    const limit = ws.authed && ws.kind === 'app' ? MAX_APP_MSG_BYTES : MAX_MSG_BYTES;
    const msg = parseMessage(raw, false, limit);
    if (!msg) return ws.terminate();
    if (!ws.authed) {
      // Exactly one auth attempt per connection.
      clearTimeout(authTimer);
      donePending();
      if (msg.type !== 'auth') return ws.terminate();
      return handleAuth(ws, msg, nonce);
    }
    if (ws !== state.cam) return ws.terminate();
    switch (msg.type) {
      case 'signal':
        if (ws.kind === 'browser' && msg.data && typeof msg.data === 'object') send(state.viewer, { type: 'signal', data: msg.data });
        break;
      case 'stream-info':
        if (ws.kind === 'app') handleStreamInfo(msg);
        break;
      case 'notif-list':
      case 'notif-posted':
      case 'notif-removed':
      case 'notif-icon':
        if (ws.kind === 'app') handleAppNotif(msg);
        break;
      case 'status':
        if (ws.kind === 'app' && typeof msg.notifAccess === 'boolean' && msg.notifAccess !== notifAccess) {
          notifAccess = msg.notifAccess;
          pushNotifs();
        }
        send(state.viewer, {
          type: 'cam-status',
          kind: ws.kind,
          state: String(msg.state || '').slice(0, 32),
          battery: typeof msg.battery === 'number' ? msg.battery : null,
          charging: typeof msg.charging === 'boolean' ? msg.charging : null,
          caps: msg.caps && typeof msg.caps === 'object' ? msg.caps : null,
          settings: msg.settings && typeof msg.settings === 'object' ? msg.settings : null,
        });
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    donePending();
    if (state.cam === ws) {
      state.cam = null;
      camLeft(ws);
      log(`Camera ${ip} left.`);
    }
  });
  ws.on('error', () => {});
});

// Detect dead phone connections (e.g. phone walked out of Wi-Fi range).
setInterval(() => {
  for (const ws of camWss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000).unref();

// ------------------------------------------------- address changes -------

function printUrls() {
  const shown = net.pairingAddresses(state.addresses);
  if (!shown.length) {
    log('No LAN address found. Connect this PC to Wi-Fi or to the phone hotspot.');
    return;
  }
  for (const a of shown) log(`Phone page: https://${a.address}:${CAM_PORT}/cam   (${a.name})`);
}

net.watchAddresses((list) => {
  state.addresses = list;
  camHttps.setSecureContext(tlsContext());
  log('Network changed. New certificate issued.');
  printUrls();
  pushPairing();
});

// --------------------------------------------------------------- start ----

viewerHttp.listen(VIEWER_PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${VIEWER_PORT}/`;
  log(`Viewer (this PC only): ${url}`);
  if (OPEN_BROWSER && process.platform === 'win32') exec(`start "" "${url}"`);
});
camHttps.listen(CAM_PORT, '0.0.0.0', () => {
  log(`Camera server listening on port ${CAM_PORT}.`);
  log(`Recordings folder: ${RECORDINGS_DIR}${recorder.ffmpeg ? '' : ' (ffmpeg not found: recordings stay .mkv)'}`);
  printUrls();
});

for (const srv of [viewerHttp, camHttps]) {
  srv.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });
}

// Finish any recording (close file, convert to MP4) before exiting.
let stopping = false;
process.on('SIGINT', async () => {
  if (stopping) process.exit(1);
  stopping = true;
  log('Stopping. Saving recording if any...');
  const timeout = setTimeout(() => process.exit(1), 60000);
  await recorder.flushAll();
  clearTimeout(timeout);
  process.exit(0);
});
