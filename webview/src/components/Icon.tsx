import type { ReactElement } from "react";

/**
 * The chrome's icon convention: one stroked path on a 16×16 grid, sized down to
 * 14px, plus optional dots for graph-like glyphs. Sharing the primitive keeps
 * every bar's icons on the same stroke weight and cap style.
 */
export function Icon({
  path,
  nodes,
}: {
  path: string;
  nodes?: Array<[number, number]>;
}): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
      {nodes?.map(([cx, cy]) => (
        <circle key={`${cx},${cy}`} cx={cx} cy={cy} r="1.4" />
      ))}
    </svg>
  );
}

export const ICON_NEW = "M8 3.2v9.6M3.2 8h9.6";
/* Clock: two half-arcs make the ring, then the hands. */
export const ICON_RESUME =
  "M8 2.3a5.7 5.7 0 1 0 0 11.4 5.7 5.7 0 1 0 0-11.4M8 4.9V8.2l2.5 1.5";
export const ICON_BRANCH =
  "M5 5.3v5.4M10.9 6.3v.5c0 1.3-1 1.8-2.4 2-1.3.2-2.7.5-3.5 1.9";
export const ICON_BRANCH_NODES: Array<[number, number]> = [
  [5, 3.7],
  [5, 12.3],
  [10.9, 4.8],
];
/* Zero-length segments with round caps: three dots. */
export const ICON_OVERFLOW = "M8 3.4h.01M8 8h.01M8 12.6h.01";
export const ICON_CLOSE = "M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8";
export const ICON_CHEVRON = "M4.8 6.4 8 9.6l3.2-3.2";
/* Folder outline, then a plus centred in its body. */
export const ICON_FOLDER_ADD =
  "M2.6 12.6V4.2h3.2l1.4 1.8h6.2v6.6zM8 7.9v2.8M6.6 9.3h2.8";
/* Lid, then the can. */
export const ICON_TRASH =
  "M2.8 4.6h10.4M6.4 4.6V3.2h3.2v1.4M4.2 4.6l.6 8.2h6.4l.6-8.2";
