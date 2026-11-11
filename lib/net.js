'use strict';
// Network helpers: which addresses this PC has on the LAN, and which client
// addresses are allowed to talk to us at all (private IPv4 + loopback only).

const os = require('os');

// Node reports IPv4 clients on dual-stack sockets as "::ffff:1.2.3.4".
function toV4(addr) {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

function parseV4(addr) {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function isLoopback(addr) {
  const a = toV4(addr);
  if (a === '::1') return true;
  const p = parseV4(a);
  return !!p && p[0] === 127;
}

function isPrivateV4(addr) {
  const p = parseV4(toV4(addr));
  if (!p) return false;
  return (
    p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168)
  );
}

function isAllowedClient(addr) {
  return isLoopback(addr) || isPrivateV4(addr);
}

const VIRTUAL_RE = /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier|vpn/i;
const WIFI_RE = /wi-?fi|wlan|wireless/i;

// All private IPv4 addresses on this machine, best guesses first.
// `virtual` marks adapters (Hyper-V, WSL, VMware...) a phone cannot reach.
function listLanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!isPrivateV4(a.address)) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL_RE.test(name) });
    }
  }
  const rank = (x) => (x.virtual ? 2 : WIFI_RE.test(x.name) ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address));
  return out;
}

// Addresses to show the user as QR codes: real adapters only, unless that
// leaves nothing.
function pairingAddresses(list) {
  const real = list.filter((x) => !x.virtual);
  return real.length ? real : list;
}

function signature(list) {
  return list.map((x) => x.address).sort().join(',');
}

// Calls onChange(list) whenever the set of LAN addresses changes
// (e.g. PC switches from home Wi-Fi to the phone's hotspot).
function watchAddresses(onChange, intervalMs = 5000) {
  let last = signature(listLanAddresses());
  const timer = setInterval(() => {
    const list = listLanAddresses();
    const sig = signature(list);
    if (sig !== last) {
      last = sig;
      onChange(list);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  toV4,
  isLoopback,
  isPrivateV4,
  isAllowedClient,
  listLanAddresses,
  pairingAddresses,
  watchAddresses,
};
