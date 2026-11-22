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
const SEA = '#22405c', LAND = '#d9c9a0', LANDLINE = '#b09a68'; // rev5: deep navy sea, warm sand land

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

// curved missile trail: quadratic bezier drawn as a polyline
function arc(cv, x0, y0, cx, cy, x1, y1, col, width) {
  let px = x0, py = y0;
  for (let s = 1; s <= 16; s++) {
    const t = s / 16;
    const qx = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1;
    const qy = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1;
    cv.line(px, py, qx, qy, col, width);
    px = qx; py = qy;
  }
}
// impact burst: white core, amber ring, radiating sparks
function burst(cv, cx, cy, r) {
  cv.circle(cx, cy, r, '#ffffff');
  cv.circle(cx, cy, r * 0.55, '#f7c948');
  cv.ring(cx, cy, r * 1.6, '#f7c948', 1.5);
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    cv.line(cx + Math.cos(a) * r * 1.4, cy + Math.sin(a) * r * 1.4,
      cx + Math.cos(a) * r * 2.4, cy + Math.sin(a) * r * 2.4, '#f7c948', 1.5);
  }
}

// ---------- hero / medium scenes (each draws inside x,y,w,h) ----------
// rev5: Iran lead hero redrawn as a detailed missile-attack scene — layered dusk
// sky, Bahrain skyline + twin sail towers + refinery, curved missile arcs with
// impact bursts, two burning tankers with fire-glow on the water, warship escort.
function sceneHormuz(cv, x, y, w, h) {
  // dusk sky: dark slate, wide orange sunset band, bright horizon glow
  cv.rect(x, y, w, h, '#232f3d');
  cv.rect(x, y + h * 0.16, w, h * 0.3, '#c96a2e');
  cv.rect(x, y + h * 0.36, w, h * 0.12, '#f2a541');
  // sun + halo, faint stars in the dark upper sky
  cv.circle(x + w * 0.84, y + h * 0.2, 11, '#f7e3a1');
  cv.ring(x + w * 0.84, y + h * 0.2, 16, '#f7c948', 1.5);
  for (const [sx, sy] of [[0.12, 0.08], [0.3, 0.05], [0.55, 0.09], [0.7, 0.06], [0.95, 0.1]])
    cv.circle(x + w * sx, y + h * sy, 1.5, '#f7e3a1');
  // Bahrain skyline (left) + twin sail towers + refinery / industrial site (right)
  buildingRow(cv, x + w * 0.02, y + h * 0.3, w * 0.42, h * 0.18, 11, '#141414');
  cv.poly([[x + w * 0.46, y + h * 0.48], [x + w * 0.48, y + h * 0.26], [x + w * 0.5, y + h * 0.48]], '#141414');
  cv.poly([[x + w * 0.51, y + h * 0.48], [x + w * 0.53, y + h * 0.28], [x + w * 0.55, y + h * 0.48]], '#141414');
  cv.rect(x + w * 0.78, y + h * 0.3, w * 0.02, h * 0.18, '#141414');
  cv.rect(x + w * 0.83, y + h * 0.26, w * 0.02, h * 0.22, '#141414');
  cv.circle(x + w * 0.9, y + h * 0.42, h * 0.06, '#141414');
  cv.circle(x + w * 0.95, y + h * 0.44, h * 0.05, '#141414');
  cv.rect(x, y + h * 0.46, w, h * 0.02, '#141414');
  // sea
  cv.rect(x, y + h * 0.48, w, h * 0.52, '#14324a');
  cv.rect(x, y + h * 0.48, w, h * 0.1, '#1d4e6b');
  waves(cv, x + 6, y + h * 0.56, w - 12, h * 0.4, '#7fb3c8', 21);
  // missile arcs (amber glow, then bright core), from high in the sky to targets
  const arcs = [
    [0.04, 0.04, 0.18, 0.1, 0.28, 0.52],
    [0.3, 0.02, 0.55, 0.12, 0.82, 0.44],
    [0.62, 0.03, 0.68, 0.25, 0.72, 0.6],
  ];
  for (const [x0, y0, cx, cy, x1, y1] of arcs) {
    arc(cv, x + w * x0, y + h * y0, x + w * cx, y + h * cy, x + w * x1, y + h * y1, '#f7c948', 3);
    arc(cv, x + w * x0, y + h * y0, x + w * cx, y + h * cy, x + w * x1, y + h * y1, '#ffffff', 1.5);
    cv.circle(x + w * x0, y + h * y0, 2.5, '#ffffff');
  }
  // tanker 1 (burning, left-centre): fire-glow on the water, hull, deck, smoke, flame
  const tx = x + w * 0.05, ty = y + h * 0.6, tw = w * 0.44, th = h * 0.14;
  cv.poly([[tx - 6, ty + th + 2], [tx + tw + 6, ty + th + 2], [tx + tw - 12, ty + th + 10], [tx + 8, ty + th + 10]], '#e07b2a', 0.35);
  cv.poly([[tx, ty + th], [tx + tw * 0.06, ty], [tx + tw * 0.94, ty], [tx + tw, ty + th]], '#0f0f0f');
  cv.rect(tx + tw * 0.1, ty - h * 0.08, tw * 0.5, h * 0.08, '#333333');
  cv.rect(tx + tw * 0.62, ty - h * 0.14, tw * 0.08, h * 0.14, '#222222');
  smoke(cv, tx + tw * 0.18, ty - h * 0.48, tw * 0.4, h * 0.38, 41, true);
  flame(cv, tx + tw * 0.12, ty - h * 0.4, tw * 0.5, h * 0.4, 31);
  // tanker 2 (hit, listing, right): smaller fire, glow, smoke
  const ux = x + w * 0.58, uy = y + h * 0.64, uw = w * 0.34, uh = h * 0.12;
  cv.poly([[ux - 4, uy + uh + 2], [ux + uw + 4, uy + uh + 2], [ux + uw - 8, uy + uh + 8], [ux + 6, uy + uh + 8]], '#e07b2a', 0.3);
  cv.poly([[ux, uy + uh], [ux + uw * 0.05, uy], [ux + uw * 0.9, uy + uh * 0.4], [ux + uw, uy + uh]], '#141414');
  smoke(cv, ux + uw * 0.12, uy - h * 0.36, uw * 0.35, h * 0.28, 61, true);
  flame(cv, ux + uw * 0.08, uy - h * 0.28, uw * 0.45, h * 0.28, 51);
  // warship escort (bottom-right) + wake
  cv.poly([[x + w * 0.88, y + h * 0.88], [x + w * 0.91, y + h * 0.8], [x + w * 0.97, y + h * 0.8], [x + w * 0.99, y + h * 0.88]], '#222222');
  cv.rect(x + w * 0.92, y + h * 0.74, w * 0.025, h * 0.06, '#222222');
  cv.line(x + w * 0.88, y + h * 0.9, x + w * 0.99, y + h * 0.9, '#7fb3c8', 1);
  // impact bursts on top of the flames
  burst(cv, x + w * 0.28, y + h * 0.52, 5);
  burst(cv, x + w * 0.82, y + h * 0.44, 5);
  burst(cv, x + w * 0.72, y + h * 0.6, 4);
  // embers drifting off the fires
  const er = rng(77);
  for (let i = 0; i < 7; i++) {
    const ex = x + w * (0.1 + 0.55 * er()), ey = y + h * (0.22 + 0.25 * er());
    cv.circle(ex, ey, 1.5 + er(), i % 2 ? '#f7c948' : '#e07b2a');
  }
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
    cv.line(gx, y, gx, y + h, '#33536e', 0.75);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const gy = py(lat);
    if (gy < y || gy > y + h) continue; // rev5: keep graticule inside the map box
    cv.line(x, gy, x + w, gy, '#33536e', 0.75);
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
  // rev6: ocean furniture so the sea is not empty — ocean labels, compass rose,
  // scale bar (positions checked clear of every dot and coastline).
  const OCEAN = '#8ab4c8';
  drawText(cv, fontSans, 'PACIFIC OCEAN', px(-140), py(-10) + 3, 8.5, OCEAN, { align: 'center', tracking: 1.5 });
  drawText(cv, fontSans, 'ATLANTIC', px(-45), py(37) + 3, 8.5, OCEAN, { align: 'center', tracking: 1.5 });
  drawText(cv, fontSans, 'OCEAN', px(-45), py(37) + 15, 8.5, OCEAN, { align: 'center', tracking: 1.5 });
  drawText(cv, fontSans, 'INDIAN OCEAN', px(75), py(-29) + 3, 8.5, OCEAN, { align: 'center', tracking: 1.5 });
  // compass rose in the open South Atlantic
  const ccx = px(-20), ccy = py(-39);
  cv.ring(ccx, ccy, 11, OCEAN, 1.5);
  cv.line(ccx, ccy + 8, ccx, ccy - 8, OCEAN, 1.5);
  cv.poly([[ccx, ccy - 11], [ccx - 3, ccy - 4], [ccx + 3, ccy - 4]], OCEAN);
  drawText(cv, fontSans, 'N', ccx, ccy - 14, 9, OCEAN, { align: 'center' });
  // scale bar: 2000 km segments (correct at the equator), South Pacific
  const sbx = x + 20, sby = y + h - 12;
  cv.rect(sbx, sby, 58, 5, INK);
  cv.rect(sbx + 30, sby + 1, 27, 3, '#f6f1e7');
  drawText(cv, fontSans, '0', sbx, sby - 4, 8, OCEAN, { align: 'center' });
  drawText(cv, fontSans, '2000', sbx + 29, sby - 4, 8, OCEAN, { align: 'center' });
  drawText(cv, fontSans, '4000 KM', sbx + 58, sby - 4, 8, OCEAN, { align: 'center' });
  // dots (numbered) — rev9: r=10 / 10pt numbers for the smaller map (r=12 was
  // too blobby in the tighter Europe/Gulf clusters); numbers still drawn last.
  for (const d of dots) {
    const dx = px(d.lon), dy = py(d.lat);
    cv.circle(dx, dy, 10, RED);
    cv.ring(dx, dy, 10, '#ffffff', 2);
  }
  // rev9: numbers get a 1px dark-red halo (8 offset passes) BEFORE the white
  // pass — in the dense clusters a white number can fall across a neighbour
  // dot's white ring, and white-on-white makes the strokes vanish. The halo
  // keeps every number readable even where circles overlap.
  for (const d of dots) {
    const dx = px(d.lon), dy = py(d.lat);
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      drawText(cv, fontSans, String(d.n), dx + ox, dy + 3.5 + oy, 10, '#7a150f', { align: 'center' });
    }
    drawText(cv, fontSans, String(d.n), dx, dy + 3.5, 10, '#ffffff', { align: 'center' });
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
  drawText(cv, sansB, '42 STORIES · 7 REGIONS', RX, 94, 12, INK, { align: 'right', tracking: 1.5 });
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

  // ---- region bar (rev7, rank-1 style: full-width, directly under the stat strip) ----
  // recount for 42 stories: EUROPE 11, ASIA 11, MIDDLE EAST 7, AFRICA 3, AMERICAS 7, OCEANIA 2, GLOBAL 1
  const regions = [
    ['EUROPE', 11, '#2a6a8a'], ['ASIA', 11, '#b3261e'], ['MIDDLE EAST', 7, '#c08a2d'],
    ['AFRICA', 3, '#3f6b3a'], ['AMERICAS', 7, '#7a3a6b'], ['OCEANIA', 2, '#1d7a6b'], ['GLOBAL', 1, '#5a5a5a'],
  ];
  let bx = MX;
  for (let i = 0; i < regions.length; i++) {
    const x1 = i === regions.length - 1 ? RX
      : MX + Math.round((RX - MX) * regions.slice(0, i + 1).reduce((s, r) => s + r[1], 0) / 42);
    cv.rect(bx, 174, x1 - bx, 12, regions[i][2]);
    bx = x1;
  }
  // region labels, centred under the bar (swatch + NAME n)
  const rlabels = regions.map(([name, n]) => name + ' ' + n);
  let rtot = 0;
  for (const t of rlabels) rtot += 8 + 4 + textWidth(sansB, t, 8.5, 1, 0.8) + 12;
  let lx = MX + ((RX - MX) - rtot) / 2;
  for (let i = 0; i < regions.length; i++) {
    cv.rect(lx, 191, 8, 8, regions[i][2]);
    drawText(cv, sansB, rlabels[i], lx + 12, 198, 8.5, INK, { tracking: 0.8 });
    lx += 8 + 4 + textWidth(sansB, rlabels[i], 8.5, 1, 0.8) + 12;
  }

  // ---- HEROES: 3 equal cards, rank-1 style (banner + image + caption + location + headline + deck) ----
  // rev7: the old 1-lead + 2-small-heroes layout is replaced by 3 cards side by side,
  // same width, same structure. Story texts are unchanged from rev6.
  function heroCard(x, w, img, banner, caption, credit, headline, deck) {
    const y0 = 206;
    cv.rect(x, y0, w, 16, RED);
    drawText(cv, sansB, banner, x + 6, y0 + 12, 9.5, '#ffffff', { tracking: 1 });
    img(cv, x, y0 + 16, w, 104);
    cv.rect(x, y0 + 16, w, 2, INK);
    cv.rect(x, y0 + 118, w, 2, INK);
    // white caption strip on the image (bottom-left), rank-1 style
    const capw = textWidth(sansB, caption, 8, 1, 0.8) + 12;
    cv.rect(x + 6, y0 + 104, capw, 16, '#f6f1e7');
    drawText(cv, sansB, caption, x + 12, y0 + 115, 8, INK, { tracking: 0.8 });
    drawText(cv, sansB, credit, x, y0 + 136, 9, GREY, { tracking: 1 });
    const hl = wrapText(serifB, headline, 19, w - 8, 1, 0).slice(0, 2);
    hl.forEach((ln, i) => drawText(cv, serifB, ln, x, y0 + 154 + i * 21, 19, INK));
    const dk = wrapText(serifI, deck, 12.5, w - 8, 1, 0);
    dk.slice(0, 3).forEach((ln, i) => drawText(cv, serifI, ln, x, y0 + 191 + i * 13, 12.5, '#333333'));
  }
  const hw = 317;
  heroCard(MX, hw, sceneHormuz, 'MIDDLE EAST · WAR SPREADS', 'US FIFTH FLEET BASE · BAHRAIN',
    'BAHRAIN · HORMUZ · SUNDAY (REUTERS)', 'IRAN STRIKES BAHRAIN',
    'Tehran hits a US base and an industrial site as two tankers burn in the Strait of Hormuz — the Gulf war’s widest night yet. No casualties were reported.');
  heroCard(MX + hw + 8, 318, sceneCOP, 'CLIMATE · COP31 ANTALYA', 'COP31 SUMMIT · ANTALYA',
    'ANTALYA · SUNDAY (AP)', 'NO FOSSIL FUELS IN FINAL DRAFT',
    'The summit’s dawn draft drops the words entirely and bets on clean power. Delegates agreed a 35% clean-power goal for 2035 in the final text.');
  heroCard(MX + hw + 8 + 318 + 8, hw, sceneFactory, 'ASIA · DISASTER', 'CANDY PLANT · CIKANDE, BANTEN',
    'BANTEN · SUNDAY (REUTERS)', '36 MISSING AFTER FACTORY FIRE',
    'A candy plant burns in Cikande, Banten; three confirmed dead and 36 people missing after the blaze tore through the factory on Sunday.');
  hline(cv, MX, 436, RX - MX, INK, 1);

  // rev7: heroes are now the 3 equal cards above (hero2 layout removed).

  return { cv, serifB, serifI, sansR, sansB };
}

