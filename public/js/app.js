import { io } from '/socket.io/socket.io.esm.min.js';
import { COUNTRIES, SPOKEN_LANGUAGES, UI_LOCALES, INTERESTS, REACTIONS } from '/shared/data.js';
import {
  initI18n, setLang, t, tRich, countryName, languageName, nativeLanguageName, fmtNum, fmtList,
  compare, getLang, fmtDateTime, normalizeTag,
} from './i18n.js';
import { openPicker, closePicker, pickerOpen } from './picker.js';
import { Media } from './media.js';
import { Call } from './rtc.js';
import { sounds } from './sounds.js';
import { $, el, icon, flagEl, store, uuid, debounce, fmtClock, randomName } from './util.js';

/* ==========================================================================
   Constants & state
   ========================================================================== */
const NAME_RE = /^[\p{L}\p{M}\p{N}_. -]{2,20}$/u;
const QUIET_AFTER_MS = 20_000;
const CONNECT_TIMEOUT_MS = 20_000;
const AUTO_NEXT_SEC = 3;
const ANY = Object.freeze({ gender: 'any', country: 'any', language: 'any' });
const IN_CALL_STATES = ['searching', 'connecting', 'connected', 'ended'];
const SPOKEN_CODES = SPOKEN_LANGUAGES.map((l) => l[0]);
const COUNTRY_SET = new Set(COUNTRIES.map((c) => c[0]));

const media = new Media();
/** Isolate user-supplied text inside a translated sentence so RTL/LTR mixes render correctly. */
const bidi = (s) => `\u2068${s}\u2069`;

const S = {
  state: 'boot',
  deviceId: null,
  profile: null,
  filters: { ...ANY },
  interests: [],
  settings: {},
  server: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], detectedCountry: null, lockCountry: false, reportSnapshots: true },
  registered: false,
  verified: false,
  camState: 'off',
  countryCounts: {},
  matching: null,
  search: { since: 0, widened: false, quietDismissed: false },
  match: null,
  call: null,
  endedName: '',
  unread: 0,
  resume: false,
  typingSent: false,
  filteredNoticeShown: false,
  timers: {},
  lastFocus: null,
};
let socket = null;

/* ==========================================================================
   Boot
   ========================================================================== */
async function boot() {
  S.deviceId = store.get('device');
  if (typeof S.deviceId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(S.deviceId)) {
    S.deviceId = uuid();
    store.set('device', S.deviceId);
  }
  S.profile = validProfile(store.get('profile'));
  S.filters = sanitizeFilters(store.get('filters'));
  S.interests = (store.get('interests') || []).filter((i) => INTERESTS.includes(i)).slice(0, 5);
  S.settings = {
    theme: 'system', safeView: false, autoNext: true, sounds: true,
    cameraId: '', micId: '', speakerId: '', pip: 'corner-br',
    ...(store.get('settings') || {}),
  };
  sounds.enabled = S.settings.sounds;
  applyTheme();
  await initI18n();

  media.attachMeter($('micMeter'));
  media.attachMeter($('onbMeter'));
  buildStatic();
  wire();
  connect();

  if (S.profile) {
    setState('idle');
    primeLobbyCamera();
  } else {
    openOnboarding(1);
  }
  renderAll();
}

function validProfile(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.username !== 'string' || !NAME_RE.test(p.username)) return null;
  if (p.gender !== 'male' && p.gender !== 'female') return null;
  if (!COUNTRY_SET.has(p.country)) return null;
  const languages = Array.isArray(p.languages) ? p.languages.filter((l) => SPOKEN_CODES.includes(l)).slice(0, 3) : [];
  if (!languages.length || p.adult !== true) return null;
  return { username: p.username, gender: p.gender, country: p.country, languages, adult: true };
}

function sanitizeFilters(f) {
  f = f && typeof f === 'object' ? f : {};
  return {
    gender: ['male', 'female'].includes(f.gender) ? f.gender : 'any',
    country: COUNTRY_SET.has(f.country) ? f.country : 'any',
    language: SPOKEN_CODES.includes(f.language) ? f.language : 'any',
  };
}

const hasFilters = (f) => f.gender !== 'any' || f.country !== 'any' || f.language !== 'any';
const saveSettings = () => store.set('settings', S.settings);

/* ==========================================================================
   Socket
   ========================================================================== */
function connect() {
  socket = io({
    auth: { deviceId: S.deviceId },
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnectionDelayMax: 8000,
  });

  socket.on('welcome', onWelcome);
  socket.on('online', (n) => setOnline(n));
  socket.on('match:searching', () => {});
  socket.on('match:found', onMatchFound);
  socket.on('match:error', onMatchError);
  socket.on('rtc:signal', (msg) => {
    if (S.call && S.match && msg && msg.matchId === S.match.id) S.call.handle(msg);
  });
  socket.on('peer:left', onPeerLeft);
  socket.on('peer:state', onPeerState);
  socket.on('chat:message', onChatMessage);
  socket.on('chat:typing', onTyping);
  socket.on('react', (emoji) => { if (S.state === 'connected') floatEmoji(emoji, false); });
  socket.on('banned', showBanned);
  socket.on('connect_error', (err) => {
    if (err.message === 'banned') showBanned(err.data || {});
    else if (err.message === 'too_many_connections') toast(t('toast.tooMany'), 6000);
  });
  socket.on('disconnect', onDisconnect);
  socket.io.on('reconnect', () => toast(t('toast.online'), 1800));
}

async function onWelcome(w) {
  S.server = { ...S.server, ...w };
  if (w.deviceId && w.deviceId !== S.deviceId) {
    S.deviceId = w.deviceId;
    store.set('device', w.deviceId);
  }
  setOnline(w.online);
  renderOnboardingDynamic();
  if (S.profile) {
    const res = await registerProfile(S.profile);
    if (!res.ok && res.error !== 'generic') {
      openOnboarding(res.error.startsWith('name') ? 1 : 3, { editing: true, error: res.error });
      return;
    }
    if (S.resume) {
      S.resume = false;
      startChat();
    }
  }
  refreshEstimate();
}

function registerProfile(p) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(
      'profile:set',
      { username: p.username, gender: p.gender, country: p.country, languages: p.languages },
      (err, ack) => {
        if (err || !ack) return resolve({ ok: false, error: 'generic' });
        if (ack.ok) {
          S.registered = true;
          S.verified = !!ack.profile.verified;
          S.profile = { ...p, username: ack.profile.username, country: ack.profile.country, adult: true };
          store.set('profile', S.profile);
          renderProfileChip();
        }
        resolve(ack);
      },
    );
  });
}

