# SMPL design assets

Source files for designing iterations on the SMPL workflow app. Drag any
`.svg` file straight into Figma — every top-level `<g id="...">` becomes
a named frame on import.

## Files

### `smpl-mobile-mockup-v2.3.0.svg`

Six iPhone-14-sized (390×844) mockups against the v2.3.0 production
codebase. All colors, type, and spacing are copied straight from
`apps/web/src/styles.css` so what you redesign in Figma will look the
same when implemented.

| Frame | Screen | Purpose |
|------:|--------|---------|
| 00 | Design System | Brand colors, type scale, components — drop swatches/components onto other frames |
| 01 | Login | Email/password entry, brand mark |
| 02 | Time Tracking | Donut KPI, clock-in/out, calendar with absence pills |
| 03 | My Tasks | Filter chips, task cards (overdue/today/done), FAB |
| 04 | Messages | Thread list with unread badges, reaction strip preview |
| 05 | Admin Backups | NEW v2.3.0 panel — list, status banner, job progress, restore |

## How to use in Figma

1. Open Figma → create a new file (or open an existing project).
2. Drag the `.svg` directly into the canvas.
3. Each frame appears in the layer panel with its descriptive name.
4. Edit any vector (rectangle, text, icon) — Figma converts SVG into
   editable vector primitives automatically.
5. To pull a brand color: open Frame 00, eyedropper a swatch, save it
   to a Figma "Color Style" so you can apply it everywhere.
6. To prototype a flow: in Frame 04 (Messages), select a thread row →
   drag a connection arrow to a "Thread Detail" frame you create from
   scratch.

## Fonts

Frames use **Source Sans 3** (the production font) with a system fallback.
Install Source Sans 3 in Figma if you want a pixel-perfect preview:
https://fonts.google.com/specimen/Source+Sans+3

## When the codebase changes

Design tokens drift. If you touch colors, spacing, or major layouts in
the codebase, regenerate this file from the new tokens before iterating.
The current mockup is pinned to **v2.3.0** (commit `0b91c8d`).
