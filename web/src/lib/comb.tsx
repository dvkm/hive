import { useId } from "react";

// The comb: one hexagonal cell per task, drawn as the beekeeping lifecycle so the
// picture carries the state and color is only a second cue. empty = queued,
// bee = an agent on it, filling = in review (honey pouring in), full = verifying
// (uncapped, waiting for the director to cap it), capped = landed, question =
// needs a decision, cracked = failed, sealed = cancelled. stuck/silent are the
// health overlays on a running cell. Colors come from the --cell-* / --honey*
// tokens in styles.css, which stay honey-and-wax in both themes.
export type CellKind = "empty" | "bee" | "filling" | "full" | "capped" | "question" | "cracked" | "sealed" | "stuck" | "silent";

export const COMB_MAX = 36;
const ORDER: CellKind[] = ["capped", "full", "question", "filling", "bee", "cracked", "empty"];

// Cells for the day, heaviest first, capped so a heavy day stays one glance wide.
export function combCells(counts: Partial<Record<CellKind, number>>): CellKind[] {
  return ORDER.flatMap((kind) => Array<CellKind>(Math.max(0, counts[kind] ?? 0)).fill(kind)).slice(0, COMB_MAX);
}

const pts = (cx: number, cy: number, r: number) =>
  [0, 60, 120, 180, 240, 300]
    .map((a) => `${(cx + r * Math.cos((a * Math.PI) / 180)).toFixed(1)},${(cy + r * Math.sin((a * Math.PI) / 180)).toFixed(1)}`)
    .join(" ");
// Glyphs live in a 48×44 box: a flat-top hexagon of radius 22, like the logo mark.
const HEX = pts(24, 22, 22);
const INNER = pts(24, 22, 15);
const CAP_EDGE = pts(24, 22, 17);
const WAVE = "M-12 22 q6 -3 12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0";

function Bee({ faded }: { faded?: boolean }) {
  const id = useId();
  return (
    <g opacity={faded ? 0.45 : 1} transform="translate(24 23)">
      <clipPath id={id}>
        <ellipse cx="0" cy="1" rx="5.6" ry="7.8" />
      </clipPath>
      <g className="comb-wings">
        <ellipse className="comb-wing" cx="-8.2" cy="-3.6" rx="7.6" ry="3.9" transform="rotate(-36 -8.2 -3.6)" />
        <ellipse className="comb-wing" cx="8.2" cy="-3.6" rx="7.6" ry="3.9" transform="rotate(36 8.2 -3.6)" />
      </g>
      <ellipse className="comb-body" cx="0" cy="1" rx="5.6" ry="7.8" />
      <path className="comb-ink-stroke" d="M-6.5 -2.2 H6.5 M-6.5 2 H6.5 M-6.5 6.2 H6.5" strokeWidth="2.2" clipPath={`url(#${id})`} />
      <circle className="comb-ink" cx="0" cy="-8.4" r="3.6" />
      <path className="comb-ink-stroke" d="M-1.8 -11.4 q-1.6 -2.8 -4.6 -2.6 M1.8 -11.4 q1.6 -2.8 4.6 -2.6" strokeWidth="0.9" strokeLinecap="round" />
      <path className="comb-ink" d="M-1.5 8.4 L0 11.6 L1.5 8.4 Z" />
    </g>
  );
}

