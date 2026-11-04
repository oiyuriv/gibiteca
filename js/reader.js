// Leitor: mostra o gibi como revista, com a página virando presa na lombada,
// pinça/toque duplo para zoom e uma ou duas páginas por tela.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const EASE = {
  out: t => 1 - Math.pow(1 - t, 3),
  inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  sine: t => -(Math.cos(Math.PI * t) - 1) / 2,
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const decodeEl = img => (img.getAttribute('src') ? img.decode().catch(() => {}) : Promise.resolve());

// Som de papel sintetizado (sem arquivo de áudio).
class PaperSound {
  play() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this.ctx || (this.ctx = new AC());
      if (ctx.state === 'suspended') ctx.resume();
      const dur = 0.3;
      if (!this.buf) {
        const n = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buf.getChannelData(0);
        let last = 0;
        for (let i = 0; i < n; i++) {
          const t = i / n;
          const env = Math.pow(Math.sin(Math.PI * Math.min(1, t / 0.9)), 2) * (1 - 0.5 * t);
          last = last * 0.55 + (Math.random() * 2 - 1) * 0.45;
          d[i] = last * env;
        }
        this.buf = buf;
      }
      const t0 = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this.buf;
      src.playbackRate.value = 0.85 + Math.random() * 0.3;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.6;
      bp.frequency.setValueAtTime(650, t0);
      bp.frequency.exponentialRampToValueAtTime(2800, t0 + dur * 0.75);
      const g = ctx.createGain();
      g.gain.value = 0.55;
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start();
    } catch { /* sem som, tudo bem */ }
  }
  unlock() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this.ctx) this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* ok */ }
  }
}

export class Reader {
  constructor(el, opts) {
    this.el = el;
    this.o = opts;
    const q = s => el.querySelector(s);
    this.surface = q('.rd-surface');
    this.stage = q('.rd-stage');
    this.shift = q('.rd-shift');
    this.book = q('.rd-book');
    this.slotL = q('.rd-l');
    this.slotR = q('.rd-r');
    this.imgL = this.slotL.querySelector('img');
    this.imgR = this.slotR.querySelector('img');
    this.leaf = q('.rd-leaf');
    this.front = q('.rd-front');
    this.back = q('.rd-back');
    this.imgF = this.front.querySelector('img');
    this.imgB = this.back.querySelector('img');
    this.shadeF = this.front.querySelector('.rd-shade');
    this.shadeB = this.back.querySelector('.rd-shade');
    this.cast = q('.rd-cast');
    this.ui = {
      title: q('#rdTitle'), sub: q('#rdSub'), range: q('#rdRange'), bubble: q('#rdBubble'),
      scrub: q('.rd-scrub'), prev: q('#rdPrev'), next: q('#rdNext'), hint: q('#rdHint'), end: q('#rdEnd'),
    };
    this.sound = new PaperSound();
    this.urls = new Map();
    this.loading = new Map();
    this.zoom = { s: 1, x: 0, y: 0 };
    this.pointers = new Map();
    this.g = null;
    this.flip = null;
    this.anim = 0;
    this.zanim = 0;
    this.settleTok = 0;
    this.session = 0;
    this.isOpen = false;
    this.bind();
  }

  /* ---------- abrir / fechar ---------- */

  async open(comic, startPage = 0, from = null) {
    this.session++;
    this.c = comic;
    this.isOpen = true;
    this.spreads = null;
    this.startPage = clamp(startPage, 0, comic.pageCount - 1);
    this.revokeAll();
    this.ui.end.hidden = true;
    this.ui.title.textContent = comic.title;
    this.el.hidden = false;
    this.el.classList.add('entering');
    document.body.classList.add('reading');
    this.setRtl(!!comic.rtl, false);
    this.layout();

    // espera as páginas da tela atual carregarem (no máximo meio segundo)
    await Promise.race([Promise.all([this.url(this.spreads[this.spread].L), this.url(this.spreads[this.spread].R)]), wait(500)]);
    this.showSpread();
    await Promise.race([Promise.all([decodeEl(this.imgL), decodeEl(this.imgR)]), wait(400)]);

    if (from) await this.flyIn(from);
    this.el.classList.remove('entering');
    this.showUI(true);
    clearTimeout(this.uiTimer);
    this.uiTimer = setTimeout(() => this.showUI(false), 2200);

    let seen = false;
    try { seen = localStorage.getItem('gibiteca.hint') === '1'; } catch { /* ok */ }
    if (!seen) { this.ui.hint.hidden = false; this.showUI(false); }
  }

