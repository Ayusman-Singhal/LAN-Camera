'use strict';
// Private certificate authority for the phone's HTTPS connection.
//
// - The CA is created once and stored in ./data. You install ca.crt on the
//   phone one time (see README). ca.key never leaves this PC.
// - The CA carries a critical Name Constraints extension: it can only vouch
//   for private IPv4 ranges and "localhost". Even if ca.key leaked, it could
//   not be used to fake real websites on your phone.
// - A short-lived server ("leaf") certificate is issued at every start and
//   whenever the PC's LAN addresses change.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const forge = require('node-forge');

const { asn1, pki } = forge;

const DATA_DIR = path.join(__dirname, '..', 'data');
const CA_KEY = path.join(DATA_DIR, 'ca.key');
const CA_CERT = path.join(DATA_DIR, 'ca.crt');

const CA_SUBJECT = [
  { name: 'commonName', value: 'LAN Camera Private CA' },
  { name: 'organizationName', value: 'LAN Camera (this PC only)' },
];

function newRsaKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

// Positive, random 128-bit serial number as hex.
function randomSerial() {
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f;
  if (b[0] === 0) b[0] = 0x01;
  return b.toString('hex');
}

function ipConstraint(addr, mask) {
  const bytes = forge.util.bytesFromIP(addr) + forge.util.bytesFromIP(mask);
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 7, false, bytes), // iPAddress
  ]);
}

function dnsConstraint(name) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, name), // dNSName
  ]);
}

// RFC 5280 4.2.1.10 NameConstraints with permittedSubtrees only.
function nameConstraintsExtension() {
  const permitted = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    ipConstraint('10.0.0.0', '255.0.0.0'),
    ipConstraint('172.16.0.0', '255.240.0.0'),
    ipConstraint('192.168.0.0', '255.255.0.0'),
    ipConstraint('127.0.0.0', '255.0.0.0'),
    dnsConstraint('localhost'),
  ]);
  return {
    id: '2.5.29.30',
    critical: true,
    value: asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [permitted]),
  };
}

// Restrict a secret file so only the current Windows user can read it.
function protectFile(file) {
  try {
    if (process.platform === 'win32') {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      fs.chmodSync(file, 0o600);
    }
  } catch (err) {
    console.warn(`[certs] Could not restrict permissions on ${file}: ${err.message}`);
  }
}

function createCA() {
  const { privateKeyPem, publicKeyPem } = newRsaKeyPair();
  const cert = pki.createCertificate();
  cert.publicKey = pki.publicKeyFromPem(publicKeyPem);
  cert.serialNumber = randomSerial();
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(now.getTime() + 10 * 365 * 24 * 3600 * 1000);
  cert.setSubject(CA_SUBJECT);
  cert.setIssuer(CA_SUBJECT);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
    nameConstraintsExtension(),
  ]);
  cert.sign(pki.privateKeyFromPem(privateKeyPem), forge.md.sha256.create());

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CA_KEY, privateKeyPem, { mode: 0o600 });
  protectFile(CA_KEY);
  fs.writeFileSync(CA_CERT, pki.certificateToPem(cert));
  return { keyPem: privateKeyPem, certPem: pki.certificateToPem(cert), created: true };
}

// Load the CA, creating it on first run.
function ensureCA() {
  if (fs.existsSync(CA_KEY) && fs.existsSync(CA_CERT)) {
    return {
      keyPem: fs.readFileSync(CA_KEY, 'utf8'),
      certPem: fs.readFileSync(CA_CERT, 'utf8'),
      created: false,
    };
  }
  return createCA();
}

function fingerprints(certPem) {
  const x = new crypto.X509Certificate(certPem);
  return { sha256: x.fingerprint256, sha1: x.fingerprint, der: x.raw };
}

// Issue a server certificate for localhost + the given IPv4 addresses.
// The key pair is reused across re-issues within one server run.
function createLeafFactory(ca) {
  const caCert = pki.certificateFromPem(ca.certPem);
  const caKey = pki.privateKeyFromPem(ca.keyPem);
  const leafKeys = newRsaKeyPair();
  const leafPub = pki.publicKeyFromPem(leafKeys.publicKeyPem);

  return function issue(addresses) {
    const cert = pki.createCertificate();
    cert.publicKey = leafPub;
    cert.serialNumber = randomSerial();
    const now = new Date();
    cert.validity.notBefore = new Date(now.getTime() - 3600 * 1000);
    cert.validity.notAfter = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    cert.setSubject([{ name: 'commonName', value: 'LAN Camera' }]);
    cert.setIssuer(caCert.subject.attributes);

    const ips = Array.from(new Set(['127.0.0.1', ...addresses]));
    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))],
      },
      { name: 'subjectKeyIdentifier' },
      {
        name: 'authorityKeyIdentifier',
        keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes(),
      },
    ]);
    cert.sign(caKey, forge.md.sha256.create());
    return { key: leafKeys.privateKeyPem, cert: pki.certificateToPem(cert) };
  };
}

module.exports = { ensureCA, fingerprints, createLeafFactory, CA_CERT, CA_KEY, DATA_DIR };