function onDisconnect(reason) {
  S.registered = false;
  if (IN_CALL_STATES.includes(S.state)) {
    teardownCall();
    S.match = null;
    clearChat();
    S.resume = true;
    setState('idle');
  }
  if (reason !== 'io client disconnect' && $('banned').hidden) toast(t('toast.offline'), 3000);
}

function onMatchError({ error } = {}) {
  if (error === 'profile_required' && S.profile) {
    S.resume = true;
    setState('idle');
    registerProfile(S.profile).then((r) => { if (r.ok && S.resume) { S.resume = false; startChat(); } });
    return;
  }
  toast(t(`err.${error}`) === `err.${error}` ? t('err.generic') : t(`err.${error}`));
  if (S.state === 'searching') setState('idle');
}

/* ==========================================================================
   State machine: boot → onboarding → idle → searching → connecting → connected → ended
   ========================================================================== */
function setState(s) {
  S.state = s;
  document.body.dataset.state = s;
  const inCall = s === 'connected';
  $('chatInput').disabled = !inCall;
  $('sendBtn').disabled = !inCall;
  media.setMetering(s === 'idle' || s === 'onboarding');

  if (s === 'searching') startSearchTicker(); else stopSearchTicker();
  if (s === 'idle') {
    attach($('localPreview'), media.stream);
    refreshEstimate();
  }
  if (IN_CALL_STATES.includes(s)) attach($('localVideo'), media.stream);
  renderOverlay();
}

function attach(video, stream) {
  if (video.srcObject !== stream) video.srcObject = stream || null;
  if (stream) video.play().catch(() => {});
}

/* ==========================================================================
   Camera & microphone
   ========================================================================== */
async function primeLobbyCamera() {
  if (!Media.supported()) return renderCamState('insecure');
  if (media.live) return renderCamState(null);
  const perm = await Media.permission();
  if (perm === 'granted') ensureCamera().catch(() => {});
  else renderCamState(perm === 'denied' ? 'blocked' : 'off');
}

async function ensureCamera() {
  try {
    await media.start({ cameraId: S.settings.cameraId, micId: S.settings.micId });
    renderCamState(null);
    attach($('localPreview'), media.stream);
    attach($('localVideo'), media.stream);
    attach($('onbVideo'), media.stream);
    media.setMetering(S.state === 'idle' || S.state === 'onboarding');
    await renderMediaButtons();
    return media.stream;
  } catch (err) {
    const kind = Media.classify(err);
    renderCamState(kind === 'other' ? 'notfound' : kind);
    toast(t(camCopy(kind === 'other' ? 'notfound' : kind).title), 3500);
    throw err;
  }
}

function camCopy(kind) {
  return {
    off: { title: 'cam.off', hint: '', btn: 'cam.enable' },
    blocked: { title: 'cam.blocked', hint: 'cam.blockedHint', btn: 'cam.retry' },
    insecure: { title: 'cam.insecure', hint: 'cam.insecureHint', btn: null },
    notfound: { title: 'cam.notFound', hint: 'cam.notFoundHint', btn: 'cam.retry' },
  }[kind] || { title: 'cam.off', hint: '', btn: 'cam.enable' };
}

function renderCamState(kind) {
  S.camState = kind;
  $('selfie').classList.toggle('no-cam', !!kind);
  if (!kind) return;
  const c = camCopy(kind);
  $('camStateTitle').textContent = t(c.title);
  $('camStateHint').textContent = c.hint ? t(c.hint) : '';
  $('camStateBtn').hidden = !c.btn;
  if (c.btn) $('camStateBtn').textContent = t(c.btn);
}

async function renderMediaButtons() {
  const micOn = media.micOn;
  const camOn = media.camOn;
  for (const b of [$('micBtn'), $('lobbyMic')]) {
    b.classList.toggle('is-off', !micOn);
    b.setAttribute('aria-label', t(micOn ? 'call.mute' : 'call.unmute'));
    b.title = b.getAttribute('aria-label');
    b.setAttribute('aria-pressed', String(!micOn));
  }
  for (const b of [$('camBtn'), $('lobbyCam')]) {
    b.classList.toggle('is-off', !camOn);
    b.setAttribute('aria-label', t(camOn ? 'call.camOff' : 'call.camOn'));
    b.title = b.getAttribute('aria-label');
    b.setAttribute('aria-pressed', String(!camOn));
  }
  $('pip').classList.toggle('cam-off', !camOn);
  const { video } = media.live ? await media.devices() : { video: [] };
  $('flipBtn').hidden = !(video.length > 1 && media.videoTrack);
}

function toggleMic() {
  if (!media.audioTrack) return;
  media.setMic(!media.micOn);
  renderMediaButtons();
  toast(t(media.micOn ? 'toast.micOn' : 'toast.micOff'), 1300);
  sendPeerState();
}

function toggleCam() {
  if (!media.videoTrack) return;
  media.setCam(!media.camOn);
  renderMediaButtons();
  toast(t(media.camOn ? 'toast.camOn' : 'toast.camOff'), 1300);
  sendPeerState();
}

async function flipCamera() {
  try {
    const track = await media.flip();
    if (S.call) await S.call.replaceTrack(track);
    attach($('localVideo'), media.stream);
  } catch { toast(t('cam.notFound')); }
}

function sendPeerState() {
  if (S.state === 'connected' || S.state === 'connecting') socket.emit('peer:state', { mic: media.micOn, cam: media.camOn });
}

/* ==========================================================================
   Matching flow
   ========================================================================== */
async function startChat() {
  if (S.state !== 'idle') return;
  if (!S.profile) return openOnboarding(1);
  if (!media.live) {
    try { await ensureCamera(); } catch { return; }
  }
  if (!S.registered) {
    S.resume = true; // will start as soon as the server accepts our profile
    toast(t('toast.offline'), 2000);
    return;
  }
  S.search = { since: Date.now(), widened: false, quietDismissed: false };
  setState('searching');
  socket.emit('match:find', { filters: S.filters, interests: S.interests });
}

function next() {
  if (!IN_CALL_STATES.includes(S.state)) return;
  if (S.state === 'searching') return; // already queued: re-queuing would lose our place
  closeModals();
  clearEndedCountdown();
  teardownCall();
  S.match = null;
  clearChat();
  S.search.since = Date.now();
  setState('searching');
  socket.emit('match:next');
}

function stopChat() {
  closeModals();
  clearEndedCountdown();
  teardownCall();
  S.match = null;
  clearChat();
  socket.emit('match:stop');
  setState('idle');
}

function widenSearch() {
  S.search.widened = true;
  socket.emit('match:find', { filters: ANY, interests: S.interests });
  renderOverlay();
}

