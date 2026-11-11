'use strict';
// Phone side: capture camera, authenticate to the PC, stream over WebRTC.
(() => {
  const $ = (id) => document.getElementById(id);
  const AUTH_KEY = 'lancam-auth'; // sessionStorage: survives reload, not tab close
  const SETTINGS_KEY = 'lancam-settings'; // localStorage: camera preferences

  const ALLOWED = {
    facing: ['user', 'environment'],
    res: ['640x480', '1280x720', '1920x1080'],
    fps: [15, 24, 30, 60],
    bitrate: [1500000, 4000000, 8000000],
  };

  let auth = null; // { method: 'key' | 'code', secret }
  let ws = null;
  let authed = false;
  let retryTimer = null;
  let stopped = true;

  let stream = null;
  let track = null;
  let reopenTimer = null;

  let pc = null;
  let sender = null;
  let sid = Math.floor(Math.random() * 1e6);
  let pendingCandidates = [];
  let restartTimer = null;
  let viewerReady = false;
  let pcCameraOff = false; // PC switched the camera off to save battery

  let wakeLock = null;
  let blackMode = false;
  let blackUiTimer = null;
  let blackFallbackTimer = null;
  const BLACK_FALLBACK_MS = 60 * 1000; // PC gone this long: light screen up again
  let battery = null;
  let statusText = '';

  let settings = { facing: 'environment', res: '1280x720', fps: 30, bitrate: 4000000, torch: false };

  // ------------------------------------------------------------ helpers ---

  function storageGet(store, key) {
    try {
      return JSON.parse(store.getItem(key));
    } catch {
      return null;
    }
  }
  function storageSet(store, key, value) {
    try {
      if (value == null) store.removeItem(key);
      else store.setItem(key, JSON.stringify(value));
    } catch {}
  }

  function setStatus(text, kind) {
    statusText = text;
    const el = $('status');
    el.textContent = text;
    el.className = 'pill' + (kind ? ' ' + kind : '');
    if (!$('blackUi').hidden) $('blackStatus').textContent = text;
  }

  function show(id, on) {
    $(id).hidden = !on;
  }

  async function hmacHex(secret, message) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function wsSend(obj) {
    if (ws && ws.readyState === 1 && authed) ws.send(JSON.stringify(obj));
  }

  // --------------------------------------------------------------- auth ---

  function loadAuth() {
    const m = /[#&]k=([A-Za-z0-9_-]{16,64})/.exec(location.hash);
    if (m) {
      auth = { method: 'key', secret: m[1] };
      storageSet(sessionStorage, AUTH_KEY, auth);
      // Remove the key from the address bar and history.
      history.replaceState(null, '', location.pathname);
      return;
    }
    const saved = storageGet(sessionStorage, AUTH_KEY);
    if (saved && typeof saved.secret === 'string' && (saved.method === 'key' || saved.method === 'code')) auth = saved;
  }

  function forgetAuth() {
    auth = null;
    storageSet(sessionStorage, AUTH_KEY, null);
  }

  function loadSettings() {
    const s = storageGet(localStorage, SETTINGS_KEY);
    if (!s) return;
    if (ALLOWED.facing.includes(s.facing)) settings.facing = s.facing;
    if (ALLOWED.res.includes(s.res)) settings.res = s.res;
    if (ALLOWED.fps.includes(s.fps)) settings.fps = s.fps;
    if (ALLOWED.bitrate.includes(s.bitrate)) settings.bitrate = s.bitrate;
  }

  function saveSettings() {
    const { facing, res, fps, bitrate } = settings;
    storageSet(localStorage, SETTINGS_KEY, { facing, res, fps, bitrate });
  }

  function syncSelects() {
    $('resSel').value = settings.res;
    $('fpsSel').value = String(settings.fps);
    $('rateSel').value = String(settings.bitrate);
    $('torchBtn').classList.toggle('on', settings.torch);
  }

  // ------------------------------------------------------------- camera ---

  function videoConstraints() {
    const [w, h] = settings.res.split('x').map(Number);
    return { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: settings.fps, max: settings.fps } };
  }

  function torchSupported() {
    try {
      return !!(track && track.getCapabilities && track.getCapabilities().torch);
    } catch {
      return false;
    }
  }

  // applyConstraints replaces the whole set, so always send size + fps + torch.
  async function applyTrackConstraints() {
    const c = videoConstraints();
    if (torchSupported()) c.advanced = [{ torch: settings.torch }];
    await track.applyConstraints(c);
  }

  async function openCamera() {
    if (track) {
      // Most Android phones cannot open two cameras at once.
      track.onended = null;
      track.stop();
    }
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: settings.facing }, ...videoConstraints() },
    });
    stream = s;
    track = s.getVideoTracks()[0];
    track.contentHint = 'motion';
    track.onended = onTrackEnded;
    track.onmute = () => sendStatus();
    track.onunmute = () => sendStatus();
    if (!blackMode) $('preview').srcObject = stream;
    if (sender) await sender.replaceTrack(track);
    if (settings.torch && torchSupported()) applyTrackConstraints().catch(() => {});
    show('torchBtn', torchSupported());
    if (!torchSupported()) settings.torch = false;
    syncSelects();
    sendStatus();
  }

  function onTrackEnded() {
    sendStatus();
    if (stopped || pcCameraOff) return;
    setStatus('Camera paused', 'warn');
    if (document.visibilityState === 'visible') scheduleReopen(500);
  }

  function scheduleReopen(delay) {
    clearTimeout(reopenTimer);
    reopenTimer = setTimeout(async () => {
      if (stopped || pcCameraOff || document.visibilityState !== 'visible') return;
      if (track && track.readyState === 'live') return;
      try {
        await openCamera();
        setStatus(pc && pc.connectionState === 'connected' ? 'Live on PC' : 'Camera on', 'ok');
      } catch (err) {
        setStatus(`Camera error: ${err.name}. Retrying…`, 'bad');
        scheduleReopen(2000);
      }
    }, delay);
  }

  async function changeCamera(kind) {
    saveSettings();
    syncSelects();
    if (!track) return;
    try {
      if (kind === 'facing') {
        await openCamera();
      } else if (kind === 'size') {
        try {
          await applyTrackConstraints();
        } catch {
          await openCamera();
        }
        applyEncoding();
      } else if (kind === 'bitrate') {
        applyEncoding();
      } else if (kind === 'torch') {
        await applyTrackConstraints();
      }
    } catch (err) {
      setStatus(`Camera error: ${err.name}`, 'bad');
    }
    sendStatus();
  }

  // ------------------------------------------------------------ webrtc ----

  function preferH264(transceiver) {
    // H.264 is usually hardware-encoded on Android: less CPU, less battery.
    if (!transceiver.setCodecPreferences) return;
    for (const src of [window.RTCRtpReceiver, window.RTCRtpSender]) {
      try {
        const codecs = src.getCapabilities('video').codecs;
        const h264 = codecs.filter((c) => /h264/i.test(c.mimeType));
        if (!h264.length) return;
        transceiver.setCodecPreferences([...h264, ...codecs.filter((c) => !/h264/i.test(c.mimeType))]);
        return;
      } catch {}
    }
  }

  async function applyEncoding() {
    if (!sender) return;
    const set = async (withDegradation) => {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) return;
      p.encodings[0].maxBitrate = settings.bitrate;
      p.encodings[0].maxFramerate = settings.fps;
      if (withDegradation) p.degradationPreference = 'maintain-framerate';
      await sender.setParameters(p);
    };
    try {
      await set(true);
    } catch {
      try {
        await set(false);
      } catch {}
    }
  }

  function closePeer() {
    clearTimeout(restartTimer);
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    pc = null;
    sender = null;
    pendingCandidates = [];
  }

  // PC camera switch off: release the camera, keep the connection.
  function releaseCamera() {
    clearTimeout(reopenTimer);
    closePeer();
    if (track) {
      track.onended = null;
      track.stop();
    }
    track = null;
    stream = null;
    $('preview').srcObject = null;
    sendStatus();
  }

  async function startPeer() {
    if (pcCameraOff) return;
    closePeer();
    if (!track || track.readyState !== 'live') {
      try {
        await openCamera();
      } catch {
        scheduleReopen(1000);
      }
    }
    if (!track) return;
    const my = ++sid;
    const p = new RTCPeerConnection({ iceServers: [] }); // LAN only, no STUN/TURN
    pc = p;
    const tr = p.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    sender = tr.sender;
    preferH264(tr);

    p.onicecandidate = (e) => {
      if (pc !== p) return;
      wsSend({ type: 'signal', data: { type: 'candidate', sid: my, candidate: e.candidate ? e.candidate.toJSON() : null } });
    };
    p.onconnectionstatechange = () => {
      if (pc !== p) return;
      const s = p.connectionState;
      if (s === 'connected') {
        clearTimeout(restartTimer);
        setStatus('Live on PC', 'ok');
        applyEncoding();
      } else if (s === 'connecting') {
        setStatus('Connecting video…');
      } else if (s === 'disconnected') {
        setStatus('Video interrupted…', 'warn');
        scheduleRestart(4000);
      } else if (s === 'failed') {
        setStatus('Video failed. Retrying…', 'bad');
        scheduleRestart(500);
      }
      sendStatus();
    };

    const offer = await p.createOffer();
    if (pc !== p) return;
    await p.setLocalDescription(offer);
    wsSend({ type: 'signal', data: { type: 'offer', sid: my, sdp: p.localDescription.sdp } });
  }

  function scheduleRestart(delay) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!pc || pc.connectionState === 'connected') return;
      if (viewerReady && authed && !stopped) startPeer();
    }, delay);
  }

  async function onSignal(data) {
    if (!pc || !data || data.sid !== sid) return;
    try {
      if (data.type === 'answer' && typeof data.sdp === 'string') {
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        for (const c of pendingCandidates) await pc.addIceCandidate(c).catch(() => {});
        pendingCandidates = [];
        applyEncoding();
      } else if (data.type === 'candidate') {
        const c = data.candidate || null;
        if (pc.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
        else pendingCandidates.push(c);
      }
    } catch (err) {
      console.warn('signal error', err);
    }
  }

  // --------------------------------------------------------- websocket ----

  const FAIL_TEXT = {
    'bad-key': 'Wrong or expired key. Scan the QR code on your PC again.',
    busy: 'Another phone is already connected to this PC.',
    locked: 'Pairing is locked on the PC.',
    blocked: 'Too many wrong attempts. Wait 10 minutes.',
  };

  function connect() {
    clearTimeout(retryTimer);
    if (stopped || !auth) return;
    if (ws && ws.readyState <= 1) return;
    setStatus('Connecting to PC…');
    authed = false;
    let terminal = false;
    const sock = new WebSocket(`wss://${location.host}/ws`);
    ws = sock;

    sock.onmessage = async (ev) => {
      if (ws !== sock) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'challenge': {
          const mac = await hmacHex(auth.secret, String(msg.nonce));
          sock.send(JSON.stringify({ type: 'auth', method: auth.method, mac }));
          break;
        }
        case 'auth-ok':
          authed = true;
          clearTimeout(blackFallbackTimer);
          blackFallbackTimer = null;
          if (typeof msg.key === 'string') {
            auth = { method: 'key', secret: msg.key };
            storageSet(sessionStorage, AUTH_KEY, auth);
          }
          setStatus('Paired. Waiting for PC viewer…', 'warn');
          sendStatus();
          break;
        case 'auth-fail':
          terminal = true;
          stopAll();
          setStatus(FAIL_TEXT[msg.reason] || 'Rejected by PC.', 'bad');
          if (msg.reason === 'bad-key') {
            forgetAuth();
            showPairing();
          } else {
            show('startCard', true);
          }
          break;
        case 'start':
          viewerReady = true;
          startPeer();
          break;
        case 'camera':
          pcCameraOff = msg.value === false;
          if (pcCameraOff) {
            releaseCamera();
            setStatus('Camera off (switched off on PC to save battery)', 'warn');
          } else {
            setStatus('Camera on. Starting…');
          }
          break;
        case 'viewer-left':
          viewerReady = false;
          closePeer();
          setStatus('Paired. PC viewer closed.', 'warn');
          break;
        case 'signal':
          onSignal(msg.data);
          break;
        case 'settings':
          applyRemoteSettings(msg.data);
          break;
        case 'kicked':
          terminal = true;
          stopAll();
          setStatus(msg.reason === 'pairing key changed' ? 'PC changed the key. Scan the new QR code.' : 'Disconnected by PC.', 'bad');
          if (msg.reason === 'pairing key changed') {
            forgetAuth();
            showPairing();
          } else {
            show('startCard', true);
          }
          break;
        case 'replaced':
          terminal = true;
          stopAll();
          setStatus('Camera opened in another tab.', 'bad');
          break;
      }
    };

    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      authed = false;
      viewerReady = false;
      closePeer();
      if (!terminal && !stopped) {
        setStatus('PC not reachable. Retrying…', 'warn');
        // Do not stay black forever if the PC is gone: show the status again.
        if (blackMode && !blackFallbackTimer) {
          blackFallbackTimer = setTimeout(() => {
            blackFallbackTimer = null;
            exitBlack();
          }, BLACK_FALLBACK_MS);
        }
        retryTimer = setTimeout(connect, 2000);
      }
    };
    sock.onerror = () => {};
  }

  function applyRemoteSettings(d) {
    if (!d || typeof d !== 'object') return;
    if (ALLOWED.facing.includes(d.facing) && d.facing !== settings.facing) {
      settings.facing = d.facing;
      changeCamera('facing');
    }
    if (ALLOWED.res.includes(d.res) || ALLOWED.fps.includes(d.fps)) {
      if (ALLOWED.res.includes(d.res)) settings.res = d.res;
      if (ALLOWED.fps.includes(d.fps)) settings.fps = d.fps;
      changeCamera('size');
    }
    if (ALLOWED.bitrate.includes(d.bitrate)) {
      settings.bitrate = d.bitrate;
      changeCamera('bitrate');
    }
    if (typeof d.black === 'boolean') {
      if (d.black) enterBlack();
      else exitBlack();
    }
    if (typeof d.torch === 'boolean' && torchSupported()) {
      settings.torch = d.torch;
      changeCamera('torch');
    }
  }

  // ------------------------------------------------------------ status ----

  function currentState() {
    if (stopped) return 'stopped';
    if (pcCameraOff) return 'off';
    if (!track || track.readyState !== 'live' || track.muted || document.visibilityState !== 'visible') return 'paused';
    return blackMode ? 'black' : 'live';
  }

  function sendStatus() {
    if (!authed) return;
    const actual = track && track.getSettings ? track.getSettings() : {};
    wsSend({
      type: 'status',
      state: currentState(),
      battery: battery ? Math.round(battery.level * 100) : undefined,
      charging: battery ? battery.charging : undefined,
      caps: { torch: torchSupported() },
      settings: {
        facing: settings.facing,
        res: settings.res,
        fps: settings.fps,
        bitrate: settings.bitrate,
        torch: settings.torch,
        black: blackMode,
        width: actual.width || null,
        height: actual.height || null,
      },
    });
  }

  async function initBattery() {
    try {
      if (!navigator.getBattery) return;
      battery = await navigator.getBattery();
      battery.addEventListener('levelchange', sendStatus);
      battery.addEventListener('chargingchange', sendStatus);
    } catch {}
  }

  // --------------------------------------------------------- wake lock ----

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || stopped || document.visibilityState !== 'visible') return;
    if (wakeLock && !wakeLock.released) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch {}
  }

  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  // ------------------------------------------------------- black screen ---
  // Black screen is switched on and off from the PC viewer only.

  function enterBlack() {
    if (blackMode) return;
    blackMode = true;
    show('black', true);
    $('preview').srcObject = null; // stop drawing preview: saves GPU/battery
    sendStatus();
  }

  function exitBlack() {
    if (!blackMode) return;
    blackMode = false;
    show('black', false);
    show('blackUi', false);
    if (stream) $('preview').srcObject = stream;
    sendStatus();
  }

  // Fullscreen needs a tap on the phone, so it is requested on "Start".
  function enterFullscreen() {
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) {
      el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
  }

  function flashBlackUi() {
    $('blackStatus').textContent = statusText;
    show('blackUi', true);
    clearTimeout(blackUiTimer);
    blackUiTimer = setTimeout(() => show('blackUi', false), 3000);
  }

  // ---------------------------------------------------------- lifecycle ---

  async function start() {
    if (!auth) return showPairing();
    stopped = false;
    enterFullscreen(); // must run before any await, while the tap is fresh
    show('pair', false);
    show('startCard', false);
    setStatus('Opening camera…');
    try {
      await openCamera();
    } catch (err) {
      stopped = true;
      const why = err.name === 'NotAllowedError' ? 'Camera permission denied.' : `Camera error: ${err.name}`;
      setStatus(why, 'bad');
      show('startCard', true);
      return;
    }
    show('previewWrap', true);
    show('controls', true);
    requestWakeLock();
    connect();
  }

  function stopAll() {
    stopped = true;
    pcCameraOff = false;
    clearTimeout(reopenTimer);
    clearTimeout(retryTimer);
    closePeer();
    viewerReady = false;
    if (track) {
      track.onended = null;
      track.stop();
    }
    track = null;
    stream = null;
    $('preview').srcObject = null;
    releaseWakeLock();
    clearTimeout(blackFallbackTimer);
    exitBlack();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    show('previewWrap', false);
    show('controls', false);
  }

  function showPairing() {
    show('startCard', false);
    show('pair', true);
    $('codeInput').value = '';
  }

  document.addEventListener('visibilitychange', () => {
    if (stopped) return;
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      if (!track || track.readyState !== 'live') scheduleReopen(300);
      if (!ws) connect();
    }
    sendStatus();
  });

  // ------------------------------------------------------------ wiring ----

  $('codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 8) {
      setStatus('Code must be 8 characters.', 'bad');
      return;
    }
    auth = { method: 'code', secret: code };
    storageSet(sessionStorage, AUTH_KEY, auth);
    start();
  });
  $('startBtn').addEventListener('click', start);
  $('stopBtn').addEventListener('click', () => {
    const sock = ws;
    stopAll();
    ws = null;
    if (sock) sock.close();
    setStatus('Stopped.');
    show('startCard', true);
  });
  $('flipBtn').addEventListener('click', () => {
    settings.facing = settings.facing === 'user' ? 'environment' : 'user';
    settings.torch = false;
    changeCamera('facing');
  });
  $('torchBtn').addEventListener('click', () => {
    settings.torch = !settings.torch;
    changeCamera('torch');
  });
  $('resSel').addEventListener('change', (e) => {
    settings.res = e.target.value;
    changeCamera('size');
  });
  $('fpsSel').addEventListener('change', (e) => {
    settings.fps = Number(e.target.value);
    changeCamera('size');
  });
  $('rateSel').addEventListener('change', (e) => {
    settings.bitrate = Number(e.target.value);
    changeCamera('bitrate');
  });
  $('black').addEventListener('click', flashBlackUi);

  setInterval(sendStatus, 30000);

  // -------------------------------------------------------------- boot ----

  if (!window.isSecureContext || !navigator.mediaDevices || !window.RTCPeerConnection) {
    setStatus('This page needs HTTPS with the LAN Camera certificate installed.', 'bad');
    return;
  }
  // The first RTCPeerConnection in a browser process can take seconds to
  // start. Pay that cost now, before the user taps Start.
  setTimeout(() => {
    try {
      RTCRtpSender.getCapabilities('video');
      const p = new RTCPeerConnection({ iceServers: [] });
      p.addTransceiver('video', { direction: 'sendonly' });
      p.createOffer()
        .catch(() => {})
        .finally(() => p.close());
    } catch {}
  }, 300);

  loadAuth();
  loadSettings();
  syncSelects();
  initBattery();
  if (auth) {
    setStatus('Ready');
    show('startCard', true);
  } else {
    setStatus('Not paired', 'warn');
    showPairing();
  }
})();
