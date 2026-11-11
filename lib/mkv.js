'use strict';
// Minimal Matroska (MKV) writer for one H.264 track and one optional AAC track.
// Streams to disk as it goes, so a crash or power cut still leaves a playable
// file (at most the last ~2 seconds are lost).

const fs = require('fs');
const crypto = require('crypto');

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
};

const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function idBytes(id) {
  let hex = id.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

// 8-byte EBML size field.
function sizeBytes(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  b[0] = 0x01;
  return b;
}

function el(id, ...children) {
  const data = Buffer.concat(children.flat());
  return Buffer.concat([idBytes(id), sizeBytes(data.length), data]);
}
function uint(id, v) {
  let hex = Math.floor(v).toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return el(id, Buffer.from(hex, 'hex'));
}
function float(id, v) {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return el(id, b);
}
function str(id, s) {
  return el(id, Buffer.from(s, 'utf8'));
}
function uid() {
  return crypto.randomInt(1, 2 ** 31);
}

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;
const CLUSTER_MIN_MS = 2000; // start new cluster at a key frame after this
const CLUSTER_MAX_MS = 30000; // block offsets are 16-bit: force a new cluster

class MkvWriter {
  // tracks: { video: { avcC, width, height }, audio: { asc, sampleRate, channels } | null }
  constructor(file, tracks) {
    this.file = file;
    this.bytes = 0;
    this.closed = false;
    this.clusterStart = null;
    this.blocks = [];
    this.hasAudio = !!tracks.audio;
    this.out = fs.createWriteStream(file);
    this.out.on('error', (err) => {
      this.error = err;
    });

    const entries = [
      el(
        ID.TrackEntry,
        uint(ID.TrackNumber, VIDEO_TRACK),
        uint(ID.TrackUID, uid()),
        uint(ID.TrackType, 1),
        uint(ID.FlagLacing, 0),
        str(ID.CodecID, 'V_MPEG4/ISO/AVC'),
        el(ID.CodecPrivate, tracks.video.avcC),
        el(ID.Video, uint(ID.PixelWidth, tracks.video.width), uint(ID.PixelHeight, tracks.video.height))
      ),
    ];
    if (tracks.audio) {
      entries.push(
        el(
          ID.TrackEntry,
          uint(ID.TrackNumber, AUDIO_TRACK),
          uint(ID.TrackUID, uid()),
          uint(ID.TrackType, 2),
          uint(ID.FlagLacing, 0),
          str(ID.CodecID, 'A_AAC'),
          el(ID.CodecPrivate, tracks.audio.asc),
          el(ID.Audio, float(ID.SamplingFrequency, tracks.audio.sampleRate), uint(ID.Channels, tracks.audio.channels))
        )
      );
    }

    this.write(
      el(
        ID.EBML,
        uint(ID.EBMLVersion, 1),
        uint(ID.EBMLReadVersion, 1),
        uint(ID.EBMLMaxIDLength, 4),
        uint(ID.EBMLMaxSizeLength, 8),
        str(ID.DocType, 'matroska'),
        uint(ID.DocTypeVersion, 4),
        uint(ID.DocTypeReadVersion, 2)
      )
    );
    // Segment of unknown size: lets us append forever without seeking back.
    this.write(Buffer.concat([idBytes(ID.Segment), UNKNOWN_SIZE]));
    this.write(
      el(ID.Info, uint(ID.TimecodeScale, 1000000), str(ID.MuxingApp, 'lan-camera'), str(ID.WritingApp, 'lan-camera'))
    );
    this.write(el(ID.Tracks, entries));
  }

  write(buf) {
    this.bytes += buf.length;
    this.out.write(buf);
  }

  flushCluster() {
    if (this.clusterStart == null || !this.blocks.length) return;
    this.write(el(ID.Cluster, uint(ID.Timecode, this.clusterStart), this.blocks));
    this.blocks = [];
  }

  addBlock(track, ms, key, data) {
    if (this.closed) return;
    ms = Math.max(0, Math.round(ms));
    const isVideo = track === VIDEO_TRACK;
    if (
      this.clusterStart == null ||
      ms - this.clusterStart > CLUSTER_MAX_MS ||
      ms - this.clusterStart < -30000 ||
      (isVideo && key && ms - this.clusterStart >= CLUSTER_MIN_MS)
    ) {
      this.flushCluster();
      this.clusterStart = ms;
    }
    const head = Buffer.alloc(4);
    head[0] = 0x80 | track;
    head.writeInt16BE(ms - this.clusterStart, 1);
    head[3] = key ? 0x80 : 0x00;
    this.blocks.push(el(ID.SimpleBlock, head, data));
  }

  writeVideo(ms, key, avccFrame) {
    this.addBlock(VIDEO_TRACK, ms, key, avccFrame);
  }

  writeAudio(ms, aacFrame) {
    if (this.hasAudio) this.addBlock(AUDIO_TRACK, ms, true, aacFrame);
  }

  close() {
    if (this.closed) return Promise.resolve();
    this.flushCluster();
    this.closed = true;
    return new Promise((resolve) => this.out.end(resolve));
  }
}

module.exports = { MkvWriter };
