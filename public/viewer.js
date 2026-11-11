'use strict';
// PC side: show pairing QR, show the phone's video, control phone, record.
//
// Two phone kinds:
//   browser - video arrives over WebRTC into the <video> element.
//   app     - H.264 + AAC packets arrive over the WebSocket; decoded with
//             WebCodecs and drawn on the <canvas>, sound via Web Audio.
(() => {
  const $ = (id) => document.getElementById(id);
  const VIEW_KEY = 'lancam-view';

  const video = $('video');
  video.disableRemotePlayback = true; // never offer Cast / remote playback for the feed
  const canvas = $('canvas');
  const ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
  let ws = null;
  let pc = null;
  let curSid = null;
  let chain = Promise.resolve();
  let pcAddresses = []; // this PC's LAN IPs (from server), for candidate rewrite
  let camConnected = false;
  let camKind = null; // 'browser' | 'app'
  let camState = '';
  let camSettings = null;
  let locked = false;
  let lastBytes = 0;
  let lastTime = 0;
  let recStatus = null;
  let cameraOn = true; // PC switch; the server tells us its value

  // Phone notifications (Android app only). Shown as plain text only.
  let notifOn = true;
  let notifAccess = null;
  const notifMap = new Map(); // key -> notification
  const notifIcons = new Map(); // package -> base64 PNG
  const notifNew = new Set(); // keys posted while this page is open
  const notifExpanded = new Set();

  // App stream decoding state.
  let vdec = null;
  let adec = null;
  let vcfg = null;
  let acfg = null;
  let streamRotation = 0; // clockwise degrees reported by the phone
  let waitKey = true;
  let frames = 0;
  let mediaBytes = 0;
  let lastFrameAt = 0;
  let statsAt = performance.now();
  let audioCtx = null;
  let soundOn = false;
  let nextAudioTime = 0;

  // black: whether the phone display should be black (browser page only;
  // remembered, and re-applied whenever the phone connects).
  let view = { mirror: false, rotate: 0, black: false };
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY));
    if (v && typeof v.mirror === 'boolean' && [0, 90, 180, 270].includes(v.rotate)) {
      view = { mirror: v.mirror, rotate: v.rotate, black: v.black === true };
    }
  } catch {}

  function saveView() {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {}
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  // Dock buttons have an icon plus a short label.
  function setLabel(id, text) {
    const btn = $(id);
    const lbl = btn.querySelector('.lbl');
    setText(lbl || btn, text);
  }

  function setStatus(text, kind) {
    const el = $('status');
    setText(el, text);
    const cls = 'pill' + (kind ? ' ' + kind : '');
    if (el.className !== cls) el.className = cls;
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function showFor(kind) {
    for (const el of document.querySelectorAll('.app-only')) el.hidden = kind !== 'app';
    for (const el of document.querySelectorAll('.browser-only')) el.hidden = kind === 'app';
    video.hidden = kind === 'app';
    canvas.hidden = kind !== 'app';
    applyView();
  }

  function renderBlackBtn() {
    const btn = $('blackBtn');
    const actual = camSettings && typeof camSettings.black === 'boolean' ? camSettings.black : view.black;
    setText(btn, `Black screen: ${actual ? 'on' : 'off'}`);
    btn.classList.toggle('on', actual);
    btn.disabled = !camConnected;
  }

  function isLive() {
    if (camKind === 'app') return performance.now() - lastFrameAt < 2000;
    return !!pc && pc.connectionState === 'connected';
  }

  // ------------------------------------------------------------ overlay ---

  function updateOverlay() {
    const o = $('overlay');
    let text = '';
    if (!ws || ws.readyState !== 1) text = 'Server not running. Start it with "npm start".';
    else if (!camConnected) text = 'Waiting for phone… Scan the QR code.';
    else if (!cameraOn) text = 'Camera is off to save phone battery. Press Camera below (or C) to turn it on.';
    else if (camState === 'paused')
      text = camKind === 'app' ? 'Camera paused on phone (another app may be using it).' : 'Camera paused on phone (screen locked or browser in background).';
    else if (camState === 'stopped') text = 'Camera stopped on phone.';
    else if (!isLive()) text = 'Phone paired. Starting video…';
    setText($('overlayText'), text);
    o.hidden = !text;
    $('liveBadge').hidden = !(camConnected && cameraOn && isLive() && camState !== 'paused');

    if (!ws || ws.readyState !== 1) setStatus('Server offline', 'bad');
    else if (!camConnected) setStatus('No phone', 'warn');
    else if (!cameraOn) setStatus('Camera off', 'warn');
    else if (isLive() && camState !== 'paused') setStatus('Live', 'ok');
    else setStatus('Phone paired', 'warn');

    $('pairing').hidden = camConnected;
    $('pairedNote').hidden = !camConnected;
    $('kickBtn').disabled = !camConnected;
    for (const id of ['flipBtn', 'resSel', 'fpsSel', 'rateSel', 'orientSel', 'micBtn']) $(id).disabled = !camConnected || !camSettings;
    renderBlackBtn();
    renderRecord();
    renderCameraBtn();
  }

  function renderCameraBtn() {
    const btn = $('camPowerBtn');
    setLabel('camPowerBtn', cameraOn ? 'Camera' : 'Camera off');
    btn.classList.toggle('on', cameraOn);
    btn.disabled = !ws || ws.readyState !== 1;
  }

  // ------------------------------------------------------------ pairing ---

  function renderPairing(msg) {
    const list = $('qrList');
    list.textContent = '';
    pcAddresses = [];
    if (!msg.urls.length) {
      const p = document.createElement('p');
      p.className = 'bad-text';
      p.textContent = 'No network found. Connect this PC to Wi-Fi or to the phone hotspot.';
      list.append(p);
    }
    for (const u of msg.urls) {
      pcAddresses.push(u.ip);
      const card = document.createElement('figure');
      card.className = 'qr';
      const img = document.createElement('img');
      img.src = u.qr;
      img.alt = `QR code for ${u.base}`;
      const cap = document.createElement('figcaption');
      const addr = document.createElement('code');
      addr.textContent = u.base;
      const iface = document.createElement('span');
      iface.className = 'muted';
      iface.textContent = u.iface;
      cap.append(addr, document.createElement('br'), iface);
      card.append(img, cap);
      list.append(card);
    }
    $('code').textContent = msg.code;
    locked = !!msg.locked;
    $('lockBtn').textContent = locked ? 'Unlock pairing' : 'Lock pairing';
    $('lockBtn').classList.toggle('on', locked);
  }

  // ------------------------------------------------------ webrtc (browser) -

  function closePeer() {
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    pc = null;
    curSid = null;
    video.srcObject = null;
    lastBytes = 0;
    showStats('No video.');
  }

  // Chrome hides this PC's IP behind a random "xxxx.local" name in ICE
  // candidates. Phones on a network without multicast (e.g. some hotspots)
  // cannot resolve it, so also send copies with the real LAN IPs.
  function sendCandidate(candidate, sid) {
    if (!candidate) {
      send({ type: 'signal', data: { type: 'candidate', sid, candidate: null } });
      return;
    }
    const init = candidate.toJSON();
    send({ type: 'signal', data: { type: 'candidate', sid, candidate: init } });
    const parts = init.candidate.split(' ');
    if (parts.length > 7 && parts[4].endsWith('.local')) {
      for (const ip of pcAddresses) {
        const copy = parts.slice();
        copy[4] = ip;
        send({ type: 'signal', data: { type: 'candidate', sid, candidate: { ...init, candidate: copy.join(' ') } } });
      }
    }
  }

  async function handleSignal(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'offer' && typeof d.sdp === 'string') {
      closePeer();
      curSid = d.sid;
      const p = new RTCPeerConnection({ iceServers: [] });
      pc = p;
      p.ontrack = (e) => {
        if (pc !== p) return;
        video.srcObject = e.streams[0] || new MediaStream([e.track]);
        video.play().catch(() => {});
      };
      p.onicecandidate = (e) => {
        if (pc === p) sendCandidate(e.candidate, d.sid);
      };
      p.onconnectionstatechange = () => {
        if (pc === p) updateOverlay();
      };
      await p.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      const answer = await p.createAnswer();
      await p.setLocalDescription(answer);
      send({ type: 'signal', data: { type: 'answer', sid: d.sid, sdp: p.localDescription.sdp } });
      updateOverlay();
    } else if (d.type === 'candidate') {
      if (!pc || d.sid !== curSid || !d.candidate) return;
      await pc.addIceCandidate(d.candidate).catch(() => {});
    }
  }

  function onSignal(d) {
    chain = chain.then(() => handleSignal(d)).catch((err) => console.warn('signal error', err));
  }

  // --------------------------------------------------- app stream (WebCodecs)

  function b64(s) {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  }

  function closeVideoDecoder() {
    if (vdec && vdec.state !== 'closed') {
      try {
        vdec.close();
      } catch {}
    }
    vdec = null;
    waitKey = true;
  }

  function closeAudioDecoder() {
    if (adec && adec.state !== 'closed') {
      try {
        adec.close();
      } catch {}
    }
    adec = null;
  }

  function resetAppMedia() {
    closeVideoDecoder();
    closeAudioDecoder();
    vcfg = null;
    acfg = null;
    lastFrameAt = 0;
    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  }

  function makeVideoDecoder() {
    closeVideoDecoder();
    if (!vcfg) return;
    if (!('VideoDecoder' in window)) {
      $('stats').textContent = 'This browser cannot decode the app stream (needs Chrome or Edge).';
      return;
    }
    vdec = new VideoDecoder({
      output: onVideoFrame,
      error: (err) => {
        console.warn('video decoder error', err);
        vdec = null; // recreated at the next key frame
        waitKey = true;
        send({ type: 'keyframe' });
      },
    });
    vdec.configure(vcfg);
    waitKey = true;
  }

  function makeAudioDecoder() {
    closeAudioDecoder();
    if (!acfg || !('AudioDecoder' in window)) return;
    adec = new AudioDecoder({
      output: onAudioData,
      error: (err) => {
        console.warn('audio decoder error', err);
        adec = null;
      },
    });
    adec.configure(acfg);
  }

  function configureMedia(msg) {
    if (msg.video) {
      vcfg = { codec: msg.video.codec, description: b64(msg.video.description), optimizeForLatency: true };
      streamRotation = msg.video.rotation || 0;
      makeVideoDecoder();
      applyView();
    } else {
      closeVideoDecoder();
      vcfg = null;
    }
    if (msg.audio) {
      acfg = { codec: msg.audio.codec, sampleRate: msg.audio.sampleRate, numberOfChannels: msg.audio.channels, description: b64(msg.audio.description) };
      makeAudioDecoder();
    } else {
      closeAudioDecoder();
      acfg = null;
    }
  }

  function onVideoFrame(frame) {
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      applyView();
    }
    ctx2d.drawImage(frame, 0, 0);
    frame.close();
    frames++;
    const wasLive = isLive();
    lastFrameAt = performance.now();
    if (!wasLive) updateOverlay();
  }

  function onAudioData(data) {
    if (!audioCtx || !soundOn) {
      data.close();
      return;
    }
    const n = data.numberOfFrames;
    const ch = data.numberOfChannels;
    const buf = audioCtx.createBuffer(ch, n, data.sampleRate);
    for (let c = 0; c < ch; c++) {
      const tmp = new Float32Array(n);
      data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
      buf.copyToChannel(tmp, c);
    }
    data.close();
    // Small jitter buffer: ~80 ms. Resync if we fall behind or drift ahead.
    const now = audioCtx.currentTime;
    if (nextAudioTime < now + 0.02 || nextAudioTime > now + 0.5) nextAudioTime = now + 0.08;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(nextAudioTime);
    nextAudioTime += buf.duration;
  }

  // Packet: [type u8][flags u8][pts int64 BE, microseconds][payload]
  function onMediaPacket(ab) {
    // Camera switched off on the PC: ignore any frames still in flight.
    if (camKind !== 'app' || !cameraOn || ab.byteLength < 10) return;
    const dv = new DataView(ab);
    const type = dv.getUint8(0);
    const key = (dv.getUint8(1) & 1) !== 0;
    const pts = Number(dv.getBigInt64(2));
    const data = new Uint8Array(ab, 10);
    mediaBytes += ab.byteLength;
    if (type === 1) {
      if (!vcfg) return;
      if (!vdec) makeVideoDecoder();
      if (!vdec) return;
      if (waitKey && !key) return;
      if (vdec.decodeQueueSize > 30) {
        // Decoder cannot keep up: drop and restart from a key frame.
        makeVideoDecoder();
        send({ type: 'keyframe' });
        return;
      }
      waitKey = false;
      vdec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data }));
    } else if (type === 2) {
      if (!soundOn || !acfg) return;
      if (!adec) makeAudioDecoder();
      if (adec) adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: pts, data }));
    }
  }

  function setSound(on) {
    soundOn = on;
    if (on) {
      if (!audioCtx) audioCtx = new AudioContext({ latencyHint: 'interactive' });
      audioCtx.resume().catch(() => {});
      nextAudioTime = 0;
    }
    setLabel('soundBtn', on ? 'Sound' : 'Muted');
    $('soundBtn').classList.toggle('on', on);
  }

  // -------------------------------------------------------------- stats ---

  function showStats(text) {
    setText($('stats'), text);
    setText($('stats2'), text);
  }

  async function updateWebRtcStats() {
    if (!pc || pc.connectionState !== 'connected') return;
    let inbound = null;
    let pair = null;
    const byId = new Map();
    const report = await pc.getStats();
    report.forEach((r) => {
      byId.set(r.id, r);
      if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = r.selectedCandidatePairId;
    });
    if (!inbound) return;
    const now = performance.now();
    const kbps = lastTime && inbound.bytesReceived >= lastBytes ? ((inbound.bytesReceived - lastBytes) * 8) / (now - lastTime) : 0;
    lastBytes = inbound.bytesReceived;
    lastTime = now;
    const codec = byId.get(inbound.codecId);
    const cp = pair && byId.get(pair);
    const remote = cp && byId.get(cp.remoteCandidateId);
    const parts = [
      `${inbound.frameWidth || '?'}×${inbound.frameHeight || '?'}`,
      `${Math.round(inbound.framesPerSecond || 0)} fps`,
      `${(kbps / 1000).toFixed(1)} Mbps`,
      codec ? codec.mimeType.replace('video/', '') : '',
      cp && cp.currentRoundTripTime != null ? `${Math.round(cp.currentRoundTripTime * 1000)} ms RTT` : '',
      remote ? `via ${remote.candidateType} ${remote.address || ''}` : '',
    ];
    showStats(parts.filter(Boolean).join(' · '));
  }

  function updateAppStats() {
    const now = performance.now();
    const secs = (now - statsAt) / 1000;
    statsAt = now;
    const fps = frames / secs;
    const mbps = (mediaBytes * 8) / secs / 1e6;
    frames = 0;
    mediaBytes = 0;
    if (!isLive()) {
      showStats('No video.');
      return;
    }
    const parts = [
      `${canvas.width}×${canvas.height}`,
      `${Math.round(fps)} fps`,
      `${mbps.toFixed(1)} Mbps`,
      'H.264 via app',
      acfg ? (soundOn ? 'sound on' : 'sound off') : 'no mic',
    ];
    showStats(parts.join(' · '));
  }

  setInterval(() => {
    if (camKind === 'app') {
      updateAppStats();
      updateOverlay();
    } else {
      updateWebRtcStats().catch(() => {});
    }
  }, 1000);

  // ------------------------------------------------------- notifications --

  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    const d = new Date(t);
    const sameDay = d.toDateString() === new Date().toDateString();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? hm : `${d.toLocaleDateString()} ${hm}`;
  }

  function renderNotifs() {
    const btn = $('notifBtn');
    btn.textContent = notifOn ? 'On' : 'Off';
    btn.classList.toggle('on', notifOn);
    btn.disabled = !ws || ws.readyState !== 1;

    const items = [...notifMap.values()].sort((a, b) => b.time - a.time);
    let status;
    if (!notifOn) status = 'Off. The phone does not send notifications.';
    else if (notifAccess === false) status = 'Allow notification access in the LAN Camera app on the phone.';
    else if (!items.length) status = 'No notifications.';
    else status = `${items.length} notification${items.length === 1 ? '' : 's'}. Click one to expand.`;
    setText($('notifStatus'), status);
    setText($('notifCount'), notifOn && items.length ? String(items.length) : '');

    const list = $('notifList');
    list.textContent = '';
    for (const n of items) {
      const row = document.createElement('div');
      row.className = 'notif' + (n.ongoing ? ' ongoing' : '') + (notifNew.has(n.key) ? ' new' : '') + (notifExpanded.has(n.key) ? ' expanded' : '');
      const icon = document.createElement('img');
      icon.className = 'notif-icon';
      icon.alt = '';
      const png = notifIcons.get(n.pkg);
      if (png) icon.src = `data:image/png;base64,${png}`;
      const body = document.createElement('div');
      body.className = 'notif-body';
      const meta = document.createElement('div');
      meta.className = 'notif-meta';
      meta.textContent = [n.app || n.pkg, n.sub, ago(n.time)].filter(Boolean).join(' · ');
      const title = document.createElement('div');
      title.className = 'notif-title';
      title.textContent = n.title;
      const text = document.createElement('div');
      text.className = 'notif-text';
      text.textContent = n.text;
      body.append(meta);
      if (n.title) body.append(title);
      if (n.text) body.append(text);
      row.append(icon, body);
      row.addEventListener('click', () => {
        if (notifExpanded.has(n.key)) notifExpanded.delete(n.key);
        else notifExpanded.add(n.key);
        notifNew.delete(n.key);
        renderNotifs();
      });
      list.append(row);
    }
  }
  setInterval(renderNotifs, 30000); // refresh "x min ago"

  // ------------------------------------------------------------ record ----

  function fmtTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  }
  function fmtBytes(b) {
    return b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`;
  }

  function renderRecord() {
    const r = recStatus;
    const btn = $('recordBtn');
    const btn2 = $('recordBtn2');
    btn.disabled = btn2.disabled = !ws || ws.readyState !== 1 || !r;
    if (!r) return;
    setLabel('recordBtn', r.wanted ? 'Stop' : 'Record');
    setText(btn2, r.wanted ? 'Stop recording' : 'Start recording');
    btn.classList.toggle('recording', r.wanted);
    btn2.classList.toggle('recording', r.wanted);
    $('recPill').hidden = !r.active;

    let text;
    if (r.wanted && r.active) text = `Recording ${fmtTime(r.seconds)} · ${fmtBytes(r.bytes)} · ${r.file}`;
    else if (r.wanted && camConnected && camKind === 'browser') text = 'Recording needs the Android app. The browser page cannot be recorded.';
    else if (r.wanted && !camConnected) text = 'Waiting for the phone app. Recording starts when it connects.';
    else if (r.wanted) text = 'Starting recording…';
    else if (r.saving) text = 'Saving recording…';
    else if (r.error) text = `Error: ${r.error}`;
    else if (r.lastFile) text = `Saved: ${r.lastFile}`;
    else text = `Saved on this PC as ${r.mp4 ? 'MP4' : 'MKV (install ffmpeg for MP4)'}. Needs the Android app.`;
    setText($('recStatus'), text);
  }

  // ------------------------------------------------------- phone status ---

  function renderPhoneStatus(msg) {
    camState = msg.state || '';
    if (msg.settings) camSettings = msg.settings;
    const bits = [];
    if (camKind === 'app') bits.push('Android app');
    if (typeof msg.battery === 'number') bits.push(`Battery ${msg.battery}%${msg.charging ? ' (charging)' : ''}`);
    if (camState === 'black') bits.push('Black screen');
    if (camSettings) bits.push(camSettings.facing === 'user' ? 'Front camera' : 'Back camera');
    $('phoneInfo').textContent = bits.join(' · ');

    if (camSettings) {
      $('resSel').value = camSettings.res;
      $('fpsSel').value = String(camSettings.fps);
      $('rateSel').value = String(camSettings.bitrate);
      $('torchBtn').classList.toggle('on', !!camSettings.torch);
      if (camSettings.orientation) $('orientSel').value = camSettings.orientation;
      const micOn = camSettings.audio !== false;
      setLabel('micBtn', micOn ? 'Mic' : 'Mic off');
      $('micBtn').classList.toggle('on', micOn);
    }
    $('torchBtn').disabled = !(msg.caps && msg.caps.torch);
    updateOverlay();
  }

  function phoneSettings(data) {
    send({ type: 'settings', data });
  }

  function camGone() {
    camConnected = false;
    camKind = null;
    camState = '';
    camSettings = null;
    $('phoneInfo').textContent = '';
    $('torchBtn').disabled = true;
    closePeer();
    resetAppMedia();
    showFor(null);
  }

  // ---------------------------------------------------------- websocket ---

  function connect() {
    const sock = new WebSocket(`ws://${location.host}/ws`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    let replaced = false;
    sock.onopen = updateOverlay;
    sock.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        onMediaPacket(ev.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'pairing':
          renderPairing(msg);
          // Let the QR code paint first; pre-warm blocks the page briefly.
          setTimeout(prewarmWebRTC, 300);
          break;
        case 'cam-joined':
          camGone();
          camConnected = true;
          camKind = msg.kind === 'app' ? 'app' : 'browser';
          showFor(camKind);
          $('phoneInfo').textContent = `Phone ${msg.ip}`;
          if (currentTab === 'pair') selectTab('camera', false);
          if (camKind === 'browser') phoneSettings({ black: view.black });
          break;
        case 'cam-left':
          camGone();
          selectTab('pair', false);
          break;
        case 'cam-status':
          renderPhoneStatus(msg);
          break;
        case 'media-config':
          configureMedia(msg);
          break;
        case 'record-status':
          recStatus = msg;
          break;
        case 'notif-list':
          notifOn = msg.on !== false;
          notifAccess = typeof msg.access === 'boolean' ? msg.access : null;
          notifMap.clear();
          for (const n of msg.items || []) notifMap.set(n.key, n);
          notifIcons.clear();
          for (const [pkg, png] of Object.entries(msg.icons || {})) notifIcons.set(pkg, png);
          renderNotifs();
          break;
        case 'notif-posted':
          if (msg.n && msg.n.key) {
            notifMap.set(msg.n.key, msg.n);
            notifNew.add(msg.n.key);
            renderNotifs();
          }
          break;
        case 'notif-removed':
          notifMap.delete(msg.key);
          notifNew.delete(msg.key);
          renderNotifs();
          break;
        case 'notif-icon':
          notifIcons.set(msg.pkg, msg.png);
          renderNotifs();
          break;
        case 'camera-state':
          cameraOn = msg.value !== false;
          if (!cameraOn) {
            closePeer();
            // Keep the decoder setup (same stream resumes later); just blank the picture.
            lastFrameAt = 0;
            waitKey = true;
            ctx2d.fillStyle = '#000';
            ctx2d.fillRect(0, 0, canvas.width, canvas.height);
          }
          break;
        case 'signal':
          onSignal(msg.data);
          break;
        case 'replaced':
          replaced = true;
          break;
      }
      updateOverlay();
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      camGone();
      updateOverlay();
      if (replaced) {
        setText($('overlayText'), 'Viewer opened in another tab. Reload to use this one.');
        $('overlay').hidden = false;
        setStatus('Inactive', 'bad');
        return;
      }
      setTimeout(connect, 1500);
    };
  }

  // --------------------------------------------------------------- view ---

  function applyView() {
    const stage = $('stage');
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const el = camKind === 'app' ? canvas : video;
    // App frames come in the sensor's orientation; the phone tells us how
    // far to turn them. User rotation adds on top.
    const rotate = (view.rotate + (camKind === 'app' ? streamRotation : 0)) % 360;
    const sideways = rotate % 180 !== 0;
    el.style.width = `${sideways ? h : w}px`;
    el.style.height = `${sideways ? w : h}px`;
    el.style.transform = `translate(-50%, -50%) rotate(${rotate}deg) scaleX(${view.mirror ? -1 : 1})`;
    $('mirrorBtn').classList.toggle('on', view.mirror);
    saveView();
  }
  new ResizeObserver(applyView).observe($('stage'));

  // ------------------------------------------------------------- wiring ---

  $('fullBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('stage').requestFullscreen().catch(() => {});
  });
  $('stage').addEventListener('dblclick', () => $('fullBtn').click());
  $('mirrorBtn').addEventListener('click', () => {
    view.mirror = !view.mirror;
    applyView();
  });
  $('rotateBtn').addEventListener('click', () => {
    view.rotate = (view.rotate + 90) % 360;
    applyView();
  });
  $('soundBtn').addEventListener('click', () => setSound(!soundOn));
  $('kickBtn').addEventListener('click', () => send({ type: 'kick' }));
  $('rotateKeyBtn').addEventListener('click', () => send({ type: 'rotate' }));
  $('lockBtn').addEventListener('click', () => send({ type: 'lock', value: !locked }));
  $('notifBtn').addEventListener('click', () => send({ type: 'notifications', value: !notifOn }));
  $('camPowerBtn').addEventListener('click', () => send({ type: 'camera', value: !cameraOn }));
  $('recordBtn').addEventListener('click', () => send({ type: 'record', value: !(recStatus && recStatus.wanted) }));
  $('folderBtn').addEventListener('click', () => send({ type: 'open-recordings' }));

  $('flipBtn').addEventListener('click', () => {
    if (camSettings) phoneSettings({ facing: camSettings.facing === 'user' ? 'environment' : 'user' });
  });
  $('torchBtn').addEventListener('click', () => {
    if (camSettings) phoneSettings({ torch: !camSettings.torch });
  });
  $('blackBtn').addEventListener('click', () => {
    const actual = camSettings && typeof camSettings.black === 'boolean' ? camSettings.black : view.black;
    view.black = !actual;
    saveView();
    phoneSettings({ black: view.black });
    renderBlackBtn();
  });
  $('micBtn').addEventListener('click', () => {
    if (camSettings) phoneSettings({ audio: camSettings.audio === false });
  });
  $('orientSel').addEventListener('change', (e) => phoneSettings({ orientation: e.target.value }));
  $('resSel').addEventListener('change', (e) => phoneSettings({ res: e.target.value }));
  $('fpsSel').addEventListener('change', (e) => phoneSettings({ fps: Number(e.target.value) }));
  $('rateSel').addEventListener('change', (e) => phoneSettings({ bitrate: Number(e.target.value) }));

  // The first RTCPeerConnection in a browser process can take seconds to
  // start. Pay that cost now, while waiting for the phone.
  let prewarmed = false;
  function prewarmWebRTC() {
    // Only the browser page uses WebRTC. Skip the freeze when the app is on.
    if (prewarmed || camKind === 'app') return;
    prewarmed = true;
    try {
      const p = new RTCPeerConnection({ iceServers: [] });
      p.addTransceiver('video', { direction: 'recvonly' });
      p.createOffer()
        .catch(() => {})
        .finally(() => p.close());
    } catch {}
  }

  // --------------------------------------------------------------- tabs ---

  const TAB_KEY = 'lancam-tab';
  let currentTab = 'pair';
  function selectTab(name, remember = true) {
    const tab = document.querySelector(`.tab[data-tab="${name}"]`);
    if (!tab || tab.hidden) name = camConnected ? 'camera' : 'pair';
    currentTab = name;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
    if (remember) {
      try {
        localStorage.setItem(TAB_KEY, name);
      } catch {}
    }
  }
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => selectTab(t.dataset.tab));
  $('recordBtn2').addEventListener('click', () => $('recordBtn').click());

  // ------------------------------------------------- keyboard shortcuts ---

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    const click = (id) => {
      const b = $(id);
      if (!b.disabled && !b.hidden) b.click();
    };
    if (k === 'f') click('fullBtn');
    else if (k === 'c') click('camPowerBtn');
    else if (k === 'm') click('mirrorBtn');
    else if (k === 'o') click('rotateBtn');
    else if (k === 's') click('soundBtn');
    else if (k === 'r' && e.shiftKey) click('recordBtn');
    else return;
    e.preventDefault();
  });

  // ------------------------------ fullscreen: hide dock when mouse rests ---

  let idleTimer = null;
  function wake() {
    const stage = $('stage');
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    if (document.fullscreenElement === stage) idleTimer = setTimeout(() => stage.classList.add('idle'), 2500);
  }
  $('stage').addEventListener('mousemove', wake);
  document.addEventListener('fullscreenchange', wake);

  showFor(null);
  applyView();
  updateOverlay();
  try {
    selectTab(localStorage.getItem(TAB_KEY) || 'pair', false);
  } catch {
    selectTab('pair', false);
  }
  connect();
})();
