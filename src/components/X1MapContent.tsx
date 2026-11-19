import { useEffect, useRef, useState } from 'react';
import { readMapBytes, readParcels, layoutMap } from '../lib/x1insContent';
import { INS_SITE } from '../lib/x1inscriptions';

/**
 * An X1MAPS map drawn WITH the content inscribed in its blocks.
 *
 * ⛔ A PARCEL IS ONE BLOCK OF A MAP. Drawing a map as flat coloured squares
 * hides whatever its parcels hold — and on mainnet every parcel that exists
 * holds something (37 of 37 on 2026-11-18). So a map with content showed as an
 * empty grid, and a parcel showed as a dot on a dimmed map, both hiding the
 * thing actually being sold.
 *
 * The layout comes from the chain (the art rule's packer, ported in
 * x1insContent.layoutMap — parcel n is rects[n-1]); each filled block's content
 * comes from x1inscriptions.io/api/ins/<n>, which serves the inscription's real
 * bytes with its real content type. Images draw into their block. Video and
 * audio can't be drawn, so those blocks keep their map colour and are marked —
 * a still frame would be a lie about what you get.
 */
const BLUE: [number, number, number] = [0x00, 0x88, 0xff];
const GRAY: [number, number, number] = [0x8a, 0x8a, 0x92];

export default function X1MapContent({
  height, connection, size = 512, className, style,
}: {
  height: number; connection: any; size?: number;
  className?: string; style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<'loading' | 'done' | 'empty'>('loading');

  useEffect(() => {
    let alive = true;
    (async () => {
      const bytes = await readMapBytes(connection, height);
      if (!alive) return;
      if (!bytes) { setState('empty'); return; }

      const lay = layoutMap(bytes);
      const cv = ref.current;
      if (!cv) return;
      cv.width = size; cv.height = size;
      const ctx = cv.getContext('2d');
      if (!ctx) return;

      // the map itself, same colours the art rule uses
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size, size);
      const frame = Math.round(size * 0.02), inner = size - 2 * frame, g = inner / lay.W;
      const pad = g >= 4 ? g / 4 : g * 0.12;
      const box = (i: number) => {
        const r = lay.rects[i];
        return { L: frame + r.x * g + pad, T: frame + r.y * g + pad, W: r.s * g - 2 * pad, H: r.s * g - 2 * pad };
      };
      for (let i = 0; i < lay.rects.length; i++) {
        const shade = bytes[i] >> 5, base = (bytes[i] >> 4) & 1 ? GRAY : BLUE, f = 1 - 0.05 * shade;
        const b = box(i);
        ctx.fillStyle = `rgb(${base[0] * f},${base[1] * f},${base[2] * f})`;
        ctx.fillRect(b.L, b.T, b.W, b.H);
      }
      setState('done');

      // then the content, block by block, as each one arrives
      const parcels = await readParcels(connection, height, bytes.length);
      if (!alive) return;
      for (const p of parcels.values()) {
        if (!p.filled || p.content == null) continue;
        const b = box(p.n - 1);
        if (!b || !isFinite(b.L)) continue;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          if (!alive) return;
          // cover the block, cropping the overflow — the block is square and
          // the art usually isn't
          const k = Math.max(b.W / img.width, b.H / img.height);
          const w = img.width * k, h = img.height * k;
          ctx.save();
          ctx.beginPath(); ctx.rect(b.L, b.T, b.W, b.H); ctx.clip();
          ctx.drawImage(img, b.L + (b.W - w) / 2, b.T + (b.H - h) / 2, w, h);
          ctx.restore();
        };
        // ⛔ Only images. A video or audio inscription has no frame to draw, and
        // faking one would misrepresent what the buyer gets.
        img.onerror = () => { /* not an image: the block keeps its map colour */ };
        img.src = `${INS_SITE}/api/ins/${p.content}`;
      }
    })();
    return () => { alive = false; };
  }, [height, connection, size]);

  if (state === 'empty') return null;
  return <canvas ref={ref} className={className} style={{ width: '100%', height: '100%', display: 'block', ...style }} />;
}
