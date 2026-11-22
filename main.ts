// makefun anchor caa6431f5c751b3cb2006394ca785259f957e7fc round 34167734
// THE WORLD TODAY — Sunday 22 November 2026.
// A code-drawn front page: masthead + stats + heroes + medium grid + world map + more stories.
// Node 22 stdlib only. Deterministic: seeded PRNG, no clock, no network.
// Output: /output/entry.png (or $MAKEFUN_OUTPUT_DIR), 1024x1024 RGB PNG, <= 1 MiB.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const W = 1024, H = 1024;
const OUT = join(process.env.MAKEFUN_OUTPUT_DIR ?? '/output', 'entry.png');

// ---------- deterministic PRNG (mulberry32) ----------
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- CRC32 (PNG chunks) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
// Paeth predictor (PNG filter 4)
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
function encodePNG(rgb, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const bpp = 3, stride = w * bpp;
  const raw = Buffer.alloc(h * (1 + stride));
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    const out = raw.subarray(y * (1 + stride), (y + 1) * (1 + stride));
    out[0] = 4; // Paeth
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      out[1 + i] = (row[i] - paeth(a, b, c)) & 0xFF;
    }
    prev.set(row);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- Canvas (RGB buffer) ----------
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
class Canvas {
  constructor(w, h, bg) {
    this.w = w; this.h = h;
    this.buf = Buffer.alloc(w * h * 3);
    const c = rgb(bg);
    for (let i = 0; i < w * h; i++) { this.buf[i * 3] = c[0]; this.buf[i * 3 + 1] = c[1]; this.buf[i * 3 + 2] = c[2]; }
  }
  px(x, y) { return (y * this.w + x) * 3; }
  set(x, y, c) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = this.px(x, y);
    this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2];
  }
  // blend a color over the pixel with alpha 0..1
  blend(x, y, c, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    if (a >= 1) { this.set(x, y, c); return; }
    const i = this.px(x, y), ia = 1 - a;
    this.buf[i] = Math.round(this.buf[i] * ia + c[0] * a);
    this.buf[i + 1] = Math.round(this.buf[i + 1] * ia + c[1] * a);
    this.buf[i + 2] = Math.round(this.buf[i + 2] * ia + c[2] * a);
  }
  rect(x, y, w, h, hex) {
    const c = rgb(hex);
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) this.set(xx, yy, c);
  }
  // antialiased line (Wu)
  line(x0, y0, x1, y1, hex, width) {
    const c = rgb(hex);
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(len * 2));
    const w2 = (width || 1) / 2;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, cx = x0 + dx * t, cy = y0 + dy * t;
      for (let oy = -Math.ceil(w2); oy <= Math.ceil(w2); oy++)
        for (let ox = -Math.ceil(w2); ox <= Math.ceil(w2); ox++) {
          const d = Math.hypot(ox, oy);
          if (d <= w2 + 0.5) this.blend(cx + ox, cy + oy, c, Math.max(0, Math.min(1, w2 + 0.5 - d)));
        }
    }
  }
  circle(cx, cy, r, hex) {
    const c = rgb(hex);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r) this.blend(x, y, c, d <= r - 0.7 ? 1 : Math.max(0, r + 0.5 - d));
    }
  }
  ring(cx, cy, r, hex, width) {
    const c = rgb(hex);
    const x0 = Math.max(0, Math.floor(cx - r - width)), x1 = Math.min(this.w - 1, Math.ceil(cx + r + width));
    const y0 = Math.max(0, Math.floor(cy - r - width)), y1 = Math.min(this.h - 1, Math.ceil(cy + r + width));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r);
      if (d <= width / 2 + 0.5) this.blend(x, y, c, Math.max(0, Math.min(1, width / 2 + 0.5 - d)));
    }
  }
  // filled polygon, even-odd, 4x vertical supersampling for AA edges
  poly(pts, hex, alpha) {
    const c = rgb(hex); const a = alpha === undefined ? 1 : alpha;
    let minY = 1e9, maxY = -1e9;
    for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(this.h - 1, Math.ceil(maxY));
    const edges = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if (p[1] === q[1]) continue;
      edges.push([p, q]);
    }
    for (let y = y0; y <= y1; y++) {
      let cov = 0;
      for (let s = 0; s < 4; s++) {
        const sy = y + (s + 0.5) / 4;
        const xs = [];
        for (const [p, q] of edges) {
          const ymin = Math.min(p[1], q[1]), ymax = Math.max(p[1], q[1]);
          if (sy < ymin || sy >= ymax) continue;
          xs.push(p[0] + (sy - p[1]) * (q[0] - p[0]) / (q[1] - p[1]));
        }
        xs.sort((u, v) => u - v);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const x0 = xs[k], x1 = xs[k + 1];
          const xa = Math.max(0, Math.floor(x0)), xb = Math.min(this.w - 1, Math.ceil(x1) - 1);
          for (let x = xa; x <= xb; x++) {
            const l = Math.max(x, x0), r = Math.min(x + 1, x1);
            if (r > l) cov += 0; // placeholder, per-pixel below
          }
          // accumulate coverage per pixel into a row buffer
          for (let x = xa; x <= xb; x++) {
            const l = Math.max(x, x0), r = Math.min(x + 1, x1);
            if (r > l) this._cov[y * this.w + x] = (this._cov[y * this.w + x] || 0) + (r - l) / 4;
          }
        }
      }
    }
    // apply coverage (this pass is merged into the loop above via _cov; flush here)
    for (let y = y0; y <= y1; y++) {
      for (let x = 0; x < this.w; x++) {
        const cv = this._cov[y * this.w + x];
        if (cv) { this.blend(x, y, c, Math.min(1, cv) * a); this._cov[y * this.w + x] = 0; }
      }
    }
  }
}

// ---------- corrected filled polygon (overrides chunk-1 poly) ----------
Canvas.prototype.poly = function (pts, hex, alpha) {
  this.polyMulti([pts], hex, alpha);
};
// fill several contours together, even-odd across all of them (glyph holes)
Canvas.prototype.polyMulti = function (contours, hex, alpha) {
  const c = rgb(hex); const a = alpha === undefined ? 1 : alpha;
  let minY = 1e9, maxY = -1e9;
  const edges = [];
  for (const pts of contours) {
    if (!pts || pts.length < 3) continue;
    for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if (p[1] === q[1]) continue;
      edges.push([p, q]);
    }
  }
  if (!edges.length) return;
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(this.h - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const cov = new Map();
    for (let s = 0; s < 4; s++) {
      const sy = y + (s + 0.5) / 4;
      const xs = [];
      for (const e of edges) {
        const p = e[0], q = e[1];
        const ymin = Math.min(p[1], q[1]), ymax = Math.max(p[1], q[1]);
        if (sy < ymin || sy >= ymax) continue;
        xs.push(p[0] + (sy - p[1]) * (q[0] - p[0]) / (q[1] - p[1]));
      }
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = xs[k], x1 = xs[k + 1];
        const xa = Math.max(0, Math.floor(x0)), xb = Math.min(this.w - 1, Math.ceil(x1) - 1);
        for (let x = xa; x <= xb; x++) {
          const l = Math.max(x, x0), r = Math.min(x + 1, x1);
          if (r > l) cov.set(x, (cov.get(x) || 0) + (r - l) / 4);
        }
      }
    }
    for (const [x, cv] of cov) this.blend(x, y, c, Math.min(1, cv) * a);
  }
};

