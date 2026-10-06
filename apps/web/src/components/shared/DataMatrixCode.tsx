/**
 * A DataMatrix (ECC 200), drawn in the browser as SVG.
 *
 * The encoder is ZXing's DataMatrixWriter, forced to a SQUARE symbol. Both
 * choices were measured, not assumed (2026-10-05), by decoding 200 random
 * station-badge codes with an independent decoder (zxing-cpp):
 *
 *   ZXing, FORCE_SQUARE     200/200 exact, 18x18 modules
 *   ZXing, default shape    200/200 exact, but RECTANGULAR 12x26 -- valid
 *                           ECC 200 that some imagers handle worse
 *   ReportLab ECC200        0/200: every code came back with a trailing NUL
 *                           (its C40 padding), in an oversized 44x44 symbol
 *
 * so ReportLab, which the API already ships, is deliberately not used.
 *
 * Drawn black on white whatever the page theme: an imager does not read light
 * modules on dark. The quiet zone is part of the symbol (QUIET_MODULES on each
 * side), and each run of dark modules in a row is ONE rect, so anti-aliasing
 * cannot open hairline seams between neighbours. The library is loaded
 * lazily: it is large, and only a few pages ever draw a code.
 */
import { useEffect, useState } from "react";

/** ECC 200 asks for one module of quiet zone; two survives a sloppy print. */
export const QUIET_MODULES = 2;

type ZxingModule = typeof import("@zxing/library");

/** The symbol's modules, top row first: true is dark. No quiet zone. */
export function encodeDataMatrix(zx: ZxingModule, value: string): boolean[][] {
  const hints = new Map();
  hints.set(zx.EncodeHintType.DATA_MATRIX_SHAPE, zx.DataMatrixSymbolShapeHint.FORCE_SQUARE);
  const matrix = new zx.DataMatrixWriter().encode(value, zx.BarcodeFormat.DATA_MATRIX, 0, 0, hints);
  const rows: boolean[][] = [];
  for (let y = 0; y < matrix.getHeight(); y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < matrix.getWidth(); x += 1) row.push(matrix.get(x, y));
    rows.push(row);
  }
  return rows;
}

/** One rect per horizontal run of dark modules, in module units, quiet zone applied. */
export function moduleRuns(rows: boolean[][]): Array<{ x: number; y: number; w: number }> {
  const runs: Array<{ x: number; y: number; w: number }> = [];
  rows.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const dark = x < row.length && row[x];
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        runs.push({ x: start + QUIET_MODULES, y: y + QUIET_MODULES, w: x - start });
        start = -1;
      }
    }
  });
  return runs;
}

type DataMatrixCodeProps = {
  value: string;
  /** Rendered edge length in CSS pixels, quiet zone included. */
  size?: number;
  /** What a screen reader says instead of the pattern. */
  label: string;
  className?: string;
};

export function DataMatrixCode({ value, size = 160, label, className }: DataMatrixCodeProps): JSX.Element {
  const [rows, setRows] = useState<boolean[][] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);
    import("@zxing/library")
      .then((zx) => {
        if (!cancelled) setRows(encodeDataMatrix(zx, value));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return (
      <span className={className} role="img" aria-label={label}>
        {value}
      </span>
    );
  }
  if (!rows || rows.length === 0) {
    return <span className={className} style={{ display: "inline-block", width: size, height: size }} aria-busy="true" />;
  }

  const edge = rows.length + 2 * QUIET_MODULES;
  return (
    <svg
      className={className}
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${edge} ${edge}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={edge} height={edge} fill="#ffffff" />
      {moduleRuns(rows).map((run) => (
        <rect key={`${run.y}:${run.x}`} x={run.x} y={run.y} width={run.w} height={1} fill="#000000" />
      ))}
    </svg>
  );
}