function onMatchFound({ matchId, initiator, peer }) {
  // Only valid while we're queued. If the user pressed Stop at the same moment
  // the server paired us, our match:stop (already sent) ends it server-side.
  if (S.state !== 'searching') return;
  clearEndedCountdown();
  teardownCall();
  clearChat();
  S.match = { id: matchId, initiator, peer, startedAt: Date.now(), connectedAt: 0 };
  S.filteredNoticeShown = false;
  renderPeer();
  setState('connecting');
  if (document.hidden) document.title = `● ${t('title.matched')}`;

  const call = new Call({
    stream: media.stream,
    iceServers: S.server.iceServers,
    initiator,
    send: (data) => socket.emit('rtc:signal', { matchId, ...data }),
  });
  S.call = call;
  call.addEventListener('remote', (e) => {
    const v = $('remoteVideo');
    if (v.srcObject !== e.detail) {
      v.srcObject = e.detail;
      v.play().catch(() => {});
      applySpeaker();
    }
  });
  call.addEventListener('state', (e) => onCallState(call, e.detail));
  call.start().catch((err) => console.warn('[rtc]', err));
  S.timers.connect = setTimeout(() => {
    if (S.call === call && S.state === 'connecting') {
      toast(t('fail.connect'));
      next();
    }
  }, CONNECT_TIMEOUT_MS);
}

function onCallState(call, st) {
  if (call !== S.call) return;
  if (st === 'connected') {
    clearTimeout(S.timers.connect);
    clearTimeout(S.timers.disc);
    if (S.state !== 'connecting') return;
    // Keep "Connecting…" up until the first video frame arrives, so nobody
    // stares at a black screen while the stream ramps up (3.5 s fallback for
    // partners whose camera is off).
    const v = $('remoteVideo');
    if (v.readyState < 2) {
      const live = () => { clearTimeout(S.timers.firstFrame); goLive(call); };
      v.addEventListener('loadeddata', live, { once: true });
      S.timers.firstFrame = setTimeout(live, 3500);
      return;
    }
    goLive(call);
  } else if (st === 'failed') {
    toast(t('fail.connect'));
    next();
  } else if (st === 'disconnected') {
    clearTimeout(S.timers.disc);
    S.timers.disc = setTimeout(() => {
      if (S.call === call && call.pc.connectionState !== 'connected') {
        toast(t('fail.connect'));
        next();
      }
    }, 8000);
  }
}

function goLive(call) {
  if (call !== S.call || S.state !== 'connecting' || !S.match) return;
  S.match.connectedAt = Date.now();
  setState('connected');
  sounds.match();
  $('stage').classList.toggle('safe-blur', !!S.settings.safeView);
  sendPeerState();
  startCallTicker();
  const peer = S.match.peer;
  sysMessage(t('chat.connected', { name: bidi(peer.username), country: countryName(peer.country) }));
  announce(t('chat.connected', { name: bidi(peer.username), country: countryName(peer.country) }));
}

function onPeerLeft({ matchId } = {}) {
  if (!S.match || matchId !== S.match.id) return;
  S.endedName = S.match.peer.username;
  teardownCall();
  sounds.leave();
  sysMessage(t('chat.left'));
  $('chatInput').disabled = true;
  S.match = null;
  setState('ended');
  announce(t('ended.left', { name: bidi(S.endedName) }));
  if (S.settings.autoNext) startEndedCountdown();
}

function teardownCall() {
  clearTimeout(S.timers.connect);
  clearTimeout(S.timers.disc);
  clearTimeout(S.timers.firstFrame);
  stopCallTicker();
  if (S.call) {
    S.call.close();
    S.call = null;
  }
  const v = $('remoteVideo');
  v.srcObject = null;
  $('stage').classList.remove('peer-cam-off', 'safe-blur');
  $('peerMuted').hidden = true;
  closeReact();
  hideTyping();
  if (!document.hidden) document.title = t('meta.title');
}

function startEndedCountdown() {
  clearEndedCountdown();
  let n = AUTO_NEXT_SEC;
  const tick = () => {
    if (S.state !== 'ended') return clearEndedCountdown();
    if (n <= 0) { clearEndedCountdown(); next(); return; }
    $('overlaySub').textContent = t('ended.autonext', { n });
    n -= 1;
  };
  tick();
  S.timers.ended = setInterval(tick, 1000);
}
function clearEndedCountdown() { clearInterval(S.timers.ended); S.timers.ended = null; }

/* ---------- search ticker (elapsed time, live estimate, "it's quiet" prompt) ---------- */
function startSearchTicker() {
  stopSearchTicker();
  let n = 0;
  S.timers.search = setInterval(() => {
    n += 1;
    if (n % 5 === 0) refreshEstimate();
    updateSearchMeta();
    $('quietBox').hidden = !shouldShowQuiet();
  }, 1000);
  updateSearchMeta();
}
function stopSearchTicker() { clearInterval(S.timers.search); S.timers.search = null; }
function shouldShowQuiet() {
  return S.state === 'searching' && !S.search.widened && !S.search.quietDismissed &&
    hasFilters(S.filters) && Date.now() - S.search.since >= QUIET_AFTER_MS;
}
function updateSearchMeta() {
  if (S.state !== 'searching') return;
  const parts = [fmtClock((Date.now() - S.search.since) / 1000)];
  if (S.matching !== null && !S.search.widened) parts.push(t('lobby.estimate', { n: fmtNum(S.matching) }));
  $('overlayMeta').textContent = parts.join('  ·  ');
}

/* ---------- call ticker (timer + connection quality) ---------- */
function startCallTicker() {
  stopCallTicker();
  let n = 0;
  const tick = async () => {
    if (!S.match || !S.call) return;
    $('callTimer').textContent = fmtClock((Date.now() - S.match.connectedAt) / 1000);
    if (n++ % 3 === 0) {
      const q = await S.call.quality().catch(() => null);
      if (!q) return;
      const level = q.rtt === null ? 'good'
        : q.rtt < 0.3 && q.loss < 0.02 ? 'good'
        : q.rtt < 0.7 && q.loss < 0.08 ? 'fair' : 'poor';
      const node = $('quality');
      node.dataset.level = level;
      node.title = `${t(`quality.${level}`)}${q.rtt !== null ? ` · ${Math.round(q.rtt * 1000)} ms` : ''}${q.relay ? ' · TURN' : ''}`;
      node.setAttribute('aria-label', node.title);
    }
  };
  tick();
  S.timers.call = setInterval(tick, 1000);
}
function stopCallTicker() { clearInterval(S.timers.call); S.timers.call = null; $('callTimer').textContent = '00:00'; }

/* ==========================================================================
   Chat
   ========================================================================== */
const canTranslate = typeof self !== 'undefined' && 'Translator' in self;