// ---------- TrueType font (parser + rasterizer) ----------
function u16(b, o) { return b.readUInt16BE(o); }
function i16(b, o) { return b.readInt16BE(o); }
function u32(b, o) { return b.readUInt32BE(o); }
class Font {
  constructor(buf) {
    this.buf = buf;
    this.tables = {};
    const n = u16(buf, 4);
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      this.tables[buf.toString('ascii', o, o + 4)] = { off: u32(buf, o + 8), len: u32(buf, o + 12) };
    }
    const head = this.tables['head'].off;
    this.upm = u16(buf, head + 18);
    this.locFmt = i16(buf, head + 50);
    this.numGlyphs = u16(buf, this.tables['maxp'].off + 4);
    this.numHMetrics = u16(buf, this.tables['hhea'].off + 34);
    this.cmap = this._parseCmap();
    this.cache = new Map();
  }
  _parseCmap() {
    const b = this.buf, base = this.tables['cmap'].off;
    const n = u16(b, base + 2);
    let fmt4 = -1;
    for (let i = 0; i < n; i++) {
      const plat = u16(b, base + 4 + i * 8), enc = u16(b, base + 6 + i * 8), off = u32(b, base + 8 + i * 8);
      if ((plat === 3 && enc === 1) || (plat === 0)) { fmt4 = base + off; break; }
      if (fmt4 < 0) fmt4 = base + off;
    }
    const fmt = u16(b, fmt4);
    if (fmt !== 4) throw new Error('cmap not format 4');
    const segCount = u16(b, fmt4 + 6) / 2;
    const endBase = fmt4 + 14, startBase = endBase + segCount * 2 + 2;
    const deltaBase = startBase + segCount * 2, rangeBase = deltaBase + segCount * 2;
    const segs = [];
    for (let i = 0; i < segCount; i++) {
      segs.push({
        end: u16(b, endBase + i * 2),
        start: u16(b, startBase + i * 2),
        delta: i16(b, deltaBase + i * 2),
        rangeOff: u16(b, rangeBase + i * 2),
        rangeAddr: rangeBase + i * 2,
      });
    }
    const glyphArrBase = rangeBase + segCount * 2;
    return { segs, glyphArrBase };
  }
  glyphId(code) {
    const { segs, glyphArrBase } = this.cmap;
    for (const s of segs) {
      if (code < s.start || code > s.end) continue;
      if (s.rangeOff === 0) return (code + s.delta) & 0xFFFF;
      const addr = s.rangeAddr + s.rangeOff + 2 * (code - s.start);
      const g = u16(this.buf, addr);
      return g === 0 ? 0 : (g + s.delta) & 0xFFFF;
    }
    return 0;
  }
  advance(gid) {
    const b = this.buf, hm = this.tables['hmtx'].off;
    const g = gid < this.numHMetrics ? gid : this.numHMetrics - 1;
    return u16(b, hm + g * 4);
  }
  glyph(gid) {
    if (this.cache.has(gid)) return this.cache.get(gid);
    const b = this.buf;
    const loca = this.tables['loca'].off, glyf = this.tables['glyf'].off;
    let o0, o1;
    if (this.locFmt === 0) { o0 = u16(b, loca + gid * 2) * 2; o1 = u16(b, loca + (gid + 1) * 2) * 2; }
    else { o0 = u32(b, loca + gid * 4); o1 = u32(b, loca + (gid + 1) * 4); }
    let out = { adv: this.advance(gid), contours: [] };
    if (o0 !== o1) out.contours = this._glyphAt(glyf + o0, 0);
    this.cache.set(gid, out);
    return out;
  }
  _glyphAt(off, depth) {
    const b = this.buf;
    const nC = i16(b, off);
    if (nC >= 0) return this._simple(off, nC);
    if (depth > 4) return [];
    // composite: components until MORE_COMPONENTS (0x0020) clears
    const contours = [];
    let p = off + 10;
    for (;;) {
      const flags = u16(b, p); const comp = u16(b, p + 2); p += 4;
      let ax = 0, ay = 0;
      if (flags & 0x0001) { ax = i16(b, p); ay = i16(b, p + 2); p += 4; }
      else { ax = b.readInt8(p); ay = b.readInt8(p + 1); p += 2; }
      let a = 1, bb = 0, c = 0, d = 1;
      if (flags & 0x0008) { const s = i16(b, p) / 16384; a = d = s; p += 2; }
      else if (flags & 0x0020) { a = i16(b, p) / 16384; d = i16(b, p + 2) / 16384; p += 4; }
      else if (flags & 0x0040) {
        a = i16(b, p) / 16384; c = i16(b, p + 2) / 16384;
        bb = i16(b, p + 4) / 16384; d = i16(b, p + 6) / 16384; p += 8;
      }
      const sub = this.glyph(comp).contours;
      for (const cn of sub) {
        contours.push(cn.map(pt => [a * pt[0] + c * pt[1] + ax, bb * pt[0] + d * pt[1] + ay]));
      }
      if (!(flags & 0x2000)) break;
    }
    return contours;
  }
  _simple(off, nC) {
    const b = this.buf;
    let p = off + 10;
    const endPts = [];
    for (let i = 0; i < nC; i++) { endPts.push(u16(b, p)); p += 2; }
    const insLen = u16(b, p); p += 2 + insLen;
    const nPts = endPts[nC - 1] + 1;
    const flags = [];
    for (let i = 0; i < nPts; i++) {
      const f = b[p++];
      flags.push(f);
      if (f & 0x08) { const rep = b[p++]; for (let k = 0; k < rep; k++) flags.push(f); i += rep; }
    }
    const xs = [], ys = [];
    let x = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 0x02) { const v = b[p++]; x += (f & 0x10) ? v : -v; }
      else if (!(f & 0x10)) { x += i16(b, p); p += 2; }
      xs.push(x);
    }
    let y = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 0x04) { const v = b[p++]; y += (f & 0x20) ? v : -v; }
      else if (!(f & 0x20)) { y += i16(b, p); p += 2; }
      ys.push(y);
    }
    const on = flags.map(f => (f & 0x01) === 1);
    const contours = [];
    let start = 0;
    for (let ci = 0; ci < nC; ci++) {
      const end = endPts[ci];
      const pts = [];
      for (let i = start; i <= end; i++) pts.push([xs[i], ys[i], on[i]]);
      contours.push(this._flattenContour(pts));
      start = end + 1;
    }
    return contours;
  }
  // turn a TrueType contour (on/off-curve points) into a polyline (font units, y up)
  _flattenContour(pts) {
    if (!pts.length) return [];
    // build a sequence of on-curve anchor points with control points between them
    const seq = [];
    const n = pts.length;
    // find a starting on-curve point
    let si = -1;
    for (let i = 0; i < n; i++) if (pts[i][2]) { si = i; break; }
    if (si < 0) {
      // all off-curve: implied on-curve midpoints
      const m0 = [(pts[0][0] + pts[n - 1][0]) / 2, (pts[0][1] + pts[n - 1][1]) / 2];
      seq.push({ p: m0, c: null });
      for (let k = 0; k < n; k++) {
        const i = (si + 1 + k) % n;
        const cur = pts[i], nxt = pts[(i + 1) % n];
        if (!cur[2] && !nxt[2]) {
          seq.push({ p: [(cur[0] + nxt[0]) / 2, (cur[1] + nxt[1]) / 2], c: [cur[0], cur[1]] });
        } else if (!cur[2]) {
          seq.push({ p: [nxt[0], nxt[1]], c: [cur[0], cur[1]] });
        }
      }
    } else {
      // rotate so we start at an on-curve point
      const rot = [];
      for (let k = 0; k < n; k++) rot.push(pts[(si + k) % n]);
      // walk: each entry is {p: on-curve anchor, c: control point used to reach it (or null)}
      for (let k = 0; k < rot.length; k++) {
        const cur = rot[k], nxt = rot[(k + 1) % rot.length];
        if (cur[2]) {
          seq.push({ p: [cur[0], cur[1]], c: null });
        } else {
          // off-curve: next point decides
          if (nxt[2]) {
            seq.push({ p: [nxt[0], nxt[1]], c: [cur[0], cur[1]] });
          } else {
            seq.push({ p: [(cur[0] + nxt[0]) / 2, (cur[1] + nxt[1]) / 2], c: [cur[0], cur[1]] });
          }
        }
      }
    }
    // flatten: walk anchors, emitting line segments / quadratic subdivisions
    const out = [];
    if (!seq.length) return out;
    out.push(seq[0].p);
    for (let i = 1; i <= seq.length; i++) {
      const s = seq[i % seq.length];
      const prev = out[out.length - 1];
      if (s.c) {
        this._quad(out, prev, s.c, s.p, 0);
      } else {
        out.push(s.p);
      }
    }
    return out;
  }
  _quad(out, p0, p1, p2, depth) {
    // flatness: distance from control point to chord
    const mx = (p0[0] + p2[0]) / 2, my = (p0[1] + p2[1]) / 2;
    const dx = p1[0] - mx, dy = p1[1] - my;
    if (depth >= 5 || (dx * dx + dy * dy) < 9) { out.push(p2); return; }
    const m01 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const m12 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    const m = [(m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2];
    this._quad(out, p0, m01, m, depth + 1);
    this._quad(out, m, m12, p2, depth + 1);
  }
}

