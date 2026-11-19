import { useEffect, useMemo, useRef, useState } from 'react';
import { readMapBytes, readParcels, readInscriptionTypes, rasterMap, overlayBoxes, contentUrl } from '../lib/x1insContent';

/**
 * An X1MAPS map drawn WITH what is inscribed in its blocks — the same way
 * x1inscriptions.io draws it (src/components/ParcelsPanel.tsx there).
 *
 * ⛔ A PARCEL IS ONE BLOCK OF A MAP. On mainnet every parcel that exists holds
 * something (37 of 37 on 2026-11-18), so a flat grid of coloured squares hides
 * the thing being sold every single time.
 *
 * Copied from theirs, deliberately, including the parts that are not obvious:
 *  · the map is the canonical raster (centred both ways, 2% frame, the tiny-
 *    square dot grid, the darker inner ring) — see x1insContent.rasterMap
 *  · the content sits in an SVG over it in a 1000-unit box, so a thumbnail
 *    lands exactly on its square at any display size
 *  · SHOW CONTENTS MEANS ALL OF THEM (their owner, 11-13). No "too small to
 *    bother" rule: every filled block draws, however small. THUMB_MAX is only
 *    a runaway guard, biggest-first so it can never hide a big one.
 *  · video gets a real <video preload="metadata"> in a foreignObject, seeked a
 *    little way in because FRAME 0 IS OFTEN BLACK, and plays with sound on
 *    click. Nothing autoplays.
 *  · audio gets a play tile. A still frame can't represent a song.
 */
const THUMB_MAX = 400;

type Thumb = { n: number; x: number; y: number; r: number; ins: number; ct: string };

export default function X1MapContent({
  height, connection, className, style, showContent = true,
}: {
  height: number; connection: any;
  className?: string; style?: React.CSSProperties;
  /** off = just the map, the way the block page starts */
  showContent?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [playing, setPlaying] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const b = await readMapBytes(connection, height);
      if (!alive || !b) return;
      setBytes(b);

      const parcels = await readParcels(connection, height, b.length);
      if (!alive) return;
      const filled = [...parcels.values()].filter(p => p.filled && p.content != null);
      if (!filled.length) return;
      const types = await readInscriptionTypes(connection, filled.map(p => p.content!));
      if (!alive) return;
      const boxes = new Map(overlayBoxes(b).map(x => [x.n, x]));
      const list: Thumb[] = [];
      for (const p of filled) {
        const box = boxes.get(p.n);
        if (!box) continue;
        list.push({ ...box, ins: p.content!, ct: types.get(p.content!) ?? '' });
      }
      // biggest first, so the runaway guard never drops a big square
      list.sort((a, b2) => b2.r - a.r);
      setThumbs(list.slice(0, THUMB_MAX));
    })();
    return () => { alive = false; };
  }, [height, connection]);

  // the map itself
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !bytes) return;
    const S = 720;
    cv.width = S; cv.height = S;
    const img = rasterMap(bytes, S);
    if (img) cv.getContext('2d')?.putImageData(img, 0, 0);
  }, [bytes]);

  const shown = useMemo(() => (showContent ? thumbs : []), [showContent, thumbs]);
  if (!bytes) return null;

  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%', ...style }}>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />
      {!!shown.length && (
        <svg viewBox="0 0 1000 1000" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {shown.map(t => {
            const sw = Math.min(6, Math.max(1.5, t.r * 0.06));
            const X = t.x + sw, Y = t.y + sw, W = t.r - 2 * sw;
            const src = contentUrl(t.ins);
            if (t.ct.startsWith('image/')) return (
              <image key={t.n} href={src} x={X} y={Y} width={W} height={W}
                preserveAspectRatio="xMidYMid slice" style={{ pointerEvents: 'none' }} />
            );
            if (t.ct.startsWith('video/')) return (
              <foreignObject key={t.n} x={X} y={Y} width={W} height={W}>
                {/* ⛔ FRAME 0 IS OFTEN BLACK — a clip that fades up shows a dead
                    square. Seek a little way in for the poster instead; clicking
                    still plays from the start, with sound. */}
                <video src={src} preload="metadata" muted playsInline
                  style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000', cursor: 'pointer' }}
                  onLoadedMetadata={e => {
                    const v = e.currentTarget;
                    if (v.dataset.seen) return;
                    const at = Math.min((v.duration || 0) * 0.1, 5);
                    if (at > 0.05) { v.dataset.poster = '1'; try { v.currentTime = at; } catch { /* not seekable */ } }
                  }}
                  onClick={e => {
                    const v = e.currentTarget;
                    if (!v.paused) { v.pause(); return; }
                    if (v.dataset.poster && !v.dataset.seen) {
                      v.dataset.seen = '1'; delete v.dataset.poster;
                      try { v.currentTime = 0; } catch { /* not seekable */ }
                    }
                    // a click IS the permission for sound, and everything else
                    // playing on this map stops first
                    document.querySelectorAll('video,audio').forEach(el => {
                      if (el !== v) (el as HTMLMediaElement).pause();
                    });
                    v.muted = false;
                    v.play().catch(() => {});
                  }} />
              </foreignObject>
            );
            if (t.ct.startsWith('audio/')) return (
              <foreignObject key={t.n} x={X} y={Y} width={W} height={W}>
                {/* a song has no frame. A play tile says what it is and plays on
                    click; preload="none" keeps a map full of songs from
                    downloading all of them. */}
                <div
                  style={{
                    width: '100%', height: '100%', display: 'grid', placeItems: 'center',
                    background: 'linear-gradient(135deg,#1a1033,#0d0820)', cursor: 'pointer',
                    color: '#bf5af2', fontSize: Math.max(10, W * 0.4),
                  }}
                  onClick={e => {
                    const host = e.currentTarget;
                    let a = host.querySelector('audio') as HTMLAudioElement | null;
                    if (!a) {
                      a = document.createElement('audio');
                      a.src = src; a.preload = 'none';
                      host.appendChild(a);
                    }
                    document.querySelectorAll('video,audio').forEach(el => {
                      if (el !== a) (el as HTMLMediaElement).pause();
                    });
                    if (a.paused) { setPlaying(t.n); a.play().catch(() => {}); }
                    else { a.pause(); setPlaying(null); }
                  }}
                >{playing === t.n ? '❚❚' : '▶'}</div>
              </foreignObject>
            );
            return null;   // a website or a file: the block keeps its map colour
          })}
        </svg>
      )}
    </div>
  );
}
