/**
 * Local camera + microphone: permission handling with graceful fallbacks,
 * device switching, front/back camera flip, and a live mic level meter.
 */
export class Media {
  constructor() {
    this.stream = null;
    this.facing = 'user';
    this.meters = new Set();
    this._raf = 0;
    this._ac = null;
    this._analyser = null;
    this._src = null;
  }

  static supported() {
    return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /** 'granted' | 'denied' | 'prompt' | 'unknown' */
  static async permission() {
    try {
      const cam = await navigator.permissions.query({ name: 'camera' });
      return cam.state;
    } catch {
      return 'unknown';
    }
  }

  static classify(err) {
    if (!err) return 'other';
    if (err.kind) return err.kind;
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return 'blocked';
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError' || err.name === 'NotReadableError' || err.name === 'AbortError') return 'notfound';
    return 'other';
  }

  get live() { return !!this.stream && this.stream.getTracks().some((t) => t.readyState === 'live'); }
  get audioTrack() { return this.stream?.getAudioTracks()[0] || null; }
  get videoTrack() { return this.stream?.getVideoTracks()[0] || null; }
  get micOn() { return !!this.audioTrack?.enabled; }
  get camOn() { return !!this.videoTrack?.enabled; }

  _videoConstraints(deviceId) {
    return {
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: this.facing }),
    };
  }
  _audioConstraints(deviceId) {
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
  }

  async start({ cameraId = '', micId = '' } = {}) {
    if (this.live) return this.stream;
    if (!Media.supported()) throw Object.assign(new Error('insecure'), { kind: 'insecure' });
    const attempts = [
      { video: this._videoConstraints(cameraId), audio: this._audioConstraints(micId) },
      { video: true, audio: true },
      { video: true, audio: false },
      { video: false, audio: true },
    ];
    let lastErr = null;
    for (const c of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(c);
        this._restartMeter();
        return this.stream;
      } catch (e) {
        lastErr = e;
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break; // don't re-prompt after a "no"
      }
    }
    throw lastErr;
  }

  setMic(on) { if (this.audioTrack) this.audioTrack.enabled = on; }
  setCam(on) { if (this.videoTrack) this.videoTrack.enabled = on; }

  async devices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return {
        video: all.filter((d) => d.kind === 'videoinput'),
        audio: all.filter((d) => d.kind === 'audioinput'),
        output: all.filter((d) => d.kind === 'audiooutput'),
      };
    } catch {
      return { video: [], audio: [], output: [] };
    }
  }

  /** Swap one track for a new device. Returns the new track (for RTCRtpSender.replaceTrack). */
  async switchDevice(kind, deviceId) {
    if (!this.stream) return null;
    const isVideo = kind === 'video';
    const old = isVideo ? this.videoTrack : this.audioTrack;
    const constraints = isVideo ? { video: this._videoConstraints(deviceId) } : { audio: this._audioConstraints(deviceId) };
    const fresh = await navigator.mediaDevices.getUserMedia(constraints);
    const track = isVideo ? fresh.getVideoTracks()[0] : fresh.getAudioTracks()[0];
    if (old) {
      track.enabled = old.enabled;
      this.stream.removeTrack(old);
      old.stop();
    }
    this.stream.addTrack(track);
    if (!isVideo) this._restartMeter();
    return track;
  }

  async flip() {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    const old = this.videoTrack;
    if (old) old.stop(); // some phones can't open two cameras at once
    const fresh = await navigator.mediaDevices.getUserMedia({ video: this._videoConstraints('') });
    const track = fresh.getVideoTracks()[0];
    if (old) {
      track.enabled = old.enabled;
      this.stream.removeTrack(old);
    }
    this.stream.addTrack(track);
    return track;
  }

  // ---------------------------------------------------------- level meter
  attachMeter(container) { if (container) this.meters.add(container); this._loop(); }
  setMetering(on) {
    this._metering = on;
    if (on) this._loop();
  }

  _restartMeter() {
    try {
      if (!this.audioTrack) return;
      this._ac ||= new (window.AudioContext || window.webkitAudioContext)();
      if (this._src) this._src.disconnect();
      this._src = this._ac.createMediaStreamSource(new MediaStream([this.audioTrack]));
      this._analyser = this._ac.createAnalyser();
      this._analyser.fftSize = 512;
      this._src.connect(this._analyser);
      this._buf = new Uint8Array(this._analyser.fftSize);
      this._loop();
    } catch { /* metering is cosmetic */ }
  }

  _loop() {
    if (this._raf || !this._analyser) return;
    const tick = () => {
      this._raf = 0;
      if (!this._metering || !this._analyser) return;
      if (this._ac.state === 'suspended') this._ac.resume().catch(() => {});
      this._analyser.getByteTimeDomainData(this._buf);
      let sum = 0;
      for (const v of this._buf) { const x = (v - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / this._buf.length);
      const level = this.micOn ? Math.min(1, rms * 5) : 0;
      for (const m of this.meters) {
        if (!m.isConnected || !m.offsetParent) continue;
        m.querySelectorAll('i').forEach((bar, i) => {
          const threshold = (i + 0.5) / 5;
          bar.style.transform = `scaleY(${Math.max(0.25, Math.min(1, level * 1.4 - i * 0.12 + 0.2))})`;
          bar.classList.toggle('on', level > threshold * 0.8);
        });
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
}
