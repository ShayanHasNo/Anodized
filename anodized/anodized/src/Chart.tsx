import { useEffect, useRef, useState } from 'react';
import { BROWNOUT } from './sim/solver';

export interface Series {
  key: string;
  label: string;
  unit: string;
  family: string;
  color: string;
  data: Float64Array;
  axis: 0 | 1;
}

const PAD = { l: 52, r: 54, t: 12, b: 26 };

function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) return [lo];
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

export function Chart({
  time, series, height = 236,
}: { time: Float64Array; series: Series[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const cv = ref.current, wrap = wrapRef.current;
    if (!cv || !wrap || time.length === 0) return;

    const w = wrap.clientWidth;
    if (w < 220) return; // too narrow to lay out axes meaningfully
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = height * dpr;
    cv.style.width = `${w}px`; cv.style.height = `${height}px`;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, height);

    const px = { x0: PAD.l, x1: w - PAD.r, y0: PAD.t, y1: height - PAD.b };
    const tMin = time[0], tMax = time[time.length - 1];

    // One range per axis, so mixed unit families never share a scale.
    const range = [0, 1].map((ax) => {
      const s = series.filter((x) => x.axis === ax);
      if (!s.length) return null;
      let lo = Infinity, hi = -Infinity;
      for (const x of s) for (let i = 0; i < x.data.length; i++) {
        if (x.data[i] < lo) lo = x.data[i];
        if (x.data[i] > hi) hi = x.data[i];
      }
      if (lo === hi) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.08;
      return { lo: lo - pad, hi: hi + pad };
    });

    const sx = (t: number) => px.x0 + ((t - tMin) / (tMax - tMin || 1)) * (px.x1 - px.x0);
    const sy = (v: number, ax: 0 | 1) => {
      const r = range[ax]!;
      return px.y1 - ((v - r.lo) / (r.hi - r.lo || 1)) * (px.y1 - px.y0);
    };

    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue('--line').trim() || '#3d454c';
    const ink3 = css.getPropertyValue('--ink-3').trim() || '#6f7a82';
    const ink2 = css.getPropertyValue('--ink-2').trim() || '#a3adb4';

    // Brownout band — hatched, because a solid fill reads as data.
    const hasVolts = series.some((s) => s.family === 'voltage');
    if (hasVolts) {
      const ax = series.find((s) => s.family === 'voltage')!.axis;
      const r = range[ax]!;
      if (r.lo < BROWNOUT.rioV2) {
        const yTop = sy(Math.min(BROWNOUT.rioV2, r.hi), ax);
        g.save();
        g.beginPath();
        g.rect(px.x0, yTop, px.x1 - px.x0, px.y1 - yTop);
        g.clip();
        g.strokeStyle = 'rgba(224,96,74,0.20)';
        g.lineWidth = 1;
        for (let x = px.x0 - (px.y1 - yTop); x < px.x1; x += 7) {
          g.beginPath(); g.moveTo(x, px.y1); g.lineTo(x + (px.y1 - yTop), yTop); g.stroke();
        }
        g.restore();
        g.strokeStyle = 'rgba(224,96,74,0.75)';
        g.setLineDash([4, 3]); g.lineWidth = 1;
        g.beginPath(); g.moveTo(px.x0, yTop); g.lineTo(px.x1, yTop); g.stroke();
        g.setLineDash([]);
        g.fillStyle = 'rgba(224,96,74,0.9)';
        g.font = '10px "IBM Plex Mono", monospace';
        g.textAlign = 'left';
        g.fillText(`brownout ${BROWNOUT.rioV2} V`, px.x0 + 5, yTop - 4);
      }
    }

    // Grid + axes
    g.font = '10px "IBM Plex Mono", monospace';
    g.strokeStyle = line; g.lineWidth = 1;
    for (const t of niceTicks(tMin, tMax, 6)) {
      const x = Math.round(sx(t)) + 0.5;
      g.globalAlpha = 0.5;
      g.beginPath(); g.moveTo(x, px.y0); g.lineTo(x, px.y1); g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = ink3; g.textAlign = 'center';
      g.fillText(`${t.toFixed(2)}`, x, px.y1 + 15);
    }

    if (range[0]) {
      for (const v of niceTicks(range[0].lo, range[0].hi, 4)) {
        const y = Math.round(sy(v, 0)) + 0.5;
        g.globalAlpha = 0.5; g.strokeStyle = line;
        g.beginPath(); g.moveTo(px.x0, y); g.lineTo(px.x1, y); g.stroke();
        g.globalAlpha = 1;
        g.fillStyle = series.find((s) => s.axis === 0)?.color ?? ink3;
        g.textAlign = 'right';
        g.fillText(fmt(v), px.x0 - 6, y + 3);
      }
    }
    if (range[1]) {
      for (const v of niceTicks(range[1].lo, range[1].hi, 4)) {
        const y = Math.round(sy(v, 1)) + 0.5;
        g.fillStyle = series.find((s) => s.axis === 1)?.color ?? ink3;
        g.textAlign = 'left';
        g.fillText(fmt(v), px.x1 + 6, y + 3);
      }
    }

    g.strokeStyle = line; g.globalAlpha = 1;
    g.beginPath();
    g.moveTo(px.x0 + 0.5, px.y0); g.lineTo(px.x0 + 0.5, px.y1 + 0.5); g.lineTo(px.x1, px.y1 + 0.5);
    g.stroke();

    // Traces. Step through pixels rather than samples so 10k points stay cheap.
    const stride = Math.max(1, Math.floor(time.length / (px.x1 - px.x0) / 2));
    for (const s of series) {
      g.strokeStyle = s.color; g.lineWidth = 1.4;
      g.lineJoin = 'round'; g.beginPath();
      for (let i = 0; i < s.data.length; i += stride) {
        const x = sx(time[i]), y = sy(s.data[i], s.axis);
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }

    // Crosshair
    if (hover !== null && hover >= px.x0 && hover <= px.x1) {
      const frac = (hover - px.x0) / (px.x1 - px.x0);
      const idx = Math.min(time.length - 1, Math.max(0, Math.round(frac * (time.length - 1))));
      const x = Math.round(sx(time[idx])) + 0.5;
      g.strokeStyle = ink2; g.globalAlpha = 0.5; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, px.y0); g.lineTo(x, px.y1); g.stroke();
      g.globalAlpha = 1;

      let ly = px.y0 + 12;
      const boxW = 132;
      const bx = x + 8 + boxW > px.x1 ? x - boxW - 8 : x + 8;
      g.fillStyle = 'rgba(28,32,35,0.94)';
      g.strokeStyle = line;
      g.fillRect(bx, px.y0 + 2, boxW, 14 + series.length * 13);
      g.strokeRect(bx + 0.5, px.y0 + 2.5, boxW, 14 + series.length * 13);
      g.fillStyle = ink2; g.textAlign = 'left';
      g.fillText(`t = ${time[idx].toFixed(3)} s`, bx + 7, ly + 2);
      ly += 14;
      for (const s of series) {
        g.fillStyle = s.color;
        g.fillRect(bx + 7, ly - 3, 8, 2.5);
        g.fillStyle = ink2;
        g.fillText(`${fmt(s.data[idx])} ${s.unit}`, bx + 20, ly + 2);
        ly += 13;
      }
    }
  }, [time, series, height, hover]);

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <canvas
        ref={ref}
        onMouseMove={(e) => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)}
        onMouseLeave={() => setHover(null)}
        style={{ display: 'block', cursor: 'crosshair' }}
      />
    </div>
  );
}