// ---------- text ----------
function loadFont(name) {
  const dir = dirname(fileURLToPath(import.meta.url));
  return new Font(readFileSync(join(dir, 'fonts', name)));
}
function textWidth(font, text, size, scaleX, tracking) {
  const sx = scaleX === undefined ? 1 : scaleX;
  const tr = tracking === undefined ? 0 : tracking;
  let w = 0;
  for (const ch of text) {
    if (ch === ' ') { w += font.upm * 0.25 * (size / font.upm) * sx + tr; continue; }
    const g = font.glyph(font.glyphId(ch.codePointAt(0)));
    w += g.adv * (size / font.upm) * sx + tr;
  }
  return w;
}
function drawText(cv, font, text, x, y, size, hex, opts) {
  const o = opts || {};
  const sx = o.scaleX === undefined ? 1 : o.scaleX;
  const tr = o.tracking === undefined ? 0 : o.tracking;
  const alpha = o.alpha === undefined ? 1 : o.alpha;
  const scale = size / font.upm;
  let w = textWidth(font, text, size, sx, tr);
  let cx = x;
  if (o.align === 'center') cx = x - w / 2;
  else if (o.align === 'right') cx = x - w;
  for (const ch of text) {
    if (ch === ' ') { cx += font.upm * 0.25 * scale * sx + tr; continue; }
    const gid = font.glyphId(ch.codePointAt(0));
    const g = font.glyph(gid);
    // fill ALL contours of the glyph together (even-odd) so counters stay hollow
    const all = g.contours.map(cn => cn.map(pt => [cx + pt[0] * scale * sx, y - pt[1] * scale]));
    if (all.length) cv.polyMulti(all, hex, alpha);
    cx += g.adv * scale * sx + tr;
  }
  return w;
}
function wrapText(font, text, size, maxW, scaleX, tracking) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (textWidth(font, t, size, scaleX, tracking) <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------- palette ----------
const INK = '#1b1b1b', PAPER = '#f6f1e7', RED = '#b3261e', REDDK = '#8c1d17';
const BLUE = '#1d4e6b', BLUELT = '#2a6a8a', SKY = '#cfe0e8', SAND = '#e7dcc3';
const GOLD = '#c08a2d', ORANGE = '#e07b2a', GREEN = '#3f6b3a', GREY = '#6b6b6b';
const SEA = '#cdd9dd', LAND = '#ddd2b8', LANDLINE = '#8a7d5f';

// ---------- small drawing helpers ----------
function hline(cv, x, y, w, hex, t) { cv.rect(x, y, w, t || 1, hex); }
function vline(cv, x, y, h, hex, t) { cv.rect(x, y, t || 1, h, hex); }
function labelChip(cv, x, y, text, font, bg, fg, size) {
  const fs = size || 10;
  const w = textWidth(font, text, fs, 1, 1.2) + 12;
  cv.rect(x, y, w, 16, bg);
  drawText(cv, font, text, x + 6, y + 12.5, fs, fg, { tracking: 1.2 });
  return w;
}
function flame(cv, x, y, w, h, seed) {
  const r = rng(seed);
  // layered flame tongues
  for (let i = 0; i < 5; i++) {
    const fx = x + w * (0.15 + 0.7 * r());
    const fw = w * (0.22 + 0.18 * r());
    const fh = h * (0.55 + 0.45 * r());
    const cols = ['#e07b2a', '#f2a541', '#f7c948', '#c0392b'];
    cv.poly([[fx - fw / 2, y + h], [fx - fw * 0.28, y + h - fh * 0.6], [fx, y + h - fh],
      [fx + fw * 0.3, y + h - fh * 0.55], [fx + fw / 2, y + h]], cols[i % 4]);
  }
}
function smoke(cv, x, y, w, h, seed, dark) {
  const r = rng(seed);
  const col = dark ? '#6a6a6a' : '#a8a8a8';
  const rad = Math.max(5, Math.min(w, h) * 0.32);
  let cx = x, cy = y + h;
  for (let i = 0; i < 4; i++) {
    cv.circle(cx, cy, rad * (0.7 + 0.5 * r()), col);
    cx += (r() - 0.35) * w * 0.3; cy -= h * 0.22;
  }
}
function waves(cv, x, y, w, h, col, seed) {
  const r = rng(seed);
  for (let row = 0; row < 3; row++) {
    const yy = y + h * (0.25 + row * 0.3);
    for (let wx = x; wx < x + w; wx += 14) {
      cv.line(wx, yy + r() * 2, wx + 9, yy + r() * 2, col, 1.5);
    }
  }
}
function buildingRow(cv, x, y, w, h, seed, col) {
  const r = rng(seed);
  let bx = x;
  while (bx < x + w - 8) {
    const bw = 8 + r() * 16, bh = h * (0.4 + r() * 0.6);
    cv.rect(bx, y + h - bh, bw, bh, col);
    for (let wy = y + h - bh + 4; wy < y + h - 4; wy += 6)
      for (let wx = bx + 2; wx < bx + bw - 2; wx += 5)
        if (r() < 0.5) cv.rect(wx, wy, 2, 3, '#f7c948');
    bx += bw + 2 + r() * 4;
  }
}

// ---------- hero / medium scenes (each draws inside x,y,w,h) ----------
function sceneHormuz(cv, x, y, w, h) {
  // dusk sky over the Strait of Hormuz
  cv.rect(x, y, w, h, '#2a3a4a');
  cv.rect(x, y, w, h * 0.42, '#e8963c');
  cv.rect(x, y, w, h * 0.28, '#c96a2e');
  cv.circle(x + w * 0.78, y + h * 0.2, 13, '#f7e3a1');
  // Bahrain skyline silhouette
  cv.rect(x + w * 0.02, y + h * 0.34, w, h * 0.1, '#1b1b1b');
  buildingRow(cv, x + w * 0.03, y + h * 0.16, w * 0.4, h * 0.28, 11, '#1b1b1b');
  // sea
  cv.rect(x, y + h * 0.44, w, h * 0.56, '#17394f');
  cv.rect(x, y + h * 0.44, w, h * 0.56, '#1d4e6b');
  waves(cv, x + 6, y + h * 0.5, w - 12, h * 0.45, '#7fb3c8', 21);
  // tanker 1 (burning)
  const tx = x + w * 0.08, ty = y + h * 0.52, tw = w * 0.42, th = h * 0.16;
  cv.poly([[tx, ty + th], [tx + tw * 0.06, ty], [tx + tw * 0.94, ty], [tx + tw, ty + th]], '#0f0f0f');
  cv.rect(tx + tw * 0.1, ty - h * 0.1, tw * 0.5, h * 0.1, '#333333');
  cv.rect(tx + tw * 0.62, ty - h * 0.16, tw * 0.08, h * 0.16, '#222222');
  smoke(cv, tx + tw * 0.2, ty - h * 0.5, tw * 0.4, h * 0.4, 41, true);
  flame(cv, tx + tw * 0.15, ty - h * 0.42, tw * 0.5, h * 0.42, 31);
  // tanker 2 (hit, listing)
  const ux = x + w * 0.58, uy = y + h * 0.6, uw = w * 0.36, uh = h * 0.13;
  cv.poly([[ux, uy + uh], [ux + uw * 0.05, uy], [ux + uw * 0.9, uy + uh * 0.4], [ux + uw, uy + uh]], '#141414');
  smoke(cv, ux + uw * 0.15, uy - h * 0.38, uw * 0.35, h * 0.3, 61, true);
  flame(cv, ux + uw * 0.1, uy - h * 0.3, uw * 0.45, h * 0.3, 51);
  // missile arcs
  cv.line(x + w * 0.05, y + h * 0.05, x + w * 0.35, y + h * 0.42, '#f7c948', 2);
  cv.line(x + w * 0.2, y + h * 0.02, x + w * 0.5, y + h * 0.4, '#ffffff', 1.5);
  cv.circle(x + w * 0.35, y + h * 0.42, 4, '#ffffff');
  cv.circle(x + w * 0.5, y + h * 0.4, 3, '#f7c948');
  // warship escort
  cv.poly([[x + w * 0.86, y + h * 0.86], [x + w * 0.9, y + h * 0.78], [x + w * 0.98, y + h * 0.78], [x + w * 0.99, y + h * 0.86]], '#222222');
  cv.rect(x + w * 0.9, y + h * 0.72, w * 0.03, h * 0.06, '#222222');
  cv.line(x + w * 0.86, y + h * 0.88, x + w * 0.99, y + h * 0.88, '#7fb3c8', 1);
}
function sceneCOP(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#274b63');
  // globe
  cv.circle(x + w * 0.22, y + h * 0.42, h * 0.3, '#3f7d9e');
  cv.poly([[x + w * 0.1, y + h * 0.3], [x + w * 0.2, y + h * 0.24], [x + w * 0.3, y + h * 0.32], [x + w * 0.26, y + h * 0.5], [x + w * 0.14, y + h * 0.55]], '#4a9e5f');
  cv.poly([[x + w * 0.24, y + h * 0.55], [x + w * 0.32, y + h * 0.6], [x + w * 0.3, y + h * 0.68], [x + w * 0.2, y + h * 0.62]], '#4a9e5f');
  cv.ring(x + w * 0.22, y + h * 0.42, h * 0.3, '#f6f1e7', 2);
  // oil drop crossed out
  const ox = x + w * 0.62, oy = y + h * 0.4;
  cv.poly([[ox, oy - h * 0.22], [ox + w * 0.09, oy + h * 0.05], [ox, oy + h * 0.14], [ox - w * 0.09, oy + h * 0.05]], '#1b1b1b');
  cv.circle(ox, oy + h * 0.05, w * 0.09, '#1b1b1b');
  cv.line(ox - w * 0.13, oy - h * 0.2, ox + w * 0.13, oy + h * 0.22, RED, 3);
  cv.line(ox + w * 0.13, oy - h * 0.2, ox - w * 0.13, oy + h * 0.22, RED, 3);
  // delegates row
  const r = rng(71);
  for (let i = 0; i < 7; i++) {
    const dx = x + w * 0.06 + i * w * 0.13;
    cv.circle(dx + w * 0.04, y + h * 0.82, h * 0.07, '#e8c9a0');
    cv.rect(dx, y + h * 0.88, w * 0.09, h * 0.12, ['#b3261e', '#2a6a8a', '#c08a2d', '#3f6b3a'][i % 4]);
  }
  // flags
  for (let i = 0; i < 4; i++) {
    const fx = x + w * (0.78 + i * 0.05);
    cv.line(fx, y + h * 0.05, fx, y + h * 0.3, '#f6f1e7', 1.5);
    cv.rect(fx, y + h * 0.05, w * 0.04, h * 0.07, ['#b3261e', '#3f6b3a', '#c08a2d', '#2a6a8a'][i]);
  }
}
function sceneFactory(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#3a2f2a');
  cv.rect(x, y, w, h * 0.3, '#5a4a3a');
  // factory sheds
  cv.rect(x + w * 0.05, y + h * 0.45, w * 0.55, h * 0.4, '#6b5a4a');
  cv.poly([[x + w * 0.05, y + h * 0.45], [x + w * 0.32, y + h * 0.3], [x + w * 0.6, y + h * 0.45]], '#4a3a30');
  cv.rect(x + w * 0.62, y + h * 0.35, w * 0.3, h * 0.5, '#7a6a5a');
  cv.rect(x + w * 0.7, y + h * 0.18, w * 0.06, h * 0.2, '#5a4a3a');
  for (let i = 0; i < 4; i++) cv.rect(x + w * (0.1 + i * 0.12), y + h * 0.6, w * 0.06, h * 0.12, '#f7c948');
  smoke(cv, x + w * 0.2, y + h * 0.02, w * 0.5, h * 0.3, 101, true);
  flame(cv, x + w * 0.1, y + h * 0.05, w * 0.5, h * 0.45, 81);
  flame(cv, x + w * 0.65, y + h * 0.15, w * 0.25, h * 0.3, 91);
  // rescue: ladder + figures
  cv.line(x + w * 0.82, y + h * 0.85, x + w * 0.95, y + h * 0.5, '#c08a2d', 3);
  cv.circle(x + w * 0.88, y + h * 0.72, 4, '#e8c9a0');
  cv.circle(x + w * 0.8, y + h * 0.85, 4, '#e8c9a0');
}
function sceneMissile(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#1d2b3a');
  cv.circle(x + w * 0.75, y + h * 0.2, 9, '#f7e3a1');
  // interceptor streaks
  cv.line(x + w * 0.1, y + h * 0.9, x + w * 0.4, y + h * 0.25, '#f7c948', 2);
  cv.line(x + w * 0.25, y + h * 0.9, x + w * 0.55, y + h * 0.3, '#ffffff', 2);
  cv.line(x + w * 0.4, y + h * 0.9, x + w * 0.68, y + h * 0.35, '#f7c948', 2);
  // explosion bursts
  for (const [bx, by, s] of [[0.4, 0.25, 8], [0.55, 0.3, 6], [0.68, 0.35, 7]]) {
    cv.circle(x + w * bx, y + h * by, s, '#f7c948');
    cv.circle(x + w * bx, y + h * by, s * 0.55, '#ffffff');
  }
  // skyline
  buildingRow(cv, x, y + h * 0.75, w, h * 0.25, 111, '#0f0f0f');
}
function sceneShip(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#274b63');
  cv.rect(x, y, w, h * 0.55, '#cfe0e8');
  cv.rect(x, y + h * 0.55, w, h * 0.45, '#1d4e6b');
  waves(cv, x + 4, y + h * 0.6, w - 8, h * 0.35, '#7fb3c8', 121);
  const sx = x + w * 0.12, sy = y + h * 0.5, sw = w * 0.76, sh = h * 0.14;
  cv.poly([[sx, sy + sh], [sx + sw * 0.05, sy], [sx + sw * 0.95, sy], [sx + sw, sy + sh]], '#5a3a2a');
  cv.rect(sx + sw * 0.15, sy - h * 0.12, sw * 0.4, h * 0.12, '#7a5a4a');
  cv.rect(sx + sw * 0.6, sy - h * 0.18, sw * 0.08, h * 0.18, '#4a3a30');
  smoke(cv, sx + sw * 0.25, sy - h * 0.5, sw * 0.4, h * 0.35, 141, true);
  flame(cv, sx + sw * 0.2, sy - h * 0.45, sw * 0.5, h * 0.45, 131);
  // drone
  cv.circle(x + w * 0.85, y + h * 0.18, 3, '#1b1b1b');
  cv.line(x + w * 0.82, y + h * 0.15, x + w * 0.88, y + h * 0.15, '#1b1b1b', 1);
}
function scenePoland(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#4a4a3a');
  cv.rect(x, y, w, h * 0.4, '#8a8a6a');
  // field + debris
  cv.rect(x, y + h * 0.6, w, h * 0.4, '#6b8a4a');
  cv.poly([[x + w * 0.2, y + h * 0.62], [x + w * 0.3, y + h * 0.45], [x + w * 0.42, y + h * 0.62]], '#3a3a3a');
  cv.poly([[x + w * 0.55, y + h * 0.62], [x + w * 0.62, y + h * 0.52], [x + w * 0.7, y + h * 0.62]], '#2a2a2a');
  cv.circle(x + w * 0.3, y + h * 0.45, 3, '#f7c948');
  // smoke column
  smoke(cv, x + w * 0.25, y + h * 0.1, w * 0.2, h * 0.35, 151, true);
  // NATO flag
  cv.rect(x + w * 0.72, y + h * 0.15, w * 0.22, h * 0.2, '#1d4e6b');
  cv.circle(x + w * 0.83, y + h * 0.25, 4, '#ffffff');
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    cv.circle(x + w * 0.83 + Math.cos(a) * 7, y + h * 0.25 + Math.sin(a) * 7, 1.2, '#ffffff');
  }
}
function sceneBoat(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#cfe0e8');
  cv.rect(x, y + h * 0.55, w, h * 0.45, '#2a6a8a');
  waves(cv, x + 4, y + h * 0.6, w - 8, h * 0.35, '#a8c8d8', 161);
  // capsized boat
  cv.poly([[x + w * 0.15, y + h * 0.55], [x + w * 0.3, y + h * 0.42], [x + w * 0.6, y + h * 0.45], [x + w * 0.75, y + h * 0.58]], '#7a4a2a');
  cv.rect(x + w * 0.18, y + h * 0.45, w * 0.1, h * 0.08, '#5a3a2a');
  // people in water
  const r = rng(171);
  for (let i = 0; i < 5; i++) {
    const px = x + w * (0.2 + r() * 0.6), py = y + h * (0.62 + r() * 0.2);
    cv.circle(px, py, 3.5, '#e8c9a0');
    cv.rect(px - 4, py + 3, 8, 3, '#b3261e');
  }
  // rescue boat
  cv.poly([[x + w * 0.6, y + h * 0.78], [x + w * 0.65, y + h * 0.7], [x + w * 0.9, y + h * 0.7], [x + w * 0.95, y + h * 0.78]], '#f7c948');
}
function sceneRaid(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#5a4a3a');
  cv.rect(x, y, w, h * 0.35, '#c98a4a');
  cv.circle(x + w * 0.8, y + h * 0.16, 10, '#f7e3a1');
  // helicopter
  const hx = x + w * 0.2, hy = y + h * 0.25;
  cv.rect(hx, hy, w * 0.3, h * 0.12, '#1b1b1b');
  cv.line(hx - w * 0.05, hy - h * 0.03, hx + w * 0.35, hy - h * 0.03, '#1b1b1b', 2);
  cv.line(hx + w * 0.28, hy + h * 0.02, hx + w * 0.45, hy - h * 0.06, '#1b1b1b', 2);
  cv.line(hx + w * 0.05, hy + h * 0.12, hx + w * 0.02, y + h * 0.6, '#8a8a8a', 1.5);
  // ground: street + figures
  cv.rect(x, y + h * 0.65, w, h * 0.35, '#3a3a3a');
  cv.line(x, y + h * 0.82, x + w, y + h * 0.82, '#f7c948', 1.5);
  const r = rng(181);
  for (let i = 0; i < 4; i++) {
    const fx = x + w * (0.15 + i * 0.2);
    cv.circle(fx, y + h * 0.7, 4, '#e8c9a0');
    cv.rect(fx - 3, y + h * 0.74, 6, h * 0.1, i === 0 ? '#b3261e' : '#2a4a2a');
  }
  // building
  cv.rect(x + w * 0.7, y + h * 0.4, w * 0.25, h * 0.25, '#7a6a5a');
  for (let i = 0; i < 3; i++) cv.rect(x + w * (0.73 + i * 0.07), y + h * 0.45, w * 0.04, h * 0.06, '#f7c948');
}
function scenePlant(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#3a3a4a');
  cv.rect(x, y, w, h * 0.35, '#6a5a4a');
  // cooling towers
  cv.poly([[x + w * 0.1, y + h * 0.85], [x + w * 0.14, y + h * 0.45], [x + w * 0.26, y + h * 0.45], [x + w * 0.3, y + h * 0.85]], '#8a8a8a');
  cv.poly([[x + w * 0.38, y + h * 0.85], [x + w * 0.42, y + h * 0.5], [x + w * 0.54, y + h * 0.5], [x + w * 0.58, y + h * 0.85]], '#7a7a7a');
  cv.rect(x + w * 0.66, y + h * 0.4, w * 0.08, h * 0.45, '#6a6a6a');
  cv.rect(x + w * 0.78, y + h * 0.35, w * 0.06, h * 0.5, '#5a5a5a');
  smoke(cv, x + w * 0.15, y + h * 0.05, w * 0.5, h * 0.35, 201, true);
  flame(cv, x + w * 0.6, y + h * 0.25, w * 0.35, h * 0.4, 191);
  // dark windows (power out)
  cv.rect(x + w * 0.05, y + h * 0.86, w * 0.9, h * 0.14, '#1b1b1b');
}
function sceneFlood(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#5a7a8a');
  cv.rect(x, y, w, h * 0.4, '#8aa8b8');
  // rooftops poking out
  cv.poly([[x + w * 0.08, y + h * 0.55], [x + w * 0.2, y + h * 0.4], [x + w * 0.32, y + h * 0.55]], '#4a3a2a');
  cv.poly([[x + w * 0.55, y + h * 0.55], [x + w * 0.68, y + h * 0.38], [x + w * 0.82, y + h * 0.55]], '#3a2a1a');
  cv.rect(x + w * 0.6, y + h * 0.3, w * 0.04, h * 0.12, '#2a2a2a');
  // water
  cv.rect(x, y + h * 0.55, w, h * 0.45, '#2a6a8a');
  waves(cv, x + 4, y + h * 0.62, w - 8, h * 0.3, '#a8c8d8', 211);
  // submerged street sign + car roof
  cv.line(x + w * 0.85, y + h * 0.55, x + w * 0.85, y + h * 0.68, '#3a3a3a', 2);
  cv.rect(x + w * 0.8, y + h * 0.5, w * 0.1, h * 0.06, '#b3261e');
  cv.rect(x + w * 0.15, y + h * 0.72, w * 0.3, h * 0.08, '#1b1b1b');
  // gauge: 18.8 ft
  cv.rect(x + w * 0.05, y + h * 0.05, w * 0.2, h * 0.12, '#f6f1e7');
  cv.rect(x + w * 0.05, y + h * 0.05, w * 0.2, 2, RED);
}
function sceneChip(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#2a3a4a');
  // phone
  cv.rect(x + w * 0.32, y + h * 0.12, w * 0.36, h * 0.76, '#1b1b1b');
  cv.rect(x + w * 0.36, y + h * 0.18, w * 0.28, h * 0.6, '#3f7d9e');
  // signal bars crossed
  for (let i = 0; i < 4; i++) cv.rect(x + w * (0.4 + i * 0.06), y + h * (0.55 - i * 0.07), w * 0.04, h * (0.12 + i * 0.07), '#f7c948');
  cv.line(x + w * 0.36, y + h * 0.2, x + w * 0.64, y + h * 0.72, RED, 3);
  cv.line(x + w * 0.64, y + h * 0.2, x + w * 0.36, y + h * 0.72, RED, 3);
  // tower
  cv.poly([[x + w * 0.08, y + h * 0.85], [x + w * 0.12, y + h * 0.4], [x + w * 0.16, y + h * 0.85]], '#8a8a8a');
  cv.line(x + w * 0.06, y + h * 0.45, x + w * 0.18, y + h * 0.45, '#8a8a8a', 1.5);
  cv.circle(x + w * 0.12, y + h * 0.36, 3, '#f7c948');
  cv.circle(x + w * 0.88, y + h * 0.3, 8, '#c08a2d');
  cv.circle(x + w * 0.88, y + h * 0.3, 4, '#f7c948');
}
function sceneRobot(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#4a4a5a');
  cv.rect(x, y, w, h * 0.3, '#8a8a9a');
  // UN-style hall: columns
  for (let i = 0; i < 4; i++) cv.rect(x + w * (0.06 + i * 0.24), y + h * 0.3, w * 0.06, h * 0.55, '#c8b898');
  // robot
  const rx = x + w * 0.38, ry = y + h * 0.35;
  cv.rect(rx, ry, w * 0.24, h * 0.3, '#7a8a9a');
  cv.rect(rx + w * 0.05, ry - h * 0.14, w * 0.14, h * 0.14, '#8a9aaa');
  cv.circle(rx + w * 0.09, ry - h * 0.07, 2.5, '#f7c948');
  cv.circle(rx + w * 0.15, ry - h * 0.07, 2.5, '#f7c948');
  cv.line(rx - w * 0.04, ry + h * 0.05, rx - w * 0.1, ry + h * 0.25, '#7a8a9a', 3);
  cv.line(rx + w * 0.28, ry + h * 0.05, rx + w * 0.34, ry + h * 0.25, '#7a8a9a', 3);
  cv.line(rx + w * 0.06, ry + h * 0.3, rx + w * 0.02, ry + h * 0.5, '#7a8a9a', 3);
  cv.line(rx + w * 0.18, ry + h * 0.3, rx + w * 0.22, ry + h * 0.5, '#7a8a9a', 3);
  // red X over robot
  cv.line(rx - w * 0.06, ry - h * 0.16, rx + w * 0.3, ry + h * 0.52, RED, 3);
  cv.line(rx + w * 0.3, ry - h * 0.16, rx - w * 0.06, ry + h * 0.52, RED, 3);
  // gavel
  cv.rect(x + w * 0.8, y + h * 0.7, w * 0.12, h * 0.05, '#6b4a2a');
  cv.line(x + w * 0.82, y + h * 0.55, x + w * 0.88, y + h * 0.7, '#6b4a2a', 2);
}
function sceneMarket(cv, x, y, w, h) {
  cv.rect(x, y, w, h, '#f0e8d8');
  // grid
  for (let i = 1; i < 4; i++) cv.line(x, y + h * i / 4, x + w, y + h * i / 4, '#d8cdb8', 1);
  for (let i = 1; i < 4; i++) cv.line(x + w * i / 4, y, x + w * i / 4, y + h, '#d8cdb8', 1);
  // falling line chart
  const pts = [[0.05, 0.2], [0.2, 0.28], [0.35, 0.24], [0.5, 0.45], [0.62, 0.42], [0.75, 0.62], [0.88, 0.72], [0.97, 0.85]];
  for (let i = 0; i + 1 < pts.length; i++) {
    cv.line(x + w * pts[i][0], y + h * pts[i][1], x + w * pts[i + 1][0], y + h * pts[i + 1][1], RED, 2.5);
    cv.circle(x + w * pts[i][0], y + h * pts[i][1], 2.5, RED);
  }
  cv.circle(x + w * pts[7][0], y + h * pts[7][1], 3.5, RED);
  // down arrow
  cv.poly([[x + w * 0.82, y + h * 0.1], [x + w * 0.9, y + h * 0.1], [x + w * 0.86, y + h * 0.22]], RED);
  cv.rect(x + w * 0.845, y + h * 0.02, w * 0.03, h * 0.09, RED);
  // candlesticks
  const r = rng(221);
  for (let i = 0; i < 5; i++) {
    const cx = x + w * (0.08 + i * 0.16);
    const top = y + h * (0.3 + r() * 0.2), bot = top + h * 0.15;
    cv.rect(cx - 1, y + h * 0.25, 2, h * 0.3, '#8a8a8a');
    cv.rect(cx - 5, top, 10, bot - top, i % 2 ? '#3f6b3a' : RED);
  }
}

