/**
 * One 1:1 WebRTC call. The side that waited longer (initiator) makes the
 * offer, so there is never offer "glare". ICE candidates that arrive before
 * the remote description are queued. On failure the initiator tries one ICE
 * restart before the app gives up and moves on.
 *
 * events: 'remote' (detail: MediaStream), 'state' (detail: connectionState)
 */
export class Call extends EventTarget {
  constructor({ stream, iceServers, initiator, send }) {
    super();
    this.initiator = initiator;
    this.send = send;
    this.pending = [];
    this.restarted = false;
    this.closed = false;
    this._lastInbound = null;

    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    if (stream) {
      for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
    }
    // Always negotiate both directions, even if this side has no camera or mic.
    const kinds = new Set((stream?.getTracks() || []).map((t) => t.kind));
    if (!kinds.has('audio')) this.pc.addTransceiver('audio', { direction: 'recvonly' });
    if (!kinds.has('video')) this.pc.addTransceiver('video', { direction: 'recvonly' });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    this.pc.ontrack = (e) => {
      const remote = e.streams[0] || new MediaStream([e.track]);
      this.dispatchEvent(new CustomEvent('remote', { detail: remote }));
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === 'failed' && this.initiator && !this.restarted) {
        this.restarted = true;
        this._offer(true).catch(() => {});
        return;
      }
      this.dispatchEvent(new CustomEvent('state', { detail: st }));
    };
  }

  async start() {
    if (this.initiator) await this._offer(false);
  }

  async _offer(iceRestart) {
    if (this.closed) return;
    const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await this.pc.setLocalDescription(offer);
    this.send({ sdp: { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp } });
  }

  async handle(msg) {
    if (this.closed) return;
    try {
      if (msg.sdp) {
        await this.pc.setRemoteDescription(msg.sdp);
        for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
        if (msg.sdp.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.send({ sdp: { type: answer.type, sdp: this.pc.localDescription.sdp } });
        }
      } else if (msg.candidate) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(msg.candidate).catch(() => {});
        else this.pending.push(msg.candidate);
      }
    } catch (err) {
      console.warn('[rtc] signaling error', err);
    }
  }

  replaceTrack(track) {
    const sender =
      this.pc.getSenders().find((s) => s.track?.kind === track.kind) ||
      this.pc.getTransceivers().find((t) => t.receiver.track?.kind === track.kind && t.direction !== 'recvonly')?.sender;
    if (sender) return sender.replaceTrack(track).catch(() => {});
    return Promise.resolve();
  }

  /** { rtt (s), loss (0..1), relay (bool) } — sampled from getStats(). */
  async quality() {
    if (this.closed) return null;
    const report = await this.pc.getStats();
    let rtt = null;
    let relay = false;
    let lost = 0;
    let received = 0;
    const byId = new Map();
    report.forEach((s) => byId.set(s.id, s));
    report.forEach((s) => {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) {
        if (typeof s.currentRoundTripTime === 'number') rtt = s.currentRoundTripTime;
        const local = byId.get(s.localCandidateId);
        if (local?.candidateType === 'relay') relay = true;
      }
      if (s.type === 'inbound-rtp' && !s.isRemote) {
        lost += s.packetsLost || 0;
        received += s.packetsReceived || 0;
      }
    });
    let loss = 0;
    if (this._lastInbound) {
      const dl = lost - this._lastInbound.lost;
      const dr = received - this._lastInbound.received;
      loss = dl + dr > 0 ? Math.max(0, dl) / (dl + dr) : 0;
    }
    this._lastInbound = { lost, received };
    return { rtt, loss, relay };
  }

  close() {
    this.closed = true;
    try {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
    } catch { /* already closed */ }
  }
}