function clearChat() {
  $('messages').replaceChildren(el('p', { class: 'chat-hint', text: t('chat.hint') }));
  S.unread = 0;
  updateBadge();
  hideTyping();
}

function addMessage(text, who, { translatable = false } = {}) {
  const box = $('messages');
  box.querySelector('.chat-hint')?.remove();
  const msg = el('div', { class: `msg ${who}` }, el('span', { class: 'msg-text', dir: 'auto', text }));
  if (translatable && canTranslate) {
    const btn = el('button', { class: 'tr-btn', type: 'button' }, icon('i-translate'), el('span', { text: t('chat.translate') }));
    btn.addEventListener('click', () => translateMessage(msg, text, btn));
    msg.append(btn);
  }
  box.append(msg);
  box.scrollTop = box.scrollHeight;
  return msg;
}

function sysMessage(text) { addMessage(text, 'sys'); }

async function translateMessage(msg, original, btn) {
  const textNode = msg.querySelector('.msg-text');
  if (msg.dataset.translated === '1') {
    textNode.textContent = original;
    msg.dataset.translated = '0';
    btn.lastChild.textContent = t('chat.translate');
    msg.querySelector('.tr-note')?.remove();
    return;
  }
  btn.disabled = true;
  try {
    const translated = await translateText(original, S.match?.peer?.languages?.[0]);
    if (translated === null) throw new Error('same-language');
    textNode.textContent = translated;
    msg.dataset.translated = '1';
    btn.lastChild.textContent = t('chat.showOriginal');
  } catch {
    toast(t('chat.translateFail'), 3000);
  } finally {
    btn.disabled = false;
  }
}

/** On-device translation with Chrome's built-in Translator API (no server, no cost). */
async function translateText(text, hint) {
  const target = getLang();
  let source = hint || 'en';
  if ('LanguageDetector' in self) {
    try {
      S.detector ||= await self.LanguageDetector.create();
      const [top] = await S.detector.detect(text);
      if (top && top.detectedLanguage && top.detectedLanguage !== 'und' && top.confidence > 0.4) source = top.detectedLanguage;
    } catch { /* fall back to the partner's first language */ }
  }
  source = normalizeTag(source);
  if (source === target) return null;
  S.translators ||= new Map();
  const key = `${source}>${target}`;
  if (!S.translators.has(key)) {
    S.translators.set(key, self.Translator.create({ sourceLanguage: source, targetLanguage: target }));
  }
  try {
    const tr = await S.translators.get(key);
    return await tr.translate(text);
  } catch (err) {
    S.translators.delete(key);
    throw err;
  }
}

function sendChat(e) {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text || S.state !== 'connected') return;
  input.value = '';
  stopTyping();
  socket.timeout(6000).emit('chat:send', text, (err, ack) => {
    if (err || !ack?.ok) {
      if (ack?.error === 'rate_limited') toast(t('err.rate_limited'));
      return;
    }
    addMessage(ack.text, 'me');
    if (ack.filtered && !S.filteredNoticeShown) {
      S.filteredNoticeShown = true;
      sysMessage(t('chat.filtered'));
    }
  });
}

function onChatMessage({ text } = {}) {
  if (S.state !== 'connected' || typeof text !== 'string') return;
  hideTyping();
  addMessage(text, 'them', { translatable: true });
  const chatVisible = document.body.dataset.chat === 'open' && !document.hidden;
  if (!chatVisible) {
    S.unread += 1;
    updateBadge();
    sounds.message();
  }
}

function onChatInput() {
  if (S.state !== 'connected') return;
  if (!S.typingSent) {
    S.typingSent = true;
    socket.emit('chat:typing', true);
  }
  clearTimeout(S.timers.typing);
  S.timers.typing = setTimeout(stopTyping, 2500);
}
function stopTyping() {
  clearTimeout(S.timers.typing);
  if (S.typingSent) {
    S.typingSent = false;
    socket.emit('chat:typing', false);
  }
}
function onTyping(on) {
  if (!S.match) return;
  const node = $('typing');
  clearTimeout(S.timers.peerTyping);
  if (on) {
    node.textContent = t('chat.typing', { name: bidi(S.match.peer.username) });
    node.hidden = false;
    S.timers.peerTyping = setTimeout(hideTyping, 5000);
  } else hideTyping();
}
function hideTyping() { $('typing').hidden = true; }

function updateBadge() {
  const b = $('chatBadge');
  b.textContent = S.unread > 9 ? '9+' : String(S.unread);
  b.classList.toggle('show', S.unread > 0);
}

function setChatOpen(open, focus = false) {
  document.body.dataset.chat = open ? 'open' : 'closed';
  if (open) {
    S.unread = 0;
    updateBadge();
    if (focus) setTimeout(() => $('chatInput').focus(), 50);
  }
}

/* ==========================================================================
   Reactions, peer state, safety
   ========================================================================== */
function floatEmoji(emoji, mine) {
  const layer = $('reactionsLayer');
  const x = mine ? 70 + Math.random() * 18 : 12 + Math.random() * 36;
  const node = el('span', { class: 'float-emoji', text: emoji });
  node.style.insetInlineStart = `${x}%`;
  layer.append(node);
  setTimeout(() => node.remove(), 2600);
}

function sendReaction(emoji) {
  if (S.state !== 'connected') return;
  socket.emit('react', emoji);
  floatEmoji(emoji, true);
  closeReact();
}
function closeReact() {
  $('reactPop').hidden = true;
  $('reactBtn').setAttribute('aria-expanded', 'false');
}

function onPeerState({ mic, cam } = {}) {
  $('peerMuted').hidden = mic !== false;
  $('stage').classList.toggle('peer-cam-off', cam === false);
}