// ---------- world map ----------
const CONTINENTS = [
  // North America
  [[-168, 66], [-150, 70], [-130, 71], [-110, 73], [-90, 74], [-75, 72], [-60, 62], [-55, 52], [-60, 47], [-70, 43], [-75, 36], [-81, 26], [-84, 30], [-90, 21], [-97, 16], [-95, 16], [-92, 15], [-87, 13], [-83, 9], [-80, 8], [-79, 9], [-82, 15], [-87, 21], [-90, 21], [-97, 26], [-105, 23], [-110, 25], [-114, 30], [-120, 34], [-124, 40], [-124, 48], [-130, 55], [-140, 60], [-152, 58], [-165, 60]],
  // South America
  [[-78, 8], [-77, 4], [-80, -3], [-81, -6], [-77, -12], [-72, -18], [-70, -23], [-70, -30], [-72, -37], [-73, -44], [-74, -50], [-68, -55], [-65, -55], [-62, -50], [-57, -38], [-52, -32], [-48, -27], [-40, -20], [-35, -9], [-35, -6], [-41, -3], [-44, -2], [-50, 0], [-53, 4], [-58, 6], [-62, 9], [-68, 11], [-72, 12], [-76, 10]],
  // Europe
  [[-10, 36], [-9, 43], [-2, 44], [-1, 46], [-4, 48], [-1, 49], [2, 51], [4, 53], [8, 55], [8, 57], [10, 59], [12, 58], [18, 56], [21, 55], [24, 58], [21, 60], [23, 65], [25, 70], [30, 70], [31, 68], [35, 66], [40, 64], [44, 62], [48, 60], [50, 58], [48, 55], [44, 52], [40, 50], [35, 48], [30, 46], [28, 44], [26, 42], [24, 40], [22, 38], [20, 38], [18, 40], [16, 42], [14, 44], [12, 44], [10, 42], [8, 40], [6, 38], [3, 38], [0, 36], [-2, 37], [-6, 36], [-9, 37]],
  // Africa
  [[-17, 15], [-16, 20], [-15, 25], [-10, 30], [-6, 34], [-2, 35], [3, 37], [10, 37], [15, 34], [20, 32], [25, 32], [30, 31], [32, 30], [34, 28], [36, 24], [38, 20], [40, 16], [43, 12], [46, 11], [51, 12], [51, 10], [48, 5], [44, 0], [42, -5], [40, -10], [38, -15], [36, -20], [35, -25], [33, -28], [30, -32], [27, -34], [22, -35], [18, -34], [16, -30], [14, -25], [12, -20], [12, -15], [13, -10], [12, -5], [9, 0], [9, 4], [6, 4], [2, 6], [-3, 5], [-8, 4], [-12, 8], [-16, 12]],
  // Asia
  [[30, 36], [35, 36], [36, 33], [40, 32], [44, 30], [48, 30], [50, 29], [54, 27], [57, 26], [60, 25], [62, 25], [66, 25], [70, 24], [72, 20], [75, 15], [77, 10], [80, 7], [80, 10], [84, 18], [88, 22], [92, 21], [94, 17], [96, 15], [98, 10], [100, 8], [102, 10], [104, 9], [105, 10], [107, 11], [109, 13], [110, 20], [112, 22], [114, 22], [116, 23], [118, 25], [120, 28], [121, 31], [122, 32], [124, 34], [126, 38], [128, 38], [130, 42], [132, 43], [135, 44], [138, 46], [140, 48], [142, 50], [144, 52], [146, 55], [148, 58], [150, 60], [155, 60], [158, 56], [160, 55], [162, 58], [165, 60], [170, 62], [178, 65], [178, 68], [172, 70], [165, 70], [158, 72], [150, 72], [142, 73], [135, 74], [128, 74], [120, 73], [112, 74], [105, 76], [98, 76], [90, 75], [82, 74], [75, 73], [68, 72], [60, 70], [52, 68], [45, 67], [40, 66], [35, 66], [32, 68], [30, 70], [30, 66], [28, 62], [28, 58], [28, 54], [28, 50], [28, 46], [28, 42], [28, 38], [30, 36]],
  // Australia
  [[114, -22], [114, -30], [115, -34], [118, -35], [124, -33], [129, -32], [132, -32], [136, -35], [140, -38], [145, -38], [150, -37], [153, -32], [153, -27], [150, -23], [146, -19], [142, -15], [142, -11], [137, -12], [135, -15], [132, -12], [130, -13], [126, -14], [122, -17], [118, -20]],
];
function drawMap(cv, x, y, w, h, dots, fontSans, latMin, latMax) {
  const lo = latMin === undefined ? -90 : latMin, hi = latMax === undefined ? 90 : latMax;
  const px = lon => x + (lon + 180) / 360 * w;
  const py = lat => y + (hi - lat) / (hi - lo) * h;
  cv.rect(x, y, w, h, SEA);
  // graticule
  for (let lon = -150; lon <= 150; lon += 30) {
    const gx = px(lon);
    cv.line(gx, y, gx, y + h, '#b8c8cc', 0.75);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const gy = py(lat);
    cv.line(x, gy, x + w, gy, '#b8c8cc', 0.75);
  }
  // continents
  for (const cont of CONTINENTS) {
    const pts = cont.map(([lon, lat]) => [px(lon), py(lat)]);
    cv.poly(pts, LAND);
    // outline
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      cv.line(p[0], p[1], q[0], q[1], LANDLINE, 1);
    }
  }
  // dots (numbered, big)
  for (const d of dots) {
    const dx = px(d.lon), dy = py(d.lat);
    cv.circle(dx, dy, 11, RED);
    cv.ring(dx, dy, 11, '#ffffff', 1.5);
    drawText(cv, fontSans, String(d.n), dx, dy + 3.5, 11, '#ffffff', { align: 'center' });
  }
}

