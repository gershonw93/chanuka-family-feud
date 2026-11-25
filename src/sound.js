// Game-show sound effects, synthesized with Web Audio (no audio files).
//   ding()    someone buzzed in first
//   flip()    a correct answer: bright bell
//   strike()  wrong answer: harsh buzzer
//   win()     round won: short brass fanfare + applause
//   fanfare() game starts: brass fanfare
//   finale()  winner: big fanfare + long applause
//   buzz()    a phone's own buzzer press
//   tick()    countdown tick

const readOn = () => { try { return localStorage.getItem("lf-sound") !== "off"; } catch (e) { return true; } };

export const Sound = {
  ctx: null,
  out: null,
  verb: null,
  on: readOn(),

  ensure() {
    try {
      if (!this.ctx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        const c = (this.ctx = new C());
        // master: gentle compression so stacked sounds don't clip
        const comp = c.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        const master = c.createGain();
        master.gain.value = 0.9;
        comp.connect(master).connect(c.destination);
        this.out = comp;
        // a small room reverb from a generated impulse
        const len = Math.floor(c.sampleRate * 1.6);
        const ir = c.createBuffer(2, len, c.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const d = ir.getChannelData(ch);
          for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
        }
        const conv = c.createConvolver();
        conv.buffer = ir;
        const wet = c.createGain();
        wet.gain.value = 0.22;
        conv.connect(wet).connect(comp);
        this.verb = conv;
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
    } catch (e) {}
    return this.ctx;
  },

  // route a node to the dry bus and (optionally) the reverb
  send(node, reverb = true) {
    node.connect(this.out);
    if (reverb && this.verb) node.connect(this.verb);
  },

  noiseBuffer(sec) {
    const c = this.ctx;
    const b = c.createBuffer(1, Math.floor(c.sampleRate * sec), c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  },

  ready() {
    if (!this.on) return null;
    return this.ensure();
  },

  // A struck bell: inharmonic partials, fast attack, long ring.
  bell(freq, when = 0, vol = 0.5, ring = 1.6) {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime + when;
    const partials = [[1, 1], [2.0, 0.55], [2.76, 0.4], [5.4, 0.22], [8.93, 0.1]];
    const bus = c.createGain();
    bus.gain.value = vol;
    this.send(bus);
    partials.forEach(([m, a], i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = "sine";
      o.frequency.value = freq * m;
      const dec = ring / (1 + i * 0.7);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(a, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      o.connect(g).connect(bus);
      o.start(t);
      o.stop(t + dec + 0.05);
    });
    // the "tink" of the hammer
    const n = c.createBufferSource();
    n.buffer = this.noiseBuffer(0.03);
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 5000;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.25, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    n.connect(hp).connect(ng).connect(bus);
    n.start(t);
  },

  // Brass-ish note: detuned saws through an opening low-pass filter.
  brass(freq, when, dur, vol = 0.22) {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime + when;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(3200, t + 0.08);
    lp.frequency.exponentialRampToValueAtTime(1800, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.04);
    g.gain.setValueAtTime(vol * 0.85, t + Math.max(0.05, dur - 0.12));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
    lp.connect(g);
    this.send(g);
    [-7, 0, 7].forEach((cents) => {
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq;
      o.detune.value = cents;
      // a touch of vibrato on longer notes
      if (dur > 0.5) {
        const lfo = c.createOscillator();
        const lg = c.createGain();
        lfo.frequency.value = 5.5;
        lg.gain.value = 6;
        lfo.connect(lg).connect(o.detune);
        lfo.start(t + 0.2);
        lfo.stop(t + dur + 0.2);
      }
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.2);
    });
  },

  // Crowd applause: hundreds of tiny hand claps over a noise wash.
  applause(when = 0, sec = 3, vol = 0.5) {
    const c = this.ready();
    if (!c) return;
    const t0 = c.currentTime + when;
    const bus = c.createGain();
    bus.gain.value = vol;
    this.send(bus);
    const clap = this.noiseBuffer(0.06);
    const count = Math.floor(sec * 110);
    for (let i = 0; i < count; i++) {
      const u = i / count;
      const t = t0 + u * sec + Math.random() * 0.03;
      const loud = Math.sin(Math.PI * Math.min(1, u * 1.6 + 0.1)) * (0.5 + Math.random() * 0.5);
      const s = c.createBufferSource();
      s.buffer = clap;
      s.playbackRate.value = 0.8 + Math.random() * 0.6;
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 900 + Math.random() * 1800;
      bp.Q.value = 1.2;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05 + loud * 0.35, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      s.connect(bp).connect(g).connect(bus);
      s.start(t);
    }
    const wash = c.createBufferSource();
    wash.buffer = this.noiseBuffer(sec + 0.5);
    const wf = c.createBiquadFilter();
    wf.type = "bandpass";
    wf.frequency.value = 1500;
    wf.Q.value = 0.6;
    const wg = c.createGain();
    wg.gain.setValueAtTime(0.0001, t0);
    wg.gain.exponentialRampToValueAtTime(0.18, t0 + sec * 0.3);
    wg.gain.exponentialRampToValueAtTime(0.0001, t0 + sec + 0.4);
    wash.connect(wf).connect(wg).connect(bus);
    wash.start(t0);
  },

  // Wrong answer: the classic harsh, flat game-show buzzer.
  strike() {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    const dur = 0.95;
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 4); }
    shaper.curve = curve;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2400;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.setValueAtTime(0.5, t + dur - 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    shaper.connect(lp).connect(g);
    this.send(g, false);
    [[92, "sawtooth"], [97, "square"], [138, "sawtooth"], [184, "square"]].forEach(([f, type]) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = c.createGain();
      og.gain.value = 0.3;
      o.connect(og).connect(shaper);
      o.start(t);
      o.stop(t + dur + 0.05);
    });
  },

  // Someone buzzed in first: a quick electric buzz, then a bright chime.
  ding() {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = "square";
    o.frequency.value = 440;
    const o2 = c.createOscillator();
    o2.type = "square";
    o2.frequency.value = 660;
    const am = c.createGain();
    const lfo = c.createOscillator();
    const lg = c.createGain();
    lfo.frequency.value = 38;
    lg.gain.value = 0.5;
    am.gain.value = 0.5;
    lfo.connect(lg).connect(am.gain);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    g.gain.setValueAtTime(0.22, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    o.connect(am);
    o2.connect(am);
    am.connect(g);
    this.send(g, false);
    [o, o2, lfo].forEach((x) => { x.start(t); x.stop(t + 0.4); });
    this.bell(1568, 0.36, 0.45, 1.4);
    this.bell(2093, 0.36, 0.2, 1.1);
  },

  // Correct answer on the board: a bright two-bell "ding!"
  flip() {
    this.bell(1318.5, 0, 0.55, 1.8);
    this.bell(1975.5, 0.012, 0.25, 1.5);
  },

  // Round won: rising brass and a burst of applause.
  win() {
    const seq = [[523.25, 0, 0.14], [659.25, 0.14, 0.14], [783.99, 0.28, 0.14], [1046.5, 0.42, 0.7]];
    seq.forEach(([f, w, d]) => this.brass(f, w, d, 0.2));
    [523.25, 659.25, 783.99].forEach((f) => this.brass(f, 0.42, 0.7, 0.1));
    this.applause(0.3, 2.4, 0.45);
  },

  // Game starts: a short "ta-da".
  fanfare() {
    [[392, 0, 0.12], [392, 0.15, 0.12], [523.25, 0.3, 0.6]].forEach(([f, w, d]) => this.brass(f, w, d, 0.22));
    [659.25, 783.99].forEach((f) => this.brass(f, 0.3, 0.6, 0.12));
  },

  // The winner: big fanfare and a long ovation.
  finale() {
    const seq = [[392, 0, 0.16], [523.25, 0.18, 0.16], [659.25, 0.36, 0.16], [783.99, 0.54, 0.36], [659.25, 0.92, 0.14], [783.99, 1.08, 0.9]];
    seq.forEach(([f, w, d]) => this.brass(f, w, d, 0.22));
    [523.25, 659.25, 1046.5].forEach((f) => this.brass(f, 1.08, 0.9, 0.11));
    this.applause(0.6, 5, 0.55);
    this.bell(2093, 1.08, 0.18, 2);
  },

  // A phone's own buzzer press.
  buzz() {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = "square";
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(760, t + 0.12);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g);
    this.send(g, false);
    o.start(t);
    o.stop(t + 0.3);
  },

  tick() {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = "triangle";
    o.frequency.value = 1800;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g);
    this.send(g, false);
    o.start(t);
    o.stop(t + 0.08);
  },
};