function captureSnapshot() {
  const v = $('remoteVideo');
  if (!v.videoWidth || !v.videoHeight) return null;
  const w = 360;
  const h = Math.round((w * v.videoHeight) / v.videoWidth);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  try {
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

function submitReport(reason) {
  if (!S.match) return closeModals();
  const snapshot = S.server.reportSnapshots ? captureSnapshot() : null;
  socket.timeout(8000).emit('report', { reason, snapshot }, (err, ack) => {
    if (!err && ack?.ok) toast(t('report.done'), 3200);
  });
  next();
}

function confirmBlock() {
  if (!S.match) return closeModals();
  socket.emit('block', () => toast(t('block.done'), 2600));
  next();
}

function showBanned({ until = null } = {}) {
  teardownCall();
  $('banned').hidden = false;
  $('bannedText').textContent = until ? t('banned.until', { time: fmtDateTime(until) }) : t('banned.permanent');
}

/* ==========================================================================
   Onboarding
   ========================================================================== */
const O = { step: 1, name: '', gender: '', country: '', languages: [], editing: false, busy: false };

function defaultLanguages() {
  const out = [];
  const ui = getLang();
  if (SPOKEN_CODES.includes(ui)) out.push(ui);
  for (const tag of navigator.languages || []) {
    const c = normalizeTag(tag);
    if (SPOKEN_CODES.includes(c) && !out.includes(c)) out.push(c);
    if (out.length >= 2) break;
  }
  return out.length ? out : ['en'];
}

function openOnboarding(step = 1, { editing = false, error = null } = {}) {
  closeModals();
  if (IN_CALL_STATES.includes(S.state)) stopChat();
  const p = S.profile;
  O.editing = editing;
  O.name = p?.username || '';
  O.gender = p?.gender || '';
  O.country = p?.country || S.server.detectedCountry || '';
  O.languages = p?.languages?.length ? [...p.languages] : defaultLanguages();
  $('onbName').value = O.name;
  $('onbAdult').checked = !!p?.adult;
  $('onboard').hidden = false;
  setState('onboarding');
  goStep(step);
  if (error) onbError(`err.${error}`);
}

function goStep(n) {
  O.step = n;
  document.querySelectorAll('.onb-pane').forEach((p) => { p.hidden = Number(p.dataset.step) !== n; });
  document.querySelectorAll('.progress i').forEach((b, i) => b.classList.toggle('done', i < n));
  $('onbBack').disabled = n === 1;
  $('onbErr').hidden = true;
  renderOnboardingDynamic();
  if (n === 1) setTimeout(() => $('onbName').focus(), 60);
  if (n === 4) {
    const live = media.live;
    $('onbPreview').classList.toggle('live', live);
    if (live) attach($('onbVideo'), media.stream);
    const msg = $('onbCamMsg');
    msg.hidden = !live;
    msg.className = 'onb-cam-msg ok';
    msg.textContent = live ? t('onb.cam.ready') : '';
  }
}

function renderOnboardingDynamic() {
  $('onbStep').textContent = t('onb.step', { n: O.step, total: 4 });
  const hint = S.server.lockCountry ? 'onb.country.locked' : S.server.detectedCountry ? 'onb.country.detected' : 'onb.country.choose';
  $('onbCountryHint').textContent = t(hint);
  if (S.server.lockCountry && S.server.detectedCountry) O.country = S.server.detectedCountry;
  $('onbCountryBtn').disabled = !!S.server.lockCountry;
  setSelectBtn($('onbCountryBtn'), flagEl(O.country || null), O.country ? countryName(O.country) : t('err.country'));
  $('onbAdultText').replaceChildren(tRich('onb.age', {
    link: el('a', { href: '/legal#guidelines', target: '_blank', rel: 'noopener', text: t('legal.guidelines') }),
  }));
  document.querySelectorAll('#onbGender button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.val === O.gender)));
  renderOnbLanguages();
  const live = media.live;
  $('onbNext').textContent = O.step === 4 ? t(live ? 'onb.finish' : 'onb.cam.allow') : t('common.continue');
  $('onbSkip').hidden = !(O.step === 4 && !live);
}

function renderOnbLanguages() {
  const box = $('onbLangs');
  box.replaceChildren();
  for (const code of O.languages) {
    const x = el('button', { class: 'chip-x', type: 'button', 'aria-label': `${t('common.close')} ${languageName(code)}` }, icon('i-close', 'ic ic-sm'));
    x.addEventListener('click', () => {
      O.languages = O.languages.filter((l) => l !== code);
      renderOnbLanguages();
    });
    box.append(el('span', { class: 'chip chip-static' }, languageName(code), x));
  }
  if (O.languages.length < 3) {
    const add = el('button', { class: 'chip chip-add', type: 'button' }, icon('i-plus', 'ic ic-sm'), t('onb.langs.add'));
    add.addEventListener('click', () => {
      openPicker({
        anchor: add,
        options: languageOptions({ exclude: O.languages }),
        value: null,
        placeholder: t('common.search'),
        emptyText: t('common.noResults'),
        onSelect: (code) => {
          if (!O.languages.includes(code) && O.languages.length < 3) O.languages.push(code);
          renderOnbLanguages();
        },
      });
    });
    box.append(add);
  }
}

function onbError(key) {
  const n = $('onbErr');
  n.textContent = t(key);
  n.hidden = false;
}

async function onbNext() {
  if (O.busy) return;
  const step = O.step;
  if (step === 1) {
    const name = $('onbName').value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!NAME_RE.test(name) || !/\p{L}/u.test(name)) return onbError('err.name_invalid');
    O.name = name;
    return goStep(2);
  }
  if (step === 2) {
    if (!O.gender) return onbError('err.gender');
    return goStep(3);
  }
  if (step === 3) {
    if (!O.country) return onbError('err.country');
    if (!O.languages.length) return onbError('err.languages');
    if (!$('onbAdult').checked) return onbError('err.age');
    const profile = { username: O.name, gender: O.gender, country: O.country, languages: O.languages, adult: true };
    O.busy = true;
    $('onbNext').disabled = true;
    const res = await registerProfile(profile);
    O.busy = false;
    $('onbNext').disabled = false;
    if (!res.ok) {
      if (res.error === 'generic') {
        S.profile = profile; // offline: keep it, the server validates on reconnect
        store.set('profile', profile);
      } else if (res.error.startsWith('name')) {
        goStep(1);
        return onbError(`err.${res.error}`);
      } else {
        return onbError(`err.${res.error}`);
      }
    }
    if (media.live) return finishOnboarding();
    return goStep(4);
  }
  if (step === 4) {
    if (media.live) return finishOnboarding();
    O.busy = true;
    try {
      await ensureCamera();
      goStep(4);
    } catch (err) {
      const kind = Media.classify(err);
      const c = camCopy(kind === 'other' ? 'notfound' : kind);
      const msg = $('onbCamMsg');
      msg.hidden = false;
      msg.className = 'onb-cam-msg bad';
      msg.textContent = `${t(c.title)}. ${c.hint ? t(c.hint) : ''}`;
      renderOnboardingDynamic();
    } finally {
      O.busy = false;
    }
  }
}

function finishOnboarding() {
  $('onboard').hidden = true;
  setState('idle');
  renderAll();
  if (!media.live) primeLobbyCamera();
  refreshEstimate();
}

/* ==========================================================================
   Pickers: countries, languages, UI language
   ========================================================================== */
function countryOptions({ includeAny, counts = null, highlight = null }) {
  const withCount = (code) => (counts && counts[code] ? t('filter.onlineIn', { n: fmtNum(counts[code]) }) : '');
  const opt = (code, en, group) => ({
    value: code, label: countryName(code), keywords: `${en} ${code}`, group,
    icon: () => flagEl(code), meta: withCount(code),
  });
  const all = COUNTRIES.map(([code, en]) => opt(code, en, t('filter.allCountries')));
  all.sort((a, b) => compare(a.label, b.label));
  const out = [];
  if (includeAny) out.push({ value: 'any', label: t('filter.anywhere'), keywords: 'any world global', icon: () => flagEl(null) });
  if (highlight && COUNTRY_SET.has(highlight)) out.push(opt(highlight, '', t('filter.yourCountry')));
  if (counts) {
    const popular = Object.entries(counts)
      .filter(([c, n]) => n > 0 && c !== highlight && COUNTRY_SET.has(c))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    for (const [c] of popular) out.push(opt(c, '', t('filter.popular')));
  }
  return out.concat(all);
}

function languageOptions({ includeAny = false, exclude = [], mine = [] } = {}) {
  const opt = (code, group) => {
    const label = languageName(code);
    const native = nativeLanguageName(code);
    return {
      value: code, label, sub: native !== label ? native : '', keywords: `${native} ${code}`, group,
      icon: () => el('span', { class: 'lang-code', text: code.toUpperCase() }),
    };
  };
  const all = SPOKEN_CODES.filter((c) => !exclude.includes(c)).map((c) => opt(c, t('filter.allLanguages')));
  all.sort((a, b) => compare(a.label, b.label));
  const out = [];
  if (includeAny) out.push({ value: 'any', label: t('filter.anyLanguage'), keywords: 'any', icon: () => icon('i-globe') });
  for (const c of mine) if (!exclude.includes(c)) out.push(opt(c, t('onb.langs.title')));
  return out.concat(all);
}

function openUiLanguagePicker(anchor) {
  openPicker({
    anchor,
    value: getLang(),
    placeholder: t('common.search'),
    emptyText: t('common.noResults'),
    options: UI_LOCALES.map(([code, native]) => {
      const local = languageName(code);
      return {
        value: code, label: native, sub: local !== native ? local : '', keywords: `${local} ${code}`,
        icon: () => el('span', { class: 'lang-code', text: code.toUpperCase() }),
      };
    }),
    onSelect: async (code) => {
      await setLang(code);
      renderAll();
    },
  });
}

function setSelectBtn(btn, iconNode, label) {
  btn.replaceChildren(iconNode, el('span', { class: 'sb-label', text: label }), icon('i-chevron', 'ic sb-chev'));
}

/* ==========================================================================
   Rendering
   ========================================================================== */
function buildStatic() {
  const pop = $('reactPop');
  for (const emoji of REACTIONS) {
    const b = el('button', { type: 'button', text: emoji, 'aria-label': emoji });
    b.addEventListener('click', () => sendReaction(emoji));
    pop.append(b);
  }
  $('pip').className = `pip ${S.settings.pip || 'corner-br'}`;
  if (!('setSinkId' in HTMLMediaElement.prototype)) $('speakerRow').hidden = true;
  document.body.dataset.chat = window.matchMedia('(max-width: 960px)').matches ? 'closed' : 'open';
}

function renderAll() {
  const native = UI_LOCALES.find((l) => l[0] === getLang())?.[1] || 'English';
  $('langLabel').textContent = native;
  renderFilters();
  renderInterests();
  renderProfileChip();
  renderCamState(S.camState);
  renderMediaButtons();
  renderEstimate();
  renderOverlay();
  renderOnboardingDynamic();
  if (S.match) renderPeer();
  const hint = $('messages').querySelector('.chat-hint');
  if (hint) hint.textContent = t('chat.hint');
  if (!$('messages').children.length) clearChat();
  if (!$('settingsModal').hidden) renderSettings();
}

function renderFilters() {
  document.querySelectorAll('#genderFilter button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.val === S.filters.gender)));
  const c = S.filters.country;
  setSelectBtn($('countryFilterBtn'), flagEl(c === 'any' ? null : c), c === 'any' ? t('filter.anywhere') : countryName(c));
  const l = S.filters.language;
  setSelectBtn(
    $('languageFilterBtn'),
    l === 'any' ? icon('i-globe') : el('span', { class: 'lang-code', text: l.toUpperCase() }),
    l === 'any' ? t('filter.anyLanguage') : languageName(l),
  );
}

function renderInterests() {
  const box = $('interestChips');
  box.replaceChildren();
  for (const id of INTERESTS) {
    const on = S.interests.includes(id);
    const b = el('button', { class: 'chip', type: 'button', 'aria-pressed': String(on), text: t(`interest.${id}`) });
    b.addEventListener('click', () => {
      if (S.interests.includes(id)) S.interests = S.interests.filter((x) => x !== id);
      else if (S.interests.length < 5) S.interests.push(id);
      else return toast(t('filter.interestsHint'), 1500);
      store.set('interests', S.interests);
      renderInterests();
    });
    box.append(b);
  }
}

function renderProfileChip() {
  const p = S.profile;
  $('profileChip').hidden = !p;
  if (!p) return;
  $('profileFlag').className = `fi fis fi-${p.country.toLowerCase()}`;
  $('profileName').textContent = p.username;
}

function renderEstimate() {
  const node = $('estimate');
  if (S.matching === null) { node.textContent = ''; return; }
  node.textContent = t('lobby.estimate', { n: fmtNum(S.matching) });
  node.classList.toggle('zero', S.matching === 0);
}

const refreshEstimate = debounce(() => {
  if (!socket?.connected) return;
  const filters = S.state === 'searching' && S.search.widened ? ANY : S.filters;
  socket.emit('stats:peek', { filters }, (ack) => {
    if (!ack?.ok) return;
    S.countryCounts = ack.countries || {};
    S.matching = ack.matching;
    setOnline(ack.online);
    renderEstimate();
    updateSearchMeta();
  });
}, 250);

function setOnline(n) {
  if (typeof n === 'number') $('onlineCount').textContent = fmtNum(n);
}

function renderOverlay() {
  const s = S.state;
  $('endedActions').hidden = s !== 'ended';
  $('quietBox').hidden = !shouldShowQuiet();
  const chips = $('overlayChips');
  chips.replaceChildren();
  if (s === 'searching') {
    $('overlayTitle').textContent = t('search.title');
    $('overlaySub').textContent = t(S.search.widened ? 'search.everywhere' : 'search.sub');
    if (!S.search.widened) {
      const f = S.filters;
      if (f.country !== 'any') chips.append(el('span', { class: 'chip chip-static' }, flagEl(f.country), countryName(f.country)));
      if (f.gender !== 'any') chips.append(el('span', { class: 'chip chip-static', text: t(f.gender === 'male' ? 'filter.men' : 'filter.women') }));
      if (f.language !== 'any') chips.append(el('span', { class: 'chip chip-static', text: languageName(f.language) }));
    }
    updateSearchMeta();
  } else if (s === 'connecting') {
    $('overlayTitle').textContent = t('connecting.title');
    $('overlaySub').textContent = S.match ? t('connecting.to', { name: bidi(S.match.peer.username) }) : '';
    $('overlayMeta').textContent = '';
  } else if (s === 'ended') {
    $('overlayTitle').textContent = t('ended.left', { name: bidi(S.endedName || '') });
    $('overlaySub').textContent = '';
    $('overlayMeta').textContent = '';
  }
}

function renderPeer() {
  const p = S.match?.peer;
  if (!p) return;
  $('peerFlag').className = `fi fis peer-flag fi-${p.country.toLowerCase()}`;
  $('peerName').textContent = p.username;
  $('peerVerified').style.display = p.verified ? '' : 'none';
  $('peerVerified').setAttribute('aria-label', t('peer.verified'));
  $('peerVerified').innerHTML = '<title></title><use href="#i-verified"/>';
  $('peerVerified').querySelector('title').textContent = t('peer.verified');
  $('peerCountry').textContent = countryName(p.country);
  const meta = $('peerMeta');
  meta.replaceChildren();
  if (p.languages?.length) meta.append(el('span', { text: t('peer.speaks', { langs: fmtList(p.languages.map(languageName)) }) }));
  if (p.sharedInterests?.length) {
    meta.append(el('span', { class: 'shared', text: t('peer.shared', { list: fmtList(p.sharedInterests.map((i) => t(`interest.${i}`))) }) }));
  }
  $('peerAvatar').textContent = [...p.username][0]?.toLocaleUpperCase() || '?';
  $('chatPeer').replaceChildren(flagEl(p.country), ' ', el('bdi', { text: p.username }));
  $('reportTitle').textContent = t('report.title', { name: bidi(p.username) });
  $('blockTitle').textContent = t('block.title', { name: bidi(p.username) });
}

/* ==========================================================================
   Modals & settings
   ========================================================================== */
function openModal(id) {
  closeModals(false);
  S.lastFocus = document.activeElement;
  const m = $(id);
  m.hidden = false;
  setTimeout(() => m.querySelector('button, select, input')?.focus(), 30);
}
function closeModals(restore = true) {
  let was = false;
  document.querySelectorAll('.modal').forEach((m) => { if (!m.hidden) { m.hidden = true; was = true; } });
  if (was && restore) S.lastFocus?.focus?.();
}
const anyModalOpen = () => [...document.querySelectorAll('.modal')].some((m) => !m.hidden);

async function openSettings() {
  renderSettings();
  openModal('settingsModal');
  await fillDevices();
}

function renderSettings() {
  const native = UI_LOCALES.find((l) => l[0] === getLang())?.[1] || 'English';
  setSelectBtn($('setLangBtn'), icon('i-globe'), native);
  document.querySelectorAll('#themeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.val === S.settings.theme)));
  $('setSafeView').checked = !!S.settings.safeView;
  $('setAutoNext').checked = !!S.settings.autoNext;
  $('setSounds').checked = !!S.settings.sounds;
}

async function fillDevices() {
  const { video, audio, output } = await media.devices();
  const fill = (select, list, current, kind) => {
    select.replaceChildren(el('option', { value: '', text: t('settings.default') }));
    list.forEach((d, i) => select.append(el('option', { value: d.deviceId, text: d.label || `${kind} ${i + 1}` })));
    select.value = list.some((d) => d.deviceId === current) ? current : '';
    select.disabled = !list.length;
  };
  fill($('setCamera'), video, S.settings.cameraId, t('settings.camera'));
  fill($('setMic'), audio, S.settings.micId, t('settings.mic'));
  fill($('setSpeaker'), output, S.settings.speakerId, t('settings.speaker'));
}

async function changeDevice(kind, id) {
  S.settings[kind === 'video' ? 'cameraId' : 'micId'] = id;
  saveSettings();
  if (!media.live) return;
  try {
    const track = await media.switchDevice(kind, id);
    if (track && S.call) await S.call.replaceTrack(track);
    attach($('localPreview'), media.stream);
    attach($('localVideo'), media.stream);
    renderMediaButtons();
  } catch {
    toast(t('cam.notFound'));
  }
}

function applySpeaker() {
  const v = $('remoteVideo');
  if (S.settings.speakerId && typeof v.setSinkId === 'function') v.setSinkId(S.settings.speakerId).catch(() => {});
}

function applyTheme() {
  const mode = S.settings.theme || 'system';
  const light = mode === 'light' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#F2F4FA' : '#0D1322');
}

/* ==========================================================================
   Toasts & announcements
   ========================================================================== */
function toast(text, ms = 2400) {
  const box = $('toasts');
  const node = el('div', { class: 'toast', text });
  box.append(node);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);
  }, ms);
}
function announce(text) { $('announcer').textContent = text; }

/* ==========================================================================
   Gestures: swipe-to-next on phones, draggable self-view
   ========================================================================== */
function wireSwipe() {
  const stage = $('stage');
  let start = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('.pip, button, .peer-card, .overlay')) return;
    start = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = Date.now() - start.t;
    start = null;
    if (dx < -70 && Math.abs(dy) < 60 && dt < 700) next();
  });
  stage.addEventListener('pointercancel', () => { start = null; });
}

