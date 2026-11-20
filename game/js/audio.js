'use strict';
// Sound for the game, made on the fly with the Web Audio API (no sound files).
// AUDIO.sfx(name) plays a short effect; AUDIO.music(name) switches the looping background
// tune (null = silence). Browsers only allow sound after the player touches a key or the
// screen, so everything waits quietly until then. AUDIO.toggle() mutes / unmutes; the choice
// is remembered on this device.
const AUDIO = (() => {
  let ac = null, master = null, musicBus = null, sfxBus = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('sprout_sound') === 'off'; } catch (e) { /* storage unavailable */ }
  let wanted = null, playing = null, timer = null, nextAt = 0, step = 0;
  const counts = {};                     // how often each effect played (for testing)

  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function noteNum(tok) {                // "C5", "F#3", "Bb4" -> midi number
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(tok);
    return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }
  // "E5 - G5 . ..." -> [{n, len}] on a 16th-note grid: "-" holds, "." rests
  function parse(str) {
    const toks = str.trim().split(/\s+/), out = [];
    toks.forEach((t, i) => {
      if (t === '-' || t === '.') return;
      let len = 1;
      while (toks[i + len] === '-') len++;
      out.push({ at: i, n: noteNum(t), len });
    });
    return { notes: out, steps: toks.length };
  }

  function init() {
    if (ac) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain(); master.gain.value = muted ? 0 : 0.6; master.connect(ac.destination);
    musicBus = ac.createGain(); musicBus.gain.value = 0.32; musicBus.connect(master);
    sfxBus = ac.createGain(); sfxBus.gain.value = 0.7; sfxBus.connect(master);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  function unlock() {
    init();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    if (wanted !== playing) startMusic(wanted);
  }
  ['keydown', 'pointerdown', 'touchstart'].forEach((t) => window.addEventListener(t, unlock, true));

  // ---------------------------------------------------------------- building blocks
  function tone(type, f0, f1, dur, vol, when = 0, bus = sfxBus) {
    if (!ac) return;
    const t = ac.currentTime + when;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, freq, when = 0, sweepTo = 0, bus = sfxBus) {
    if (!ac) return;
    const t = ac.currentTime + when;
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf;
    f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(bus);
    s.start(t); s.stop(t + dur + 0.02);
  }
  const arp = (notes, gap, type = 'square', vol = 0.18, len = 0.12) =>
    notes.forEach((n, i) => tone(type, midi(n), 0, len, vol, i * gap));

  // ---------------------------------------------------------------- effects
  let lastBlip = 0;
  const SFX = {
    cursor:   () => tone('square', 880, 0, 0.04, 0.08),
    confirm:  () => { tone('square', 660, 0, 0.05, 0.12); tone('square', 990, 0, 0.07, 0.12, 0.05); },
    cancel:   () => tone('square', 440, 300, 0.09, 0.1),
    blip:     () => { if (ac.currentTime - lastBlip < 0.06) return; lastBlip = ac.currentTime; tone('square', 1320, 0, 0.025, 0.04); },
    door:     () => { noise(0.18, 0.25, 900, 0, 300); tone('triangle', 220, 110, 0.2, 0.25); },
    bump:     () => tone('square', 110, 80, 0.06, 0.1),
    encounter:() => { arp([64, 67, 71, 76, 79, 83], 0.05, 'square', 0.14, 0.09); noise(0.35, 0.12, 3000, 0.3, 600); },
    attack:   () => noise(0.16, 0.3, 600, 0, 2600),
    hit:      () => { noise(0.12, 0.5, 1200); tone('square', 160, 60, 0.14, 0.25); },
    hitStrong:() => { noise(0.18, 0.7, 1600); tone('sawtooth', 200, 50, 0.22, 0.3); noise(0.1, 0.4, 2400, 0.09); },
    hitWeak:  () => { noise(0.08, 0.25, 700); tone('triangle', 120, 70, 0.1, 0.2); },
    faint:    () => tone('square', 620, 70, 0.6, 0.18),
    levelup:  () => arp([72, 76, 79, 84, 79, 84], 0.07, 'square', 0.16, 0.12),
    evolve:   () => { for (let i = 0; i < 24; i++) tone('triangle', midi(60 + (i % 8) * 2 + Math.floor(i / 8) * 4), 0, 0.12, 0.12, i * 0.1); },
    fanfare:  () => { arp([67, 72, 76, 79], 0.1, 'square', 0.16, 0.14); tone('square', midi(84), 0, 0.5, 0.16, 0.42); tone('triangle', midi(60), 0, 0.9, 0.2, 0.0); },
    throw:    () => tone('square', 300, 1200, 0.25, 0.12),
    shake:    () => { tone('square', 200, 0, 0.04, 0.12); noise(0.05, 0.2, 2000); },
    caught:   () => arp([76, 79, 84], 0.1, 'square', 0.16, 0.2),
    breakout: () => { noise(0.1, 0.4, 2500); tone('square', 500, 900, 0.12, 0.12); },
    heal:     () => arp([72, 76, 79, 84, 88], 0.08, 'triangle', 0.2, 0.18),
    rare:     () => { for (let i = 0; i < 8; i++) tone('triangle', midi(84 + (i % 4) * 3), 0, 0.09, 0.12, i * 0.06); },
    coin:     () => { tone('square', midi(83), 0, 0.07, 0.12); tone('square', midi(88), 0, 0.22, 0.12, 0.07); },
    victory:  () => {
      const mel = [[72, 0], [76, 0.12], [79, 0.24], [84, 0.36], [79, 0.6], [84, 0.72]];
      mel.forEach(([n, t], i) => tone('square', midi(n), 0, i === mel.length - 1 ? 0.6 : 0.14, 0.16, t));
      [[48, 0], [55, 0.36], [60, 0.72]].forEach(([n, t]) => tone('triangle', midi(n), 0, 0.4, 0.25, t));
    },
  };

  // ---------------------------------------------------------------- music
  // Original tunes on a 16th-note grid. lead = square, bass = triangle; hat = noise every n steps.
  const TRACKS = {
    // the village: a gentle tune on the five-note scale (C D E G A), like a Thai folk melody
    village: { bpm: 96, hat: 0,
      lead: parse(`E5 - G5 - A5 - G5 E5 D5 - - - C5 - D5 -
                   E5 - - - G5 - E5 D5 C5 - - - . . . .
                   A4 - C5 - D5 - E5 G5 E5 - D5 - C5 - A4 -
                   G4 - A4 - C5 - D5 - C5 - - - . . . .`),
      bass: parse(`C3 - - - G3 - - - C3 - - - G3 - - -
                   A2 - - - E3 - - - A2 - - - E3 - - -
                   F2 - - - C3 - - - F2 - - - C3 - - -
                   G2 - - - D3 - - - G2 - - - G2 - D3 -`) },
    // the routes: brighter and a little faster (G A B D E)
    route: { bpm: 124, hat: 4,
      lead: parse(`D5 - B4 - D5 E5 G5 - E5 - D5 - B4 - A4 -
                   G4 - A4 - B4 - D5 - E5 - - - D5 - - -
                   E5 - G5 - A5 - G5 E5 D5 - E5 - D5 B4 A4 -
                   B4 - A4 - G4 - - - . . G4 A4 B4 - D5 -`),
      bass: parse(`G2 - D3 - G2 - D3 - G2 - D3 - G2 - D3 -
                   E2 - B2 - E2 - B2 - E2 - B2 - E2 - B2 -
                   C3 - G3 - C3 - G3 - C3 - G3 - C3 - G3 -
                   D3 - A2 - D3 - A2 - D3 - A2 - D3 - A2 -`) },
    // wild battles: driving, in A minor
    battle: { bpm: 152, hat: 2,
      lead: parse(`A4 - C5 - E5 - A5 - G5 - E5 - D5 - E5 -
                   C5 - D5 - E5 - - - G5 - E5 - D5 - C5 -
                   F5 - E5 - D5 - C5 - D5 - E5 - G5 - E5 -
                   A5 - - - G5 - E5 - E5 - D5 - E5 - - -`),
      bass: parse(`A2 . A2 . A3 . A2 . A2 . A2 . A3 . A2 .
                   F2 . F2 . F3 . F2 . F2 . F2 . F3 . F2 .
                   D2 . D2 . D3 . D2 . G2 . G2 . G3 . G2 .
                   E2 . E2 . E3 . E2 . E2 . E2 . E3 . B2 .`) },
  };
  // trainer and gym battles: the battle tune, two semitones higher and faster
  TRACKS.trainer = { ...TRACKS.battle, bpm: 164, shift: 2 };

  function startMusic(name) {
    playing = name;
    clearInterval(timer); timer = null;
    if (!ac || !name || !TRACKS[name]) return;
    step = 0; nextAt = ac.currentTime + 0.06;
    timer = setInterval(schedule, 25);
  }
  function schedule() {
    const tr = TRACKS[playing];
    if (!tr || !ac) return;
    const dt = 60 / tr.bpm / 4, shift = tr.shift || 0;
    while (nextAt < ac.currentTime + 0.12) {
      const when = nextAt - ac.currentTime;
      for (const [part, type, vol] of [[tr.lead, 'square', 0.11], [tr.bass, 'triangle', 0.3]]) {
        const s = step % part.steps;
        for (const nt of part.notes) if (nt.at === s) tone(type, midi(nt.n + shift), 0, nt.len * dt * 0.92, vol, when, musicBus);
      }
      if (tr.hat && step % tr.hat === 0) noise(0.03, 0.08, 8000, when, 0, musicBus);
      nextAt += dt; step++;
    }
  }

  return {
    sfx(name) {
      counts[name] = (counts[name] || 0) + 1;
      if (!ac || muted || !SFX[name]) return;
      try { SFX[name](); } catch (e) { /* never let a sound break the game */ }
    },
    music(name) {
      wanted = name || null;
      if (ac && wanted !== playing) startMusic(wanted);
    },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('sprout_sound', muted ? 'off' : 'on'); } catch (e) { /* storage unavailable */ }
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.6, ac.currentTime, 0.02);
      return !muted;
    },
    get on() { return !muted; },
    get state() { return { ctx: ac ? ac.state : 'none', muted, wanted, playing, counts: { ...counts } }; },
  };
})();
