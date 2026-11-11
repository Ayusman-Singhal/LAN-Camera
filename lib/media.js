'use strict';
// Media packets from the Android app, and H.264 / AAC helpers.
//
// Binary packet layout (app -> server and server -> viewer):
//   byte 0      type   1 = video (H.264), 2 = audio (AAC)
//   byte 1      flags  bit 0 = key frame, bit 1 = codec config
//   bytes 2-9   presentation time, microseconds, signed 64-bit big-endian
//   bytes 10..  payload
// App sends H.264 in Annex-B form (start codes). Server converts to AVCC
// (4-byte length prefixes) for the viewer's WebCodecs decoder and for MKV.

const TYPE_VIDEO = 1;
const TYPE_AUDIO = 2;
const FLAG_KEY = 1;
const FLAG_CONFIG = 2;
const HEADER_BYTES = 10;

function parsePacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_BYTES) return null;
  const type = buf[0];
  if (type !== TYPE_VIDEO && type !== TYPE_AUDIO) return null;
  return {
    type,
    key: (buf[1] & FLAG_KEY) !== 0,
    config: (buf[1] & FLAG_CONFIG) !== 0,
    pts: Number(buf.readBigInt64BE(2)),
    data: buf.subarray(HEADER_BYTES),
  };
}

function makePacket(type, flags, pts, data) {
  const head = Buffer.alloc(HEADER_BYTES);
  head[0] = type;
  head[1] = flags;
  head.writeBigInt64BE(BigInt(Math.round(pts)), 2);
  return Buffer.concat([head, data]);
}

// Split Annex-B bytes into NAL units (without start codes).
function splitAnnexB(buf) {
  const nals = [];
  const n = buf.length;
  let i = 0;
  let start = -1;
  while (i + 2 < n) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && buf[end - 1] === 0) end--; // drop zero byte of 4-byte start code
        if (end > start) nals.push(buf.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < n) nals.push(buf.subarray(start));
  // No start code at all: treat as a single NAL.
  if (start < 0 && n) nals.push(buf);
  return nals;
}

const nalType = (nal) => nal[0] & 0x1f;
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

// AVCC frame: every NAL with a 4-byte length. SPS/PPS/AUD are dropped,
// they live in the decoder configuration instead.
function toAvcc(nals) {
  const parts = [];
  for (const nal of nals) {
    const t = nalType(nal);
    if (t === NAL_SPS || t === NAL_PPS || t === NAL_AUD) continue;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(nal.length);
    parts.push(len, nal);
  }
  return Buffer.concat(parts);
}

// AVCDecoderConfigurationRecord (ISO 14496-15) from one SPS and one PPS.
function buildAvcC(sps, pps) {
  const out = Buffer.alloc(11 + sps.length + pps.length);
  let o = 0;
  out[o++] = 1; // configurationVersion
  out[o++] = sps[1]; // profile
  out[o++] = sps[2]; // compatibility
  out[o++] = sps[3]; // level
  out[o++] = 0xff; // 4-byte NAL lengths
  out[o++] = 0xe1; // 1 SPS
  out.writeUInt16BE(sps.length, o);
  o += 2;
  sps.copy(out, o);
  o += sps.length;
  out[o++] = 1; // 1 PPS
  out.writeUInt16BE(pps.length, o);
  o += 2;
  pps.copy(out, o);
  return out;
}

function avcCodecString(sps) {
  const hex = (b) => b.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// AudioSpecificConfig -> { sampleRate, channels }.
function parseAsc(asc) {
  if (!asc || asc.length < 2) return null;
  const bits = (asc[0] << 8) | asc[1];
  const freqIndex = (bits >> 7) & 0x0f;
  const channels = (bits >> 3) & 0x0f;
  const sampleRate = AAC_RATES[freqIndex];
  if (!sampleRate || !channels) return null;
  return { sampleRate, channels };
}

module.exports = {
  TYPE_VIDEO,
  TYPE_AUDIO,
  FLAG_KEY,
  FLAG_CONFIG,
  NAL_IDR,
  NAL_SPS,
  NAL_PPS,
  parsePacket,
  makePacket,
  splitAnnexB,
  nalType,
  toAvcc,
  buildAvcC,
  avcCodecString,
  parseAsc,
};