// The drawing of one cell, in glyph coordinates. Cell wraps it in its own svg;
// Comb places many inside one svg.
function CellBody({ kind }: { kind: CellKind }) {
  const id = useId();
  const wax = kind === "empty" || kind === "bee" || kind === "question" || kind === "stuck" || kind === "silent";
  return (
    <>
      {wax && (
        <>
          <polygon className="comb-wax" points={HEX} strokeDasharray={kind === "silent" ? "3 2.5" : undefined} />
          <polygon className="comb-inner" points={INNER} />
        </>
      )}
      {kind === "filling" && (
        <>
          <polygon className="comb-wax comb-open" points={HEX} />
          <clipPath id={id}>
            <polygon points={HEX} />
          </clipPath>
          <g clipPath={`url(#${id})`}>
            <rect className="comb-honey-light" x="22.7" y="0" width="2.6" height="46" rx="1.3" />
            <g className="comb-rise">
              <path className="comb-flow comb-honey-light" d={`${WAVE} V80 H-12 Z`} />
              <path className="comb-flow comb-wave-line" d={WAVE} />
              <ellipse className="comb-shine" cx="16" cy="29" rx="3.2" ry="1.5" />
            </g>
          </g>
        </>
      )}
      {kind === "full" && (
        <>
          <polygon className="comb-honey-light comb-open" points={HEX} strokeWidth="1.5" />
          <ellipse className="comb-shine" cx="17" cy="14" rx="5" ry="2.6" transform="rotate(-30 17 14)" />
        </>
      )}
      {kind === "capped" && (
        <>
          <polygon className="comb-capped" points={HEX} />
          <polygon className="comb-cap-edge" points={CAP_EDGE} />
        </>
      )}
      {kind === "cracked" && (
        <>
          <polygon className="comb-cracked" points={HEX} />
          <path className="comb-ink-stroke" d="M23 4 L20 13 L26 19 L21 27 L25 34 L23 41" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}
      {kind === "sealed" && (
        <>
          <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="comb-hatch" width="1.4" height="6" />
          </pattern>
          <polygon className="comb-wax" points={HEX} />
          <polygon points={HEX} fill={`url(#${id})`} />
        </>
      )}
      {(kind === "bee" || kind === "stuck" || kind === "silent") && <Bee faded={kind === "silent"} />}
      {kind === "stuck" && (
        <text className="comb-zz" x="36" y="11">
          zz
        </text>
      )}
      {kind === "question" && (
        <text className="comb-q" x="24" y="23" textAnchor="middle" dominantBaseline="central">
          ?
        </text>
      )}
    </>
  );
}

export function Cell({ kind, size = 48, label }: { kind: CellKind; size?: number; label?: string }) {
  return (
    <svg
      className={`comb-cell comb-${kind}`}
      width={size}
      height={(size * 44) / 48}
      viewBox="0 0 48 44"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <CellBody kind={kind} />
    </svg>
  );
}

// Two staggered rows of flat-top cells.
export function Comb({ cells, size = 26, gap = 2, label }: { cells: CellKind[]; size?: number; gap?: number; label: string }) {
  const kinds = cells.slice(0, COMB_MAX);
  if (!kinds.length) return null;
  const r = (22 * size) / 48;
  const h = Math.sqrt(3) * r;
  const step = 1.5 * r + gap;
  const cols = Math.ceil(kinds.length / 2);
  const w = 2 * r + (cols - 1) * step + 4;
  const hh = 2 * h + gap + h / 2 + 4;
  return (
    <svg className="comb" width={w} height={hh} viewBox={`0 0 ${w} ${hh}`} role="img" aria-label={label}>
      {kinds.map((kind, i) => {
        const col = Math.floor(i / 2);
        const cx = 2 + r + col * step;
        const cy = 2 + h / 2 + (i % 2) * (h + gap) + (col % 2 ? h / 2 + gap / 2 : 0);
        return (
          <g key={i} transform={`translate(${(cx - size / 2).toFixed(1)} ${(cy - (size * 44) / 96).toFixed(1)}) scale(${(size / 48).toFixed(4)})`}>
            <CellBody kind={kind} />
          </g>
        );
      })}
    </svg>
  );
}

// A count in a big hexagon, for the now strip.
export function HexTile({ n, label, tone }: { n: number; label: string; tone: "amber" | "blue" | "red" | "muted" }) {
  return (
    <div className={`hextile hextile-${tone}`}>
      <svg width="84" height="74" viewBox="0 0 84 74" aria-hidden="true">
        <polygon points={pts(42, 37, 40)} />
        <text x="42" y="37" textAnchor="middle" dominantBaseline="central">
          {n}
        </text>
      </svg>
      <span>{label}</span>
    </div>
  );
}