function wirePipDrag() {
  const pip = $('pip');
  const stage = $('stage');
  let drag = null;
  pip.addEventListener('pointerdown', (e) => {
    const r = pip.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    pip.setPointerCapture(e.pointerId);
    pip.classList.add('dragging');
  });
  pip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const s = stage.getBoundingClientRect();
    const r = pip.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - s.left - drag.dx, 8), s.width - r.width - 8);
    const y = Math.min(Math.max(e.clientY - s.top - drag.dy, 8), s.height - r.height - 8);
    Object.assign(pip.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
    drag.moved = true;
  });
  const end = () => {
    if (!drag) return;
    pip.classList.remove('dragging');
    if (drag.moved) {
      const s = stage.getBoundingClientRect();
      const r = pip.getBoundingClientRect();
      const cx = r.left + r.width / 2 - s.left;
      const cy = r.top + r.height / 2 - s.top;
      const corner = `corner-${cy < s.height / 2 ? 't' : 'b'}${cx < s.width / 2 ? 'l' : 'r'}`;
      pip.removeAttribute('style');
      pip.className = `pip ${corner}${media.camOn ? '' : ' cam-off'}`;
      S.settings.pip = corner;
      saveSettings();
    }
    drag = null;
  };
  pip.addEventListener('pointerup', end);
  pip.addEventListener('pointercancel', end);
}