  async flyIn(from) {
    const sp = this.spreads[this.spread];
    const r = this.bookRect;
    // retângulo da página que vai aparecer primeiro
    let x = r.x + this.shiftX;
    const w = this.pw;
    if (this.double) {
      const leftSide = (sp.L != null) !== this.rtl;
      x = r.x + this.shiftX + (leftSide ? 0 : this.pw);
    }
    const sr = this.surface.getBoundingClientRect();
    const to = { left: sr.left + x, top: sr.top + r.y, width: w, height: r.h };
    const fly = document.createElement('img');
    fly.className = 'fly';
    fly.src = from.src;
    Object.assign(fly.style, { left: from.rect.left + 'px', top: from.rect.top + 'px', width: from.rect.width + 'px', height: from.rect.height + 'px' });
    document.body.appendChild(fly);
    const px = v => v + 'px';
    const a = fly.animate([
      { left: px(from.rect.left), top: px(from.rect.top), width: px(from.rect.width), height: px(from.rect.height), borderRadius: '3px' },
      { left: px(to.left), top: px(to.top), width: px(to.width), height: px(to.height), borderRadius: '0px' },
    ], { duration: 430, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    await a.finished.catch(() => {});
    this.el.classList.remove('entering');
    const b = fly.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
    b.finished.catch(() => {}).then(() => fly.remove());
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.session++;
    cancelAnimationFrame(this.anim);
    cancelAnimationFrame(this.zanim);
    this.flip = null;
    this.g = null;
    this.pointers.clear();
    this.reportProgress(true);
    const done = () => {
      this.el.hidden = true;
      this.el.classList.remove('leaving');
      this.leaf.classList.remove('on');
      this.setZoom(1, 0, 0);
      [this.imgL, this.imgR, this.imgF, this.imgB].forEach(i => i.removeAttribute('src'));
      this.revokeAll();
      document.body.classList.remove('reading');
      this.o.onClosed && this.o.onClosed(this.c);
    };
    this.el.classList.add('leaving');
    setTimeout(done, 200);
  }

  revokeAll() {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.loading.clear();
  }

  /* ---------- páginas e telas ---------- */

  buildSpreads() {
    const N = this.c.pageCount;
    const S = [];
    if (!this.double) {
      for (let i = 0; i < N; i++) S.push({ L: null, R: i });
    } else {
      S.push({ L: null, R: 0 }); // capa sozinha, como numa revista fechada
      for (let p = 1; p < N; p += 2) S.push({ L: p, R: p + 1 < N ? p + 1 : null });
    }
    this.spreads = S;
  }

  spreadOf(page) {
    if (!this.double) return clamp(page, 0, this.c.pageCount - 1);
    return page <= 0 ? 0 : Math.min(this.spreads.length - 1, Math.floor((page - 1) / 2) + 1);
  }

  pageOf(s) {
    const sp = this.spreads[s];
    return sp.L != null ? sp.L : sp.R;
  }

  currentPage() {
    return this.spreads ? this.pageOf(this.spread) : this.startPage;
  }

  layout() {
    if (!this.isOpen) return;
    // se a tela ainda não tem tamanho (janela minimizada etc.), usa um tamanho provisório;
    // o evento de resize refaz o layout quando o tamanho real aparecer
    const W = this.surface.clientWidth || window.innerWidth || 360;
    const H = this.surface.clientHeight || window.innerHeight || 640;
    const mode = this.o.prefs.mode;
    const dbl = mode === 'double' || (mode === 'auto' && W > H * 1.05 && W >= 560);
    const page = this.currentPage();
    const changed = dbl !== this.double || !this.spreads;
    this.double = dbl;
    this.W = W;
    this.H = H;

    const a = this.c.aspect || 0.66;
    const padX = dbl ? Math.min(36, W * 0.03) : 0;
    const padY = dbl ? Math.min(20, H * 0.03) : 0;
    const availW = W - padX * 2;
    const availH = H - padY * 2;
    let pw = dbl ? Math.min(availW / 2, availH * a) : Math.min(availW, availH * a);
    pw = Math.floor(pw);
    const ph = Math.floor(pw / a);
    this.pw = pw;
    this.ph = ph;
    const bw = dbl ? pw * 2 : pw;
    this.book.style.width = bw + 'px';
    this.book.style.height = ph + 'px';
    this.book.classList.toggle('double', dbl);
    this.book.classList.toggle('single', !dbl);
    this.rightX = dbl ? pw : 0;
    Object.assign(this.slotL.style, { left: '0px', width: pw + 'px' });
    Object.assign(this.slotR.style, { left: this.rightX + 'px', width: pw + 'px' });
    Object.assign(this.leaf.style, { left: this.rightX + 'px', width: pw + 'px' });
    this.persp = Math.round(Math.max(1300, pw * (dbl ? 4.2 : 3.2)));
    this.bookRect = { x: (W - bw) / 2, y: (H - ph) / 2, w: bw, h: ph };

    if (changed) {
      this.buildSpreads();
      this.spread = this.spreadOf(page);
    }
    this.stopFlip();
    this.setZoom(1, 0, 0);
    this.showSpread();
  }

  shiftFor(s) {
    if (!this.double) return 0;
    const sp = this.spreads[s];
    const off = sp.L == null ? -this.pw / 2 : sp.R == null ? this.pw / 2 : 0;
    return this.rtl ? -off : off;
  }

  setShift(x) {
    this.shiftX = x;
    this.shift.style.transform = x ? `translateX(${x}px)` : '';
  }

  // retângulo do conteúdo visível (sem a metade vazia ao lado da capa)
  contentRect() {
    const r = this.bookRect;
    if (!this.double) return r;
    const sp = this.spreads[this.spread];
    if (sp.L == null || sp.R == null) return { x: (this.W - this.pw) / 2, y: r.y, w: this.pw, h: r.h };
    return r;
  }

  url(i) {
    if (i == null || i < 0 || i >= this.c.pageCount) return Promise.resolve(null);
    if (this.urls.has(i)) return Promise.resolve(this.urls.get(i));
    if (this.loading.has(i)) return this.loading.get(i);
    const session = this.session;
    const p = this.o.getPage(this.c.id, i).then(blob => {
      if (!blob || session !== this.session) return null;
      const u = URL.createObjectURL(blob);
      this.urls.set(i, u);
      return u;
    }).catch(() => null).finally(() => this.loading.delete(i));
    this.loading.set(i, p);
    return p;
  }

  setImg(box, img, i) {
    const key = i == null ? '' : String(i);
    img.dataset.p = key;
    box.classList.toggle('has', i != null);
    if (i == null) { img.removeAttribute('src'); return; }
    const u = this.urls.get(i);
    if (u) {
      if (img.getAttribute('src') !== u) img.src = u;
    } else {
      img.removeAttribute('src');
      this.url(i).then(u2 => { if (u2 && img.dataset.p === key) img.src = u2; });
    }
  }

  setBookShadow(L, R) {
    // sombra só embaixo das metades que têm página
    const pw = this.pw;
    this.book.style.setProperty('--shL', (this.double && L == null ? pw : 0) + 'px');
    this.book.style.setProperty('--shR', (this.double && R == null ? pw : 0) + 'px');
  }

  showSpread() {
    const sp = this.spreads[this.spread];
    this.slotL.hidden = !this.double;
    this.setImg(this.slotL, this.imgL, sp.L);
    this.setImg(this.slotR, this.imgR, sp.R);
    this.setBookShadow(sp.L, sp.R);
    this.leaf.classList.remove('on');
    this.cast.style.display = 'none';
    this.setShift(this.shiftFor(this.spread));
    this.updateUI();
    this.prefetch();
    this.reportProgress();
  }

  prefetch() {
    const p = this.currentPage();
    const lo = p - (this.double ? 4 : 2);
    const hi = p + (this.double ? 6 : 3);
    for (let i = lo; i <= hi; i++) {
      this.url(i).then(u => {
        if (!u) return;
        const im = new Image();
        im.src = u;
        im.decode && im.decode().catch(() => {});
      });
    }
    for (const [i, u] of this.urls) {
      if (i < lo - 6 || i > hi + 6) { URL.revokeObjectURL(u); this.urls.delete(i); }
    }
  }

  reportProgress(final = false) {
    if (!this.spreads || !this.c) return;
    const atEnd = this.spread === this.spreads.length - 1;
    this.o.onProgress && this.o.onProgress(this.c, this.currentPage(), atEnd, final);
  }

  /* ---------- virar página ---------- */

  beginFlip(dir) {
    const t = this.spread + dir;
    if (t < 0 || t >= this.spreads.length) return false;
    this.settleTok++;
    const cur = this.spreads[this.spread];
    const nx = this.spreads[t];
    let L, R, F, B;
    if (dir > 0) { L = cur.L; R = nx.R; F = cur.R; B = nx.L; }
    else { L = nx.L; R = cur.R; F = nx.R; B = cur.L; }
    this.setImg(this.slotL, this.imgL, L);
    this.setImg(this.slotR, this.imgR, R);
    this.setImg(this.front, this.imgF, F);
    this.setImg(this.back, this.imgB, B);
    this.setBookShadow(L, R);
    this.leaf.classList.add('on');
    this.cast.style.display = 'block';
    this.flip = { dir, target: t, q: 0, goal: null, from: this.shiftFor(this.spread), to: this.shiftFor(t) };
    this.renderFlip(0);
    return true;
  }

  renderFlip(q) {
    const f = this.flip;
    if (!f) return;
    f.q = q;
    const th = f.dir > 0 ? 180 * q : 180 * (1 - q);
    const rad = (th * Math.PI) / 180;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    // leve "arqueado" do papel: a página encolhe um tiquinho no meio do giro
    const lift = 1 - 0.02 * s;
    this.leaf.style.transform = `perspective(${this.persp}px) rotateY(${-th}deg) scale(${lift}, 1)`;
    this.shadeF.style.opacity = th < 90 ? ((th / 90) * 0.9).toFixed(3) : '0';
    this.shadeB.style.opacity = th > 90 ? (((180 - th) / 90) * 0.9).toFixed(3) : '0';

    const pw = this.pw;
    const rx = this.rightX;
    const edge = rx + pw * c;
    const sw = 14 + 60 * s;
    const cs = this.cast.style;
    if (th < 90) {
      const w = Math.max(0, Math.min(sw, rx + pw - edge));
      cs.left = edge + 'px';
      cs.width = w + 'px';
      cs.opacity = (0.75 * s).toFixed(3);
      if (this.castDir !== 'r') { this.cast.className = 'rd-cast to-r'; this.castDir = 'r'; }
    } else if (this.double) {
      const w = Math.max(0, Math.min(sw, edge));
      cs.left = edge - w + 'px';
      cs.width = w + 'px';
      cs.opacity = (0.75 * s).toFixed(3);
      if (this.castDir !== 'l') { this.cast.className = 'rd-cast to-l'; this.castDir = 'l'; }
    } else {
      cs.width = '0px';
    }
    if (f.from !== f.to) this.setShift(f.from + (f.to - f.from) * EASE.sine(q));
  }

  animateFlip(to, dur, ease, done) {
    cancelAnimationFrame(this.anim);
    const f = this.flip;
    f.goal = to;
    const from = f.q;
    const t0 = performance.now();
    const step = now => {
      if (this.flip !== f) return;
      const k = Math.min(1, (now - t0) / dur);
      this.renderFlip(from + (to - from) * ease(k));
      if (k < 1) this.anim = requestAnimationFrame(step);
      else { this.anim = 0; done(); }
    };
    this.anim = requestAnimationFrame(step);
  }

  finishFlip(commit) {
    const f = this.flip;
    if (!f) return;
    if (commit) this.spread = f.target;
    this.flip = null;
    this.settle();
  }

  // Termina a animação atual na hora (para toques rápidos seguidos).
  rushFlip() {
    if (!this.flip || this.flip.goal == null) return;
    cancelAnimationFrame(this.anim);
    this.anim = 0;
    const commit = this.flip.goal === 1;
    this.renderFlip(this.flip.goal);
    this.finishFlip(commit);
  }

  stopFlip() {
    cancelAnimationFrame(this.anim);
    this.anim = 0;
    this.flip = null;
    this.settleTok++;
    this.leaf.classList.remove('on');
    this.cast.style.display = 'none';
  }

  settle() {
    const sp = this.spreads[this.spread];
    const tok = ++this.settleTok;
    this.setImg(this.slotL, this.imgL, sp.L);
    this.setImg(this.slotR, this.imgR, sp.R);
    this.setShift(this.shiftFor(this.spread));
    this.updateUI();
    this.prefetch();
    this.reportProgress();
    // a folha fica parada por cima até as imagens de baixo estarem prontas (evita piscar)
    Promise.race([Promise.all([decodeEl(this.imgL), decodeEl(this.imgR)]), wait(260)]).then(() => {
      if (tok !== this.settleTok || this.flip) return;
      this.leaf.classList.remove('on');
      this.cast.style.display = 'none';
      this.setBookShadow(sp.L, sp.R);
    });
  }

  turn(dir) {
    if (!this.isOpen || !this.spreads) return;
    if (this.g && this.g.type === 'flip') return;
    if (this.zoom.s > 1.02) {
      this.animateZoom(1, 0, 0, 200, () => this.turn(dir));
      return;
    }
    this.rushFlip();
    if (!this.beginFlip(dir)) {
      if (dir > 0) this.showEnd();
      else this.o.toast && this.o.toast('Você já está na capa');
      return;
    }
    if (this.o.prefs.sound) this.sound.play();
    this.animateFlip(1, this.double ? 680 : 560, EASE.inOut, () => this.finishFlip(true));
  }

  goTo(page) {
    if (!this.spreads) return;
    this.stopFlip();
    this.setZoom(1, 0, 0);
    this.spread = this.spreadOf(page);
    this.showSpread();
  }

  next() { this.turn(1); }
  prev() { this.turn(-1); }

  showEnd() {
    this.ui.end.hidden = false;
    this.showUI(false);
    this.reportProgress();
  }

  /* ---------- zoom ---------- */

  setZoom(s, x, y) {
    this.zoom = { s, x, y };
    this.stage.style.transform = s === 1 && !x && !y ? '' : `translate(${x}px, ${y}px) scale(${s})`;
    this.el.classList.toggle('zoomed', s > 1.01);
  }

  clampZoom(s, x, y) {
    const r = this.contentRect();
    const W = this.W, H = this.H;
    const w = r.w * s, h = r.h * s;
    const nx = w <= W ? (W - w) / 2 - r.x * s : clamp(x, W - (r.x + r.w) * s, -r.x * s);
    const ny = h <= H ? (H - h) / 2 - r.y * s : clamp(y, H - (r.y + r.h) * s, -r.y * s);
    return { x: nx, y: ny, ox: x - nx, oy: y - ny };
  }

  animateZoom(s1, x1, y1, dur = 260, done) {
    cancelAnimationFrame(this.zanim);
    const { s: s0, x: x0, y: y0 } = this.zoom;
    const t0 = performance.now();
    this.stage.classList.add('gest');
    const step = now => {
      const k = Math.min(1, (now - t0) / dur);
      const e = EASE.out(k);
      this.setZoom(s0 + (s1 - s0) * e, x0 + (x1 - x0) * e, y0 + (y1 - y0) * e);
      if (k < 1) this.zanim = requestAnimationFrame(step);
      else {
        this.zanim = 0;
        this.setZoom(s1, x1, y1);
        this.stage.classList.remove('gest');
        done && done();
      }
    };
    this.zanim = requestAnimationFrame(step);
  }

  zoomAt(s1, px, py, dur) {
    const { s, x, y } = this.zoom;
    s1 = clamp(s1, 1, 6);
    if (s1 <= 1.001) { this.animateZoom(1, 0, 0, dur); return; }
    const nx = px - (px - x) * (s1 / s);
    const ny = py - (py - y) * (s1 / s);
    const c = this.clampZoom(s1, nx, ny);
    this.animateZoom(s1, c.x, c.y, dur);
  }

  /* ---------- gestos ---------- */

  bind() {
    const sf = this.surface;
    sf.addEventListener('pointerdown', e => this.onDown(e));
    sf.addEventListener('pointermove', e => this.onMove(e));
    sf.addEventListener('pointerup', e => this.onUp(e));
    sf.addEventListener('pointercancel', e => this.onUp(e, true));
    sf.addEventListener('lostpointercapture', e => { if (this.pointers.has(e.pointerId)) this.onUp(e, true); });
    sf.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    sf.addEventListener('contextmenu', e => e.preventDefault());
    // Safari: impede o zoom da página inteira
    ['gesturestart', 'gesturechange'].forEach(t => sf.addEventListener(t, e => e.preventDefault()));
    sf.addEventListener('touchstart', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

    window.addEventListener('resize', () => {
      clearTimeout(this.rz);
      this.rz = setTimeout(() => this.layout(), 120);
    });
    document.addEventListener('keydown', e => this.onKey(e));

    const { range, scrub, prev, next, hint, end } = this.ui;
    range.addEventListener('input', () => {
      scrub.classList.add('scrubbing');
      this.paintRange(+range.value - 1);
      clearTimeout(this.uiTimer);
    });
    range.addEventListener('change', () => {
      scrub.classList.remove('scrubbing');
      this.goTo(+range.value - 1);
    });
    range.addEventListener('pointerup', () => scrub.classList.remove('scrubbing'));
    prev.addEventListener('click', () => this.turn(this.rtl ? 1 : -1));
    next.addEventListener('click', () => this.turn(this.rtl ? -1 : 1));
    hint.addEventListener('click', () => {
      hint.hidden = true;
      try { localStorage.setItem('gibiteca.hint', '1'); } catch { /* ok */ }
    });
    end.addEventListener('click', e => {
      const act = e.target.closest('[data-end]');
      if (!act && e.target !== end) return;
      end.hidden = true;
      if (act && act.dataset.end === 'shelf') this.o.requestClose();
      if (act && act.dataset.end === 'again') this.goTo(0);
    });
  }

  pt(e) {
    const r = this.surfaceRect || (this.surfaceRect = this.surface.getBoundingClientRect());
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    if (!this.isOpen) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.sound.unlock();
    this.surfaceRect = this.surface.getBoundingClientRect();
    try { this.surface.setPointerCapture(e.pointerId); } catch { /* ok */ }
    const p = this.pt(e);
    this.pointers.set(e.pointerId, p);
    cancelAnimationFrame(this.zanim);
    if (this.inertia) { cancelAnimationFrame(this.inertia); this.inertia = 0; }

    if (this.pointers.size === 1) {
      this.g = { type: 'pending', id: e.pointerId, sx: p.x, sy: p.y, t: performance.now(), x0: this.zoom.x, y0: this.zoom.y, samples: [] };
    } else if (this.pointers.size === 2) {
      if (this.g && this.g.type === 'flip' && this.flip) {
        // começou a pinçar no meio de uma virada: devolve a página
        this.animateFlip(0, 160, EASE.out, () => this.finishFlip(false));
      }
      this.startPinch();
    }
  }

  startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.g = {
      type: 'pinch',
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      s0: this.zoom.s, x0: this.zoom.x, y0: this.zoom.y,
    };
    this.stage.classList.add('gest');
    clearTimeout(this.tapTimer);
    this.lastTap = null;
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.pt(e);
    this.pointers.set(e.pointerId, p);
    const g = this.g;
    if (!g) return;

    if (g.type === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = clamp((g.s0 * d) / g.d0, 0.6, 7);
      const cx = (g.m0.x - g.x0) / g.s0;
      const cy = (g.m0.y - g.y0) / g.s0;
      let x = m.x - cx * s;
      let y = m.y - cy * s;
      if (s >= 1) { const c = this.clampZoom(s, x, y); x = c.x + c.ox * 0.3; y = c.y + c.oy * 0.3; }
      this.setZoom(s, x, y);
      return;
    }
    if (e.pointerId !== g.id) return;

    const dx = p.x - g.sx;
    const dy = p.y - g.sy;
    const now = performance.now();
    g.samples.push({ t: now, x: p.x, y: p.y });
    if (g.samples.length > 6) g.samples.shift();

    if (g.type === 'pending') {
      if (Math.hypot(dx, dy) < 9) return;
      clearTimeout(this.tapTimer);
      if (this.zoom.s > 1.02) {
        g.type = 'pan';
        this.stage.classList.add('gest');
      } else if (Math.abs(dx) > Math.abs(dy) * 0.9) {
        this.rushFlip();
        const ltrDx = this.rtl ? -dx : dx;
        this.startDragFlip(ltrDx < 0 ? 1 : -1, g);
      } else {
        g.type = 'none';
      }
    }

    if (g.type === 'pan') {
      const c = this.clampZoom(this.zoom.s, g.x0 + dx, g.y0 + dy);
      g.over = c.ox;
      g.overY = c.oy;
      this.setZoom(this.zoom.s, c.x + c.ox * 0.35, c.y + c.oy * 0.35);
    } else if (g.type === 'flip') {
      const ltrDx = this.rtl ? -dx : dx;
      const along = g.dir > 0 ? -ltrDx : ltrDx;
      g.along = along;
      const f = clamp(along / (2 * g.R), 0, 1);
      const q = Math.acos(1 - 2 * f) / Math.PI;
      if (!g.raf) {
        g.raf = requestAnimationFrame(() => { g.raf = 0; if (this.g === g && this.flip) this.renderFlip(g.q); });
      }
      g.q = q;
    } else if (g.type === 'edge') {
      const ltrDx = this.rtl ? -dx : dx;
      g.along = g.dir > 0 ? -ltrDx : ltrDx;
    }
  }

  startDragFlip(dir, g) {
    g.dir = dir;
    if (!this.beginFlip(dir)) { g.type = 'edge'; return; }
    const r = this.book.getBoundingClientRect();
    const sr = this.surfaceRect;
    const cx = g.sx + sr.left;
    const local = this.rtl ? r.right - cx : cx - r.left;
    const pw = this.pw, rx = this.rightX;
    let R;
    if (dir > 0) R = Math.max(local - rx, pw * 0.35);
    else R = this.double ? Math.max(rx - local, pw * 0.35) : pw * 0.5;
    g.R = Math.min(R, pw);
    g.q = 0;
    g.type = 'flip';
    this.flip.goal = null;
  }

  velocity(g, key) {
    const s = g.samples;
    if (s.length < 2) return 0;
    const last = s[s.length - 1];
    let first = s[0];
    for (const it of s) if (last.t - it.t <= 90) { first = it; break; }
    const dt = last.t - first.t;
    return dt > 0 ? (last[key] - first[key]) / dt : 0;
  }

  onUp(e, cancelled = false) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const g = this.g;
    if (!g) return;

    if (g.type === 'pinch') {
      if (this.pointers.size >= 2) return;
      this.stage.classList.remove('gest');
      const { s, x, y } = this.zoom;
      if (s < 1.08) this.animateZoom(1, 0, 0, 220);
      else {
        const s1 = Math.min(s, 5);
        const m = g.m0;
        const nx = s1 === s ? x : m.x - (m.x - x) * (s1 / s);
        const ny = s1 === s ? y : m.y - (m.y - y) * (s1 / s);
        const c = this.clampZoom(s1, nx, ny);
        this.animateZoom(s1, c.x, c.y, 220);
      }
      // o dedo que sobrou fica "parado" até ser levantado
      if (this.pointers.size === 1) {
        const [id, p] = [...this.pointers.entries()][0];
        this.g = { type: 'none', id, sx: p.x, sy: p.y, samples: [] };
      } else this.g = null;
      return;
    }
    if (e.pointerId !== g.id) return;
    this.g = null;

    if (g.type === 'pending' && !cancelled) {
      this.onTap(g.sx, g.sy);
      return;
    }

    if (g.type === 'flip' && this.flip) {
      cancelAnimationFrame(g.raf);
      this.renderFlip(g.q || 0);
      const vx = this.velocity(g, 'x') * (this.rtl ? -1 : 1);
      const v = g.dir > 0 ? -vx : vx;
      const q = this.flip.q;
      const commit = !cancelled && (v > 0.3 ? true : v < -0.3 ? false : q > 0.4);
      if (commit && this.o.prefs.sound) this.sound.play();
      const dur = 120 + 430 * Math.abs((commit ? 1 : 0) - q);
      this.animateFlip(commit ? 1 : 0, dur, EASE.out, () => this.finishFlip(commit));
      return;
    }

    if (g.type === 'edge') {
      if (g.dir > 0 && (g.along || 0) > 60) this.showEnd();
      else if (g.dir < 0 && (g.along || 0) > 60 && this.o.toast) this.o.toast('Você já está na capa');
      return;
    }

    if (g.type === 'pan') {
      this.stage.classList.remove('gest');
      const over = g.over || 0;
      if (Math.abs(over) > 80 && Math.abs(over) > Math.abs(g.overY || 0)) {
        const dir = over > 0 ? (this.rtl ? 1 : -1) : (this.rtl ? -1 : 1);
        this.animateZoom(1, 0, 0, 200, () => this.turn(dir));
        return;
      }
      const vx = this.velocity(g, 'x');
      const vy = this.velocity(g, 'y');
      const c = this.clampZoom(this.zoom.s, this.zoom.x, this.zoom.y);
      if (Math.abs(c.ox) > 1 || Math.abs(c.oy) > 1) { this.animateZoom(this.zoom.s, c.x, c.y, 220); return; }
      if (Math.hypot(vx, vy) > 0.25) this.glide(vx, vy);
    }
  }

  // inércia ao soltar o dedo depois de arrastar com zoom
  glide(vx, vy) {
    let last = performance.now();
    const step = now => {
      const dt = Math.min(32, now - last);
      last = now;
      const decay = Math.pow(0.94, dt / 16);
      vx *= decay;
      vy *= decay;
      const c = this.clampZoom(this.zoom.s, this.zoom.x + vx * dt, this.zoom.y + vy * dt);
      this.setZoom(this.zoom.s, c.x, c.y);
      if (Math.abs(c.ox) > 0.5) vx = 0;
      if (Math.abs(c.oy) > 0.5) vy = 0;
      if (Math.hypot(vx, vy) > 0.02) this.inertia = requestAnimationFrame(step);
      else this.inertia = 0;
    };
    this.inertia = requestAnimationFrame(step);
  }

  onTap(x, y) {
    const now = performance.now();
    const lt = this.lastTap;
    if (lt && now - lt.t < 300 && Math.hypot(x - lt.x, y - lt.y) < 40) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      this.onDoubleTap(x, y);
      return;
    }
    this.lastTap = { t: now, x, y };
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => { this.lastTap = null; this.onSingleTap(x, y); }, 250);
  }

  onSingleTap(x) {
    if (!this.ui.hint.hidden) return;
    if (this.zoom.s > 1.02) { this.showUI(!this.uiOn); return; }
    const W = this.W;
    if (x < W * 0.3) this.turn(this.rtl ? 1 : -1);
    else if (x > W * 0.7) this.turn(this.rtl ? -1 : 1);
    else this.showUI(!this.uiOn);
  }

  onDoubleTap(x, y) {
    if (this.zoom.s > 1.02) this.animateZoom(1, 0, 0, 260);
    else this.zoomAt(this.double ? 2.2 : 2.5, x, y, 280);
  }

  onWheel(e) {
    if (!this.isOpen) return;
    e.preventDefault();
    const p = this.pt(e);
    if (e.ctrlKey) {
      const s = clamp(this.zoom.s * Math.exp(-e.deltaY * 0.01), 1, 6);
      if (s === 1) { this.setZoom(1, 0, 0); return; }
      const k = s / this.zoom.s;
      const c = this.clampZoom(s, p.x - (p.x - this.zoom.x) * k, p.y - (p.y - this.zoom.y) * k);
      this.setZoom(s, c.x, c.y);
      return;
    }
    if (this.zoom.s > 1.02) {
      const c = this.clampZoom(this.zoom.s, this.zoom.x - e.deltaX, this.zoom.y - e.deltaY);
      this.setZoom(this.zoom.s, c.x, c.y);
      return;
    }
    const now = performance.now();
    if (now - (this.lastWheel || 0) < 450 || Math.abs(e.deltaY) < 8) return;
    this.lastWheel = now;
    this.turn(e.deltaY > 0 ? 1 : -1);
  }

  onKey(e) {
    if (!this.isOpen || document.querySelector('.sheet:not([hidden])')) return;
    const k = e.key;
    const cx = this.W / 2, cy = this.H / 2;
    if (k === 'ArrowRight') this.turn(this.rtl ? -1 : 1);
    else if (k === 'ArrowLeft') this.turn(this.rtl ? 1 : -1);
    else if (k === 'PageDown' || k === ' ') this.turn(1);
    else if (k === 'PageUp') this.turn(-1);
    else if (k === 'Home') this.goTo(0);
    else if (k === 'End') this.goTo(this.c.pageCount - 1);
    else if (k === '+' || k === '=') this.zoomAt(this.zoom.s * 1.5, cx, cy);
    else if (k === '-') this.zoomAt(this.zoom.s / 1.5, cx, cy);
    else if (k === '0') this.animateZoom(1, 0, 0);
    else if (k === 'Escape') {
      if (this.zoom.s > 1.02) this.animateZoom(1, 0, 0);
      else this.o.requestClose();
    } else return;
    e.preventDefault();
  }

  /* ---------- interface ---------- */

  showUI(v) {
    this.uiOn = v;
    this.el.classList.toggle('ui-off', !v);
    clearTimeout(this.uiTimer);
  }

  label(s) {
    const sp = this.spreads[s];
    const N = this.c.pageCount;
    if (sp.L != null && sp.R != null) return `${sp.L + 1}–${sp.R + 1} de ${N}`;
    return `${(sp.L != null ? sp.L : sp.R) + 1} de ${N}`;
  }

  paintRange(page) {
    const N = this.c.pageCount;
    const pct = N > 1 ? (page / (N - 1)) * 100 : 100;
    this.ui.scrub.style.setProperty('--pct', pct + '%');
    this.ui.bubble.textContent = page + 1;
  }

  updateUI() {
    if (!this.spreads) return;
    const N = this.c.pageCount;
    const page = this.currentPage();
    this.ui.sub.textContent = 'Página ' + this.label(this.spread);
    const r = this.ui.range;
    r.max = String(N);
    r.value = String(page + 1);
    this.paintRange(page);
  }

  setRtl(v, relayout = true) {
    this.rtl = v;
    this.book.classList.toggle('rtl', v);
    this.el.classList.toggle('is-rtl', v);
    this.ui.range.dir = v ? 'rtl' : 'ltr';
    if (relayout && this.spreads) { this.stopFlip(); this.setZoom(1, 0, 0); this.showSpread(); }
  }
}
