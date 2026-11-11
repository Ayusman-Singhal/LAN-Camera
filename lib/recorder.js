'use strict';
// Records the Android app's stream on the PC.
//
// Writes MKV while recording (safe against crashes), then, if ffmpeg is
// installed, converts it to MP4 without re-encoding and deletes the MKV.
// A change of resolution, camera or orientation starts a new file ("part").

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { MkvWriter } = require('./mkv');

function hasFfmpeg() {
  try {
    return spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

class Recorder {
  constructor({ dir, log, onChange }) {
    this.dir = dir;
    this.log = log;
    this.onChange = onChange || (() => {});
    this.ffmpeg = hasFfmpeg();
    this.wanted = false;
    this.writer = null;
    this.t0 = 0;
    this.rotation = 0;
    this.startedAt = 0;
    this.lastFile = null;
    this.error = null;
    this.pending = new Set(); // finishing jobs (close + remux)
  }

  setWanted(value) {
    if (this.wanted === value) return;
    this.wanted = value;
    this.error = null;
    if (!value) this.finish();
    this.onChange();
  }

  // Caller must ask the phone for a key frame while this is true.
  needsKeyframe() {
    return this.wanted && !this.writer;
  }

  // cfg: { video: { avcC, width, height, rotation }, audio: { asc, sampleRate, channels } | null }
  // cfg.audioExpected: phone mic is on, but its audio config may not have
  // arrived yet. Wait up to 3 s for it so the file gets a sound track.
  onVideo(pts, key, avccFrame, cfg) {
    if (!this.wanted) return;
    if (!this.writer) {
      if (!key || !cfg.video) return;
      if (!cfg.audio && cfg.audioExpected) {
        if (!this.audioWaitSince) this.audioWaitSince = Date.now();
        if (Date.now() - this.audioWaitSince < 3000) return;
      }
      this.audioWaitSince = 0;
      this.open(cfg, pts);
    }
    this.writer.writeVideo((pts - this.t0) / 1000, key, avccFrame);
  }

  onAudio(pts, aacFrame) {
    if (!this.writer || pts < this.t0) return;
    this.writer.writeAudio((pts - this.t0) / 1000, aacFrame);
  }

  open(cfg, pts) {
    fs.mkdirSync(this.dir, { recursive: true });
    let base = `lan-camera_${stamp()}`;
    let n = 2;
    while (fs.existsSync(path.join(this.dir, base + '.mkv')) || fs.existsSync(path.join(this.dir, base + '.mp4'))) {
      base = `lan-camera_${stamp()}_part${n++}`;
    }
    const file = path.join(this.dir, base + '.mkv');
    this.writer = new MkvWriter(file, cfg);
    this.t0 = pts;
    this.rotation = cfg.video.rotation || 0;
    this.startedAt = Date.now();
    this.log(`Recording to ${file}`);
    this.onChange();
  }

  // Close the current file (if any). Recording continues in a new file at
  // the next key frame when still wanted.
  finish() {
    const w = this.writer;
    if (!w) return Promise.resolve();
    this.writer = null;
    const rotation = this.rotation;
    const job = w
      .close()
      .then(() => this.convert(w.file, rotation))
      .catch((err) => {
        this.error = err.message;
        this.log(`Recording error: ${err.message}`);
      })
      .finally(() => {
        this.pending.delete(job);
        this.onChange();
      });
    this.pending.add(job);
    this.onChange();
    return job;
  }

  convert(mkv, rotation) {
    if (!this.ffmpeg) {
      this.lastFile = mkv;
      this.log(`Saved ${mkv}`);
      return Promise.resolve();
    }
    const mp4 = mkv.replace(/\.mkv$/, '.mp4');
    // ffmpeg wants counter-clockwise degrees; the phone reports clockwise.
    const ccw = (360 - (rotation % 360)) % 360;
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation:v:0', String(ccw), '-i', mkv, '-c', 'copy', '-movflags', '+faststart', mp4];
    return new Promise((resolve) => {
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0 ? true : (this.log(`ffmpeg failed: ${err.trim()}`), false)));
    }).then((ok) => {
      if (ok) {
        fs.rmSync(mkv, { force: true });
        this.lastFile = mp4;
      } else {
        this.lastFile = mkv;
      }
      this.log(`Saved ${this.lastFile}`);
    });
  }

  // Wait for all files to be closed and converted (used on shutdown).
  async flushAll() {
    await this.finish();
    await Promise.all([...this.pending]);
  }

  status() {
    return {
      wanted: this.wanted,
      active: !!this.writer,
      saving: this.pending.size > 0,
      file: this.writer ? path.basename(this.writer.file) : null,
      bytes: this.writer ? this.writer.bytes : 0,
      seconds: this.writer ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      lastFile: this.lastFile ? path.basename(this.lastFile) : null,
      folder: this.dir,
      mp4: this.ffmpeg,
      error: this.error,
    };
  }
}

module.exports = { Recorder };