// ---------- layout ----------
const MX = 28, RX = W - MX; // margins
function buildPage() {
  const serifB = loadFont('LiberationSerif-Bold.ttf');
  const serifI = loadFont('LiberationSerif-Italic.ttf');
  const sansR = loadFont('LiberationSans-Regular.ttf');
  const sansB = loadFont('LiberationSans-Bold.ttf');
  const cv = new Canvas(W, H, PAPER);
  const r = rng(20261122);

  // paper grain: faint speckles + a few fibre lines
  for (let i = 0; i < 900; i++) {
    const x = r() * W, y = r() * H;
    cv.blend(x, y, r() < 0.5 ? '#e8dfc8' : '#fffaf0', 0.18);
  }
  for (let i = 0; i < 14; i++) {
    const y = r() * H, x = r() * W, len = 20 + r() * 60;
    cv.line(x, y, x + len, y + (r() - 0.5) * 2, '#ece3cb', 0.5);
  }

  // ---- masthead ----
  hline(cv, MX, 14, RX - MX, INK, 2);
  hline(cv, MX, 18, RX - MX, INK, 1);
  drawText(cv, serifB, 'THE WORLD TODAY', W / 2, 76, 64, INK, { align: 'center', tracking: 0.5 });
  drawText(cv, sansB, 'SUNDAY, 22 NOVEMBER 2026', MX, 94, 12, INK, { tracking: 1.5 });
  drawText(cv, sansB, 'No. 326', W / 2, 94, 12, INK, { align: 'center', tracking: 1.5 });
  drawText(cv, sansB, '35 STORIES · 7 REGIONS', RX, 94, 12, INK, { align: 'right', tracking: 1.5 });
  cv.rect(MX, 100, RX - MX, 3, RED);

  // ---- stat strip: 6 numbers ----
  const stats = [
    ['2', 'TANKERS HIT\nIN HORMUZ'],
    ['36', 'MISSING IN\nFACTORY FIRE'],
    ['3', 'MISSILES DOWN\nOVER RIYADH'],
    ['24', 'DEAD IN\nNIGERIA BOAT'],
    ['18.8 FT', 'ST. JOHNS RIVER\nRECORD HIGH'],
    ['35%', 'COP31 CLEAN-POWER\nGOAL FOR 2035'],
  ];
  const sw = (RX - MX) / 6;
  for (let i = 0; i < 6; i++) {
    const bx = MX + i * sw;
    if (i > 0) vline(cv, bx, 108, 56, '#c8bda0', 1);
    drawText(cv, serifB, stats[i][0], bx + sw / 2, 132, 24, RED, { align: 'center' });
    const lab = stats[i][1].split('\n');
    drawText(cv, sansB, lab[0], bx + sw / 2, 148, 9, INK, { align: 'center', tracking: 0.8 });
    drawText(cv, sansB, lab[1], bx + sw / 2, 159, 9, INK, { align: 'center', tracking: 0.8 });
  }
  hline(cv, MX, 168, RX - MX, INK, 1);

  // ---- HERO 1: Iran strikes Bahrain (lead) ----
  const hy = 176, hh = 152;
  labelChip(cv, MX, hy + 6, 'MIDDLE EAST · WAR SPREADS', sansB, RED, '#ffffff', 11);
  drawText(cv, serifB, 'IRAN STRIKES BAHRAIN', MX, hy + 62, 44, INK, { tracking: 0.3 });
  const deck1 = wrapText(serifI, 'Tehran hits a US base and an industrial site as two tankers burn in the Strait of Hormuz — the Gulf war’s widest night yet.', 16, 520, 1, 0);
  deck1.forEach((ln, i) => drawText(cv, serifI, ln, MX, hy + 86 + i * 20, 16, '#333333'));
  drawText(cv, sansB, 'BAHRAIN · HORMUZ · SUNDAY', MX, hy + 148, 10, GREY, { tracking: 1.2 });
  sceneHormuz(cv, 560, hy, RX - 560, hh);
  cv.rect(560, hy, RX - 560, 2, INK);
  cv.rect(560, hy + hh - 2, RX - 560, 2, INK);
  hline(cv, MX, 336, RX - MX, INK, 1);

  // ---- HERO 2 & 3: image left, text right ----
  function hero2(x, w, img, kicker, headline, deck, credit) {
    const y0 = 344, y1 = 468;
    img(cv, x, y0, 172, y1 - y0);
    cv.rect(x, y0, 172, 2, INK);
    cv.rect(x, y1 - 2, 172, 2, INK);
    const tx = x + 184;
    labelChip(cv, tx, y0 + 4, kicker, sansB, INK, '#ffffff', 9);
    const hl = wrapText(serifB, headline, 20, w - 184 - 8, 1, 0).slice(0, 3);
    hl.forEach((ln, i) => drawText(cv, serifB, ln, tx, y0 + 46 + i * 24, 20, INK));
    const deckY = y0 + 46 + hl.length * 24 + 4;
    const dk = wrapText(serifI, deck, 13, w - 184 - 8, 1, 0);
    const maxDeck = Math.max(0, Math.floor((y1 - 10 - deckY) / 16));
    dk.slice(0, maxDeck).forEach((ln, i) => drawText(cv, serifI, ln, tx, deckY + i * 16, 13, '#333333'));
    drawText(cv, sansB, credit, tx, y1 - 4, 9, GREY, { tracking: 1 });
  }
  hero2(MX, 477, sceneCOP, 'CLIMATE · COP31 ANTALYA', 'NO FOSSIL FUELS IN FINAL DRAFT',
    'The summit’s dawn draft drops the words entirely and bets on clean power.', 'ANTALYA · SUNDAY');
  hero2(519, 477, sceneFactory, 'ASIA · DISASTER', '36 MISSING AFTER FACTORY FIRE',
    'A candy plant burns in Cikande, Banten; three confirmed dead.', 'BANTEN · SUNDAY');
  hline(cv, MX, 476, RX - MX, INK, 1);

  return { cv, serifB, serifI, sansR, sansB };
}