/* ==========================================================================
   Event wiring
   ========================================================================== */
function wire() {
  // top bar
  $('langBtn').addEventListener('click', (e) => openUiLanguagePicker(e.currentTarget));
  $('settingsBtn').addEventListener('click', openSettings);
  $('profileChip').addEventListener('click', () => openOnboarding(1, { editing: true }));

  // lobby
  $('startBtn').addEventListener('click', startChat);
  $('camStateBtn').addEventListener('click', () => ensureCamera().catch(() => {}));
  $('lobbyMic').addEventListener('click', toggleMic);
  $('lobbyCam').addEventListener('click', toggleCam);
  $('genderFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-val]');
    if (!b) return;
    S.filters.gender = b.dataset.val;
    store.set('filters', S.filters);
    renderFilters();
    refreshEstimate();
  });
  $('countryFilterBtn').addEventListener('click', (e) => {
    refreshEstimate();
    openPicker({
      anchor: e.currentTarget,
      options: countryOptions({ includeAny: true, counts: S.countryCounts, highlight: S.profile?.country }),
      value: S.filters.country,
      placeholder: t('common.search'),
      emptyText: t('common.noResults'),
      onSelect: (v) => {
        S.filters.country = v;
        store.set('filters', S.filters);
        renderFilters();
        refreshEstimate();
      },
    });
  });
  $('languageFilterBtn').addEventListener('click', (e) => {
    openPicker({
      anchor: e.currentTarget,
      options: languageOptions({ includeAny: true, mine: S.profile?.languages || [] }),
      value: S.filters.language,
      placeholder: t('common.search'),
      emptyText: t('common.noResults'),
      onSelect: (v) => {
        S.filters.language = v;
        store.set('filters', S.filters);
        renderFilters();
        refreshEstimate();
      },
    });
  });

  // stage & controls
  $('nextBtn').addEventListener('click', next);
  $('stopBtn').addEventListener('click', stopChat);
  $('overlayNext').addEventListener('click', next);
  $('overlayLobby').addEventListener('click', stopChat);
  $('widenBtn').addEventListener('click', widenSearch);
  $('keepBtn').addEventListener('click', () => { S.search.quietDismissed = true; $('quietBox').hidden = true; });
  $('micBtn').addEventListener('click', toggleMic);
  $('camBtn').addEventListener('click', toggleCam);
  $('flipBtn').addEventListener('click', flipCamera);
  $('revealBtn').addEventListener('click', () => $('stage').classList.remove('safe-blur'));
  $('reactBtn').addEventListener('click', (e) => {
    const pop = $('reactPop');
    pop.hidden = !pop.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) pop.querySelector('button')?.focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('reactPop').hidden && !e.target.closest('.react-wrap')) closeReact();
  });
  $('chatToggle').addEventListener('click', () => setChatOpen(document.body.dataset.chat !== 'open', true));
  $('chatClose').addEventListener('click', () => setChatOpen(false));
  $('reportBtn').addEventListener('click', () => { if (S.match) openModal('reportModal'); });
  $('peerReportBtn').addEventListener('click', () => { if (S.match) openModal('reportModal'); });
  $('reportBlockOnly').addEventListener('click', () => { closeModals(false); openModal('blockModal'); });
  $('blockBtn').addEventListener('click', () => { if (S.match) openModal('blockModal'); });
  $('reportReasons').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-reason]');
    if (b) submitReport(b.dataset.reason);
  });
  $('blockConfirm').addEventListener('click', confirmBlock);
  $('composer').addEventListener('submit', sendChat);
  $('chatInput').addEventListener('input', onChatInput);
  wireSwipe();
  wirePipDrag();

  // modals
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModals(); });
  });
  $('setLangBtn').addEventListener('click', (e) => openUiLanguagePicker(e.currentTarget));
  $('themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-val]');
    if (!b) return;
    S.settings.theme = b.dataset.val;
    saveSettings();
    applyTheme();
    renderSettings();
  });
  $('setSafeView').addEventListener('change', (e) => { S.settings.safeView = e.target.checked; saveSettings(); });
  $('setAutoNext').addEventListener('change', (e) => { S.settings.autoNext = e.target.checked; saveSettings(); });
  $('setSounds').addEventListener('change', (e) => { S.settings.sounds = sounds.enabled = e.target.checked; saveSettings(); });
  $('setCamera').addEventListener('change', (e) => changeDevice('video', e.target.value));
  $('setMic').addEventListener('change', (e) => changeDevice('audio', e.target.value));
  $('setSpeaker').addEventListener('change', (e) => { S.settings.speakerId = e.target.value; saveSettings(); applySpeaker(); });
  $('editProfileBtn').addEventListener('click', () => openOnboarding(1, { editing: true }));
  $('resetBtn').addEventListener('click', () => { store.clear(); location.reload(); });

  // onboarding
  $('onbNext').addEventListener('click', onbNext);
  $('onbBack').addEventListener('click', () => goStep(Math.max(1, O.step - 1)));
  $('onbSkip').addEventListener('click', finishOnboarding);
  $('onbRandom').addEventListener('click', () => { $('onbName').value = randomName(); $('onbName').focus(); });
  $('onbName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onbNext(); } });
  $('onbGender').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-val]');
    if (!b) return;
    O.gender = b.dataset.val;
    renderOnboardingDynamic();
    setTimeout(() => { if (O.step === 2) goStep(3); }, 220);
  });
  $('onbCountryBtn').addEventListener('click', (e) => {
    openPicker({
      anchor: e.currentTarget,
      options: countryOptions({ includeAny: false, highlight: S.server.detectedCountry }),
      value: O.country,
      placeholder: t('common.search'),
      emptyText: t('common.noResults'),
      onSelect: (v) => { O.country = v; renderOnboardingDynamic(); },
    });
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (pickerOpen()) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === 'Escape') {
      if (anyModalOpen()) { e.preventDefault(); closeModals(); return; }
      if (!$('reactPop').hidden) { closeReact(); return; }
      if (typing) { e.target.blur(); return; }
      if (!$('onboard').hidden) return;
      if (['connecting', 'connected', 'ended'].includes(S.state)) { e.preventDefault(); next(); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || anyModalOpen() || !$('onboard').hidden) return;
    const k = e.key.toLowerCase();
    if (k === 'm') toggleMic();
    else if (k === 'v') toggleCam();
    else if (k === '/' && S.state === 'connected') { e.preventDefault(); setChatOpen(true, true); }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) document.title = t('meta.title');
  });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    renderMediaButtons();
    if (!$('settingsModal').hidden) fillDevices();
  });
}

boot().catch((err) => {
  console.error('[dunia] boot failed', err);
  document.body.dataset.state = 'idle';
});
