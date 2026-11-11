'use strict';
// One-time helper: get the private CA certificate onto the phone.
//
// Starts a temporary plain-HTTP server that serves ONLY ca.crt, at a random
// path, to private-network clients. It stops after the first download or
// after 5 minutes. The certificate is public data (no secret inside), but an
// attacker on the same Wi-Fi could try to swap it during this download, so
// compare the fingerprint on the phone afterwards (see README), or copy
// data/ca.crt by USB cable instead.

const http = require('http');
const crypto = require('crypto');
const QRCode = require('qrcode');
const certs = require('./lib/certs');
const net = require('./lib/net');

const PORT = Number(process.env.SETUP_PORT) || 8080;
const TIMEOUT_MS = 5 * 60 * 1000;

const ca = certs.ensureCA();
const fp = certs.fingerprints(ca.certPem);
const token = crypto.randomBytes(6).toString('hex');
const pathname = `/lan-camera-ca-${token}.crt`;
const addresses = net.pairingAddresses(net.listLanAddresses());

if (!addresses.length) {
  console.error('No LAN address found. Connect this PC to Wi-Fi first.');
  process.exit(1);
}

let finishing = false;
const server = http.createServer((req, res) => {
  if (!net.isAllowedClient(req.socket.remoteAddress) || req.method !== 'GET' || req.url !== pathname) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="lan-camera-ca.crt"',
    'Content-Length': fp.der.length,
    'Cache-Control': 'no-store',
  });
  res.end(fp.der);
  console.log(`\nCertificate downloaded by ${net.toV4(req.socket.remoteAddress)}.`);
  if (!finishing) {
    finishing = true;
    setTimeout(() => {
      console.log('Setup server stopped. Now install the certificate on the phone (see below / README).');
      printInstallSteps();
      process.exit(0);
    }, 3000);
  }
});

function printInstallSteps() {
  console.log(`
Install on Android:
  1. Settings > Security & privacy > More security settings > Encryption & credentials
     (name varies by phone; search Settings for "CA certificate").
  2. Install a certificate > CA certificate > Install anyway.
  3. Pick "lan-camera-ca.crt" from Downloads.
  4. Check: Encryption & credentials > Trusted credentials > User tab > "LAN Camera Private CA".
     Its SHA-256 fingerprint must be:
     ${fp.sha256}

Then run:  npm start
`);
}

server.listen(PORT, '0.0.0.0', async () => {
  console.log('LAN Camera - certificate setup\n');
  console.log('CA SHA-256 fingerprint:');
  console.log(`  ${fp.sha256}`);
  console.log('CA SHA-1 fingerprint:');
  console.log(`  ${fp.sha1}\n`);
  for (const a of addresses) {
    const url = `http://${a.address}:${PORT}${pathname}`;
    console.log(`Scan with the phone (${a.name}):  ${url}`);
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  }
  console.log('Waiting for download (stops in 5 minutes)...');
  console.log('Phone and PC must be on the same Wi-Fi. If it does not load, run scripts\\firewall.ps1 as admin.');
});

server.on('error', (err) => {
  console.error(`Cannot start setup server on port ${PORT}: ${err.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.log('\nTimed out. Run "npm run setup" again when ready.');
  process.exit(0);
}, TIMEOUT_MS).unref();