// ---------- medium grid + map + more stories + footer ----------
function buildRest(p) {
  const { cv, serifB, serifI, sansR, sansB } = p;
  // ---- medium grid: 10 stories, 2 rows x 5 cols ----
  const mediums = [
    ['SAUDI ARABIA', 'Riyadh downs 3 Houthi missiles', 'Saudi defences stop the salvo.', sceneMissile],
    ['BALTIC SEA', 'Drone fire hits Sparta II', 'Sixteen crew evacuated.', sceneShip],
    ['POLAND', 'Russian missiles crash in Poland', 'NATO invokes Article 4.', scenePoland],
    ['NIGERIA', 'Boat toll rises to 24', 'Boat capsizes in Bayelsa.', sceneBoat],
    ['MEXICO', '“Chapo Isidro” captured; 11 dead', 'A Sinaloa raid ends the manhunt.', sceneRaid],
    ['IRAQ', 'Power plant fire kills 4, hurts 35', 'Hartha blaze knocks out 800 MW.', scenePlant],
    ['FLORIDA', 'River hits record 18.8 ft', 'St. Johns tops its 1953 mark.', sceneFlood],
    ['CHINA', 'Beijing slams US telecom ban', 'China vows to defend its firms.', sceneChip],
    ['GENEVA', 'No deal to ban “killer robots”', 'UN talks end with no treaty.', sceneRobot],
    ['MARKETS', 'S&P’s worst week since April', 'A December Fed hike is near-certain.', sceneMarket],
  ];
  const cw = 187, cg = 8, rh = 90;
  for (let i = 0; i < 10; i++) {
    const col = i % 5, row = Math.floor(i / 5);
    const x = MX + col * (cw + cg), y = 484 + row * (rh + 8);
    const m = mediums[i];
    m[3](cv, x, y, cw, 36);
    cv.rect(x, y + 36, cw, 1, INK);
    drawText(cv, sansB, m[0], x, y + 48, 9, RED, { tracking: 1 });
    const hl = wrapText(serifB, m[1], 12, cw, 1, 0);
    hl.slice(0, 2).forEach((ln, k) => drawText(cv, serifB, ln, x, y + 63 + k * 14, 12, INK));
    drawText(cv, sansR, m[2], x, y + 88, 9.5, '#444444');
  }
  hline(cv, MX, 672, RX - MX, INK, 1);

  // ---- map (left) ----
  drawText(cv, sansB, 'THE WORLD IN ONE DAY', MX, 694, 13, INK, { tracking: 1 });
  drawText(cv, sansB, '22 NOV 2026 · 35 STORIES, 7 REGIONS', 600, 694, 10, GREY, { align: 'right', tracking: 0.8 });
  const dots = [
    { n: 1, lon: 50.5, lat: 26.2 }, { n: 2, lon: 30.7, lat: 36.9 }, { n: 3, lon: 106.3, lat: -6.4 },
    { n: 4, lon: 46.7, lat: 24.6 }, { n: 5, lon: 25, lat: 60 }, { n: 6, lon: 19, lat: 52 },
    { n: 7, lon: 6.3, lat: 4.9 }, { n: 8, lon: -107, lat: 25 }, { n: 9, lon: 47.8, lat: 30.5 },
    { n: 10, lon: -81.5, lat: 28.5 }, { n: 11, lon: -75.2, lat: -11.2 }, { n: 12, lon: 6.1, lat: 46.2 },
    { n: 13, lon: 116.4, lat: 39.9 }, { n: 14, lon: 34.5, lat: 31.5 },
  ];
  drawMap(cv, MX, 702, 572, 222, dots, sansB, -58, 82);
  cv.rect(MX, 702, 572, 2, INK);
  cv.rect(MX, 924, 572, 2, INK);
  drawText(cv, sansR, 'Every numbered dot is a story on this page — 1 Bahrain, 2 Antalya, 3 Banten, 4 Riyadh,', MX, 940, 10, '#444444');
  drawText(cv, sansR, '5 Gulf of Finland, 6 Poland, 7 Bayelsa, 8 Sinaloa, 9 Basra, 10 Florida, 11 Junín, 12 Geneva, 13 Beijing, 14 Gaza.', MX, 954, 10, '#444444');

  // ---- 22 MORE STORIES (right column) ----
  drawText(cv, sansB, '22 MORE STORIES', 616, 694, 13, INK, { tracking: 1 });
  cv.rect(616, 700, 380, 2, RED);
  const more = [
    ['SOMALIA', 'UAE envoy given 72 hours to leave Mogadishu.'],
    ['MYANMAR', 'ICJ rules on Rohingya genocide case.'],
    ['CHINA', 'Trump, Xi and Putin meet in Shenzhen.'],
    ['NEPAL', 'PM Balendra Shah visits India.'],
    ['SPAIN', 'Bank levy extended to 2027; €1.4bn a year.'],
    ['INDIA', 'Toxic alcohol kills 11 in Manipur.'],
    ['GAZA', 'Four Palestinians killed in overnight strikes.'],
    ['GERMANY', 'IG Metall strikes Monday; 23,000 out.'],
    ['AUSTRALIA', 'Canberra hits back at AUKUS report.'],
    ['SOFTBANK', 'Son’s $1tn SK Hynix talks collapse.'],
    ['NATO', 'Russia revives demand to roll back to 1997.'],
    ['FLORIDA', 'Lake Harney crests at 13.0 ft Sunday.'],
    ['PERU', 'M6.7 quake rattles Junín; no major damage.'],
    ['HOUTHIS', 'Riyadh intercepts came a day after Hodeidah.'],
    ['COP31', 'Panama threatens veto over quorum rules.'],
    ['RUSSIA', 'Two Kh-101 missiles fell in Poland on Friday.'],
    ['NIGERIA', 'Boat was carrying mourners; toll now 24.'],
    ['MEXICO', 'Seven gunmen and four soldiers dead in raid.'],
    ['IRAQ', 'Fire at Hartha plant cuts power to Basra.'],
    ['UN', 'Killer-robot rules due by 2028, if agreed.'],
    ['FED', 'Rate hike in December now almost certain.'],
    ['OIL', 'Brent holds near $93 as Gulf tensions rise.'],
  ];
  for (let i = 0; i < more.length; i++) {
    const y = 714 + i * 11.5;
    cv.rect(616, y - 6.5, 5, 5, RED);
    drawText(cv, sansB, more[i][0] + ' — ', 626, y, 10, INK, { tracking: 0.3 });
    const w0 = textWidth(sansB, more[i][0] + ' — ', 10, 1, 0.3);
    drawText(cv, sansR, more[i][1], 626 + w0, y, 10, '#333333');
  }

  // ---- footer: DATE CHECK ----
  cv.rect(MX, 978, RX - MX, 32, '#efe8d6');
  cv.rect(MX, 978, RX - MX, 1, INK);
  cv.rect(MX, 1009, RX - MX, 1, INK);
  drawText(cv, sansB, 'DATE CHECK', MX + 10, 999, 11, RED, { tracking: 1 });
  drawText(cv, sansR, 'Every story on this page was verified from primary sources for Sunday 22 November 2026.', MX + 108, 999, 10.5, INK);
  drawText(cv, serifB, 'THE WORLD TODAY', RX - 10, 999, 12, INK, { align: 'right' });
}

// ---------- main ----------
function main() {
  const p = buildPage();
  buildRest(p);
  const png = encodePNG(p.cv.buf, W, H);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, png);
  console.log('wrote', OUT, png.length, 'bytes');
}
main();