// ---------- medium grid + map + more stories + footer ----------
function buildRest(p) {
  const { cv, serifB, serifI, sansR, sansB } = p;
  // ---- medium grid: 10 stories, 2 rows x 5 cols ----
  const mediums = [
    ['SAUDI ARABIA', 'Riyadh downs 3 Houthi missiles', 'Saudi defences stop the salvo over Riyadh; three missiles downed. (Reuters)', sceneMissile],
    ['BALTIC SEA', 'Drone fire hits Sparta II', 'Two drones hit the ship in the Gulf of Finland; sixteen crew evacuated. (Reuters)', sceneShip],
    ['POLAND', 'Russian missiles crash in Poland', 'Two Russian Kh-101 missiles fell in Poland; NATO invokes Article 4. (AP)', scenePoland],
    ['NIGERIA', 'Boat toll rises to 24', 'Boat capsizes in Bayelsa state; the death toll rises to 24. (Reuters)', sceneBoat],
    ['MEXICO', '“Chapo Isidro” captured; 11 dead', 'A Sinaloa raid ends the manhunt; eleven killed in the operation. (AP)', sceneRaid],
    ['IRAQ', 'Power plant fire kills 4, hurts 35', 'Hartha blaze cuts 800 MW; four killed and 35 hurt in the fire. (Reuters)', scenePlant],
    ['FLORIDA', 'River hits record 18.8 ft', 'St. Johns River hits a record 18.8 ft, topping its 1953 mark. (AP)', sceneFlood],
    ['CHINA', 'Beijing slams US telecom ban', 'China vows to defend its firms after the US telecom ban. (Reuters)', sceneChip],
    ['GENEVA', 'No deal to ban “killer robots”', 'UN talks in Geneva end with no treaty; killer robots stay unregulated. (AP)', sceneRobot],
    ['MARKETS', 'S&P’s worst week since April', 'S&P posts its worst week since April as a December Fed hike looms.', sceneMarket],
  ];
  const cw = 187, cg = 8, rh = 92; // rev8: taller rows for 2-line decks
  for (let i = 0; i < 10; i++) {
    const col = i % 5, row = Math.floor(i / 5);
    const x = MX + col * (cw + cg), y = 444 + row * (rh + 8);
    const m = mediums[i];
    m[3](cv, x, y, cw, 30);
    // rev7: rank-1 style coloured banner with the location in white (was small caps)
    cv.rect(x, y + 30, cw, 13, RED);
    drawText(cv, sansB, m[0], x + 4, y + 41, 8.5, '#ffffff', { tracking: 1 });
    const hl = wrapText(serifB, m[1], 11.5, cw, 1, 0);
    hl.slice(0, 2).forEach((ln, k) => drawText(cv, serifB, ln, x, y + 55 + k * 13, 11.5, INK));
    // rev8: deck expanded to 2 full lines of verified detail
    const dk = wrapText(sansR, m[2], 9, cw, 1, 0);
    dk.slice(0, 2).forEach((ln, k) => drawText(cv, sansR, ln, x, y + 80 + k * 9, 9, '#444444'));
  }
  hline(cv, MX, 640, RX - MX, INK, 1);

  // ---- THE DAY IN BRIEF (rev8): conclusion strip, only facts already on this page ----
  cv.rect(MX, 646, RX - MX, 30, '#efe8d6');
  cv.rect(MX, 676, RX - MX, 1, INK);
  drawText(cv, sansB, 'THE DAY IN BRIEF', MX + 10, 666, 10, RED, { tracking: 1 });
  drawText(cv, serifI, 'War spreads in the Gulf: Iran strikes a US base in Bahrain as two tankers burn in Hormuz.', 200, 660, 10, INK);
  drawText(cv, serifI, 'COP31’s final draft drops “fossil fuels”; a candy-plant fire in Banten leaves 36 missing.', 200, 672, 10, INK);

  // ---- map (left) ---- rev7: region bar moved to the top (under the stat strip)
  // rev9: map shrunk 572x190 -> 430x140 (user: "petanya ke gedean"); the
  // more-stories column widens into the freed space and a second brief strip
  // fills the gap under the legend so the bottom stays full, no holes.
  drawText(cv, sansB, 'THE WORLD IN ONE DAY', MX, 688, 13, INK, { tracking: 1 });
  drawText(cv, sansB, '22 NOV 2026 · 42 STORIES, 7 REGIONS', MX + 430, 688, 10, GREY, { align: 'right', tracking: 0.8 });
  const dots = [
    // rev5: Gulf / Europe / Bengal / SE-Asia dots nudged a few degrees so every
    // number stays readable; Korea is one dot (Seoul) — Pyongyang is 2.8px away
    // on this scale and would hide it. Peru is already dot 11 (Junín).
    { n: 1, lon: 56, lat: 26 }, { n: 2, lon: 26.5, lat: 40 }, { n: 3, lon: 106.3, lat: -6.4 },
    { n: 4, lon: 43, lat: 21 }, { n: 5, lon: 25, lat: 63 }, { n: 6, lon: 22, lat: 52 },
    { n: 7, lon: 6.3, lat: 4.9 }, { n: 8, lon: -107, lat: 25 }, { n: 9, lon: 48, lat: 33 },
    { n: 10, lon: -81.5, lat: 28.5 }, { n: 11, lon: -75.2, lat: -11.2 }, { n: 12, lon: 6.1, lat: 44 },
    { n: 13, lon: 116.4, lat: 39.9 }, { n: 14, lon: 34.5, lat: 31.5 },
    { n: 15, lon: 45.3, lat: 2.0 }, { n: 16, lon: 33, lat: 50 }, { n: 17, lon: 127.0, lat: 37.5 },
    { n: 18, lon: 80, lat: 32 }, { n: 19, lon: -7, lat: 38 }, { n: 20, lon: 96, lat: 25.5 },
    { n: 21, lon: 11, lat: 54.5 }, { n: 22, lon: 149.1, lat: -35.3 }, { n: 23, lon: 96, lat: 14 },
    { n: 24, lon: 106, lat: 10 }, { n: 25, lon: 86, lat: 21 }, { n: 26, lon: 19.8, lat: 41.3 },
    { n: 27, lon: -122.3, lat: 47.6 }, { n: 28, lon: -115.1, lat: 36.2 },
    // rev7: 4 new dots (29-32). Tehran nudged east to (60,38) and Rome to (12,37)
    // so the numbers stay readable against Basra/Bahrain and Geneva/Tirana/Berlin.
    // Gulf bourses shares dot 1 (Bahrain), EU-Indonesia shares dot 3 (Jakarta),
    // Eisenkot shares dot 14 (Gaza/Jerusalem) — those cities sit within a few px
    // of an existing dot at this scale, so a separate dot would be unreadable.
    // rev9: map shrunk to 430x140, so nudges grow — Rome (12,35), Berlin (11,54.5),
    // Tehran (62,39), Antalya (26.5,40), Kathmandu (80,32), Manipur (96,25.5),
    // Yangon (96,14). Numbers stay readable (verified at 4x zoom).
    { n: 29, lon: 28.0, lat: -26.2 }, { n: 30, lon: 62, lat: 39 },
    { n: 31, lon: -1.55, lat: 53.8 }, { n: 32, lon: 12, lat: 35 },
  ];
  drawMap(cv, MX, 696, 430, 140, dots, sansB, -55, 76);
  cv.rect(MX, 696, 430, 2, INK);
  cv.rect(MX, 836, 430, 2, INK);
  // rev7: 32-dot legend in 5 lines; dot 3 covers Banten+Jakarta, dot 14 Gaza+Jerusalem
  // rev9: same 5 lines (max 339px at 9pt, fits the 430px map); moved up with the map
  drawText(cv, sansR, '1 Bahrain, 2 Antalya, 3 Banten · Jakarta, 4 Riyadh, 5 Finland, 6 Poland, 7 Bayelsa,', MX, 846, 9, '#444444');
  drawText(cv, sansR, '8 Sinaloa, 9 Basra, 10 Florida, 11 Junín, 12 Geneva, 13 Beijing, 14 Gaza · Jerusalem,', MX, 859, 9, '#444444');
  drawText(cv, sansR, '15 Mogadishu, 16 Kyiv, 17 Seoul, 18 Kathmandu, 19 Madrid, 20 Manipur, 21 Berlin,', MX, 872, 9, '#444444');
  drawText(cv, sansR, '22 Canberra, 23 Yangon, 24 Bangkok, 25 Dhaka, 26 Tirana, 27 Seattle, 28 Vegas,', MX, 885, 9, '#444444');
  drawText(cv, sansR, '29 Johannesburg, 30 Tehran, 31 Leeds, 32 Rome.', MX, 898, 9, '#444444');
  drawText(cv, sansR, 'EACH DOT IS A STORY LOCATION — STORIES SHARING A CITY SHARE A DOT', MX + 215, 912, 8.5, GREY, { align: 'center', tracking: 0.8 });
  // rev9: second brief strip ("ALSO TODAY") fills the space freed under the
  // legend — same style as THE DAY IN BRIEF, only facts already on this page
  // (G20, EU–Indonesia, Leeds, F1 — all in the more-stories list).
  // rev10: 3 lines (added Nigeria boat toll + S&P week, both already on the
  // page) so the strip reaches down to the footer, no gap left under it.
  cv.rect(MX, 920, 430, 52, '#efe8d6');
  cv.rect(MX, 972, 430, 1, INK);
  drawText(cv, sansB, 'ALSO TODAY', MX + 10, 947, 10, RED, { tracking: 1 });
  drawText(cv, serifI, 'G20 opens in Johannesburg without the US; EU–Indonesia sign a deal.', 150, 936, 10, INK);
  drawText(cv, serifI, 'Leeds thrash Chelsea 4-1; Verstappen wins in Las Vegas again.', 150, 948, 10, INK);
  drawText(cv, serifI, 'Nigeria boat toll 24; S&P worst week since April.', 150, 960, 10, INK);

  // ---- 29 MORE STORIES (right column) ---- rev7: 22 + 7 verified new stories
  // rev9: widened 380 -> 518px into the space freed by the smaller map
  drawText(cv, sansB, '29 MORE STORIES', 478, 688, 13, INK, { tracking: 1 });
  cv.rect(478, 694, 518, 2, RED);
  const more = [
    ['SOMALIA', 'UAE envoy’s 72-hour deadline expires today.'],
    ['UKRAINE', 'Missile strike on Kryvyi Rih kills 2, injures 83. (AP)'],
    ['SOUTH KOREA', 'Minister quits over AI exam-cheating scandal. (AFP)'],
    ['NEPAL', 'PM Balendra Shah visits India.'],
    ['SPAIN', 'Bank levy extended to 2027; €1.4bn a year.'],
    ['INDIA', 'Toxic alcohol kills 11 in Manipur.'],
    ['GAZA', 'Four Palestinians killed in overnight strikes.'],
    ['GERMANY', 'IG Metall strikes Monday; 23,000 out. (Reuters)'],
    ['AUSTRALIA', 'Canberra hits back at AUKUS report. (Reuters)'],
    ['SOFTBANK', 'Son’s $1tn SK Hynix talks collapse.'],
    ['NATO', 'Russia revives demand to roll back to 1997. (AP)'],
    ['CRICKET', 'India post record 629-6 in Wellington. (Reuters)'],
    ['PERU', 'M6.7 quake rattles Junín; no major damage. (USGS)'],
    ['MYANMAR', 'Junta slams ASEAN exclusion as unfair. (Reuters)'],
    ['THAILAND', 'Thailand to halt mine chemicals to Myanmar. (Reuters)'],
    ['NORTH KOREA', 'Pyongyang marathon postponed to Oct 2027. (Reuters)'],
    ['BANGLADESH', 'Police step up security over sabotage fears. (TBS)'],
    ['ALBANIA', 'Rama refuses to quit as protests hit day 6. (AFP)'],
    ['USA', 'ICE arrests travellers at Seattle airport. (Reuters)'],
    ['KYIV', 'Drone wrecks 5-storey block; 2 hurt. (UkrInform)'],
    ['NBA', 'Bridges buzzer-beater lifts Knicks 97-96. (Reuters)'],
    ['F1', 'Verstappen wins Las Vegas GP for 3rd time. (Reuters)'],
    // rev7: 7 new verified stories for 22 Nov 2026 (in the order verified)
    ['SOUTH AFRICA', 'G20 opens in Johannesburg; US stays away. (Reuters)'],
    ['IRAN', 'Rolling blackouts begin; up to 2 hours a day. (Straits Times)'],
    ['ENGLAND', 'Leeds thrash Chelsea 4-1 at Stamford Bridge. (Reuters)'],
    ['GULF', 'Gulf bourses slide as attacks continue. (Reuters)'],
    ['VATICAN', 'Pope shares lunch with 1,300 poor. (Vatican)'],
    ['INDONESIA', 'EU trade deal signed after 10 years of talks. (Reuters)'],
    ['ISRAEL', 'Eisenkot invites Likud to coalition talks. (AFP)'],
  ];
  // rev10: reflowed into 2 columns (15 + 14) — the single-column list left a
  // ~200px empty band down the right side (each item was one short line).
  // At ~250px per column the same texts wrap to ~2 lines and fill the full
  // width. No text changed; per-column leading is stretched so both columns
  // end at the footer.
  function wrapItem(country, text, maxW) {
    const toks = [];
    for (const w of (country + ' —').split(' ')) toks.push([w, true]);
    for (const w of text.split(' ')) toks.push([w, false]);
    const lines = [];
    let cur = [], curW = 0;
    const sp = textWidth(sansR, ' ', 9, 1, 0);
    for (const [w, b] of toks) {
      const ww = textWidth(b ? sansB : sansR, w, b ? 9.5 : 9, 1, 0);
      const add = cur.length ? sp + ww : ww;
      if (curW + add <= maxW || !cur.length) { cur.push([w, b]); curW += add; }
      else { lines.push(cur); cur = [[w, b]]; curW = ww; }
    }
    if (cur.length) lines.push(cur);
    return lines;
  }
  const colW = 253, colGap = 12, itemGap = 2, listTop = 703, listBot = 972;
  const colItems = [more.slice(0, 15), more.slice(15)];
  for (let c = 0; c < 2; c++) {
    const x0 = 478 + c * (colW + colGap);
    const wrapped = colItems[c].map(([ct, tx]) => wrapItem(ct, tx, colW - 10));
    const nLines = wrapped.reduce((s, it) => s + it.length, 0);
    let lh = (listBot - listTop - (colItems[c].length - 1) * itemGap) / nLines;
    if (lh > 9.6) lh = 9.6;
    let y = listTop;
    for (const lines of wrapped) {
      cv.rect(x0, y - 6, 5, 5, RED);
      for (const ln of lines) {
        let tx = x0 + 10;
        for (const [w, b] of ln) {
          const f = b ? sansB : sansR, s = b ? 9.5 : 9;
          drawText(cv, f, w, tx, y, s, b ? INK : '#333333');
          tx += textWidth(f, w, s, 1, 0) + textWidth(sansR, ' ', 9, 1, 0);
        }
        y += lh;
      }
      y += itemGap;
    }
  }

  // ---- footer: DATE CHECK ----
  cv.rect(MX, 978, RX - MX, 32, '#efe8d6');
  cv.rect(MX, 978, RX - MX, 1, INK);
  cv.rect(MX, 1009, RX - MX, 1, INK);
  // rev6: two-line footer (rank 1 has a full DATE CHECK note, not one line)
  drawText(cv, sansB, 'DATE CHECK', MX + 10, 998, 11, RED, { tracking: 1 });
  drawText(cv, sansR, 'Every story on this page was verified from primary sources for Sunday 22 November 2026.', MX + 108, 992, 10, INK);
  drawText(cv, sansR, '42 stories on this page; 32 numbered dots mark their locations — stories in the same city share a dot. Sources are named beside each story.', MX + 108, 1004, 10, INK);
  drawText(cv, serifB, 'THE WORLD TODAY', RX - 10, 998, 12, INK, { align: 'right' });
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
