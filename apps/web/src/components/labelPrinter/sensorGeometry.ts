/** Sensor-area and media-path geometry of the owner's WAGO 258-5101, in millimetres.
 *  x = across the media path, 0 = scale reading 3 = media centre line, + = right as seen
 *  from the front with the lid open; a scale reading r sits at
 *  x = (r − scaleCentre) · scaleUnitMm (see `scaleToX`). y = along the feed, 0 = rear
 *  (roll side), increasing toward the operator.
 *  SOURCE: "Foto des Druckers 13.10.2026". The x values of the scale, slot, carriage and
 *  pointer are measured against the printed millimetre ticks (≈ ±0,5 mm); the y bands and
 *  depths are a drawing layout that follows the photo's order, not measurements (the photo
 *  is not perspective-corrected). Guide opening and the side view stay schematic.
 *  Per-material target readings are NOT here: they are the profile's `sensor_scale` (§3.3),
 *  approximate ("ca.") until T0.
 *
 *  This is the ONLY place a geometric number of the diagrams lives
 *  (docs/LABEL_PRINTER_CALIBRATION.md §7.8): the components read it at render time,
 *  so a correction from a new photo is an edit here and nowhere else. The keys after
 *  `sideView` are drawing details (stroke widths, glyph sizes, paddings) that the
 *  contract's list did not name; they live here for the same reason. */
export const SENSOR_GEOMETRY = {
  measured: true,                 // scale / slot / carriage geometry from the photo
  source: "Foto des Druckers 13.10.2026",
  // printed scale on the rear side of the sensor slot
  scaleUnitMm: 10,                // one scale number = 1 cm
  scaleCentre: 3,                 // reading of the media centre line
  scaleTickFrom: 0.6,             // first printed tick (reading)
  scaleTickTo: 5.4,               // last printed tick (reading)
  scaleTickStep: 0.1,             // short tick every millimetre
  scaleNumbers: [1, 2, 3, 4, 5],  // long tick + number; medium tick at every .5
  tickLengthMm: { short: 1.2, medium: 2.5, long: 5.0 },
  scaleNumberSizeMm: 2.4,         // font-size of the numbers 1–5
  // slot and carriage
  slotReadings: [-1.1, 7.1],      // slot / track ends as readings (≈ −41 … +41 mm)
  carriageWidthMm: 26,            // total, incl. the side wings
  carriageCoreWidthMm: 9,         // central block that carries the pointer
  carriageDepthMm: 8,
  pointerWidthMm: 3.5,            // base of ▲ and of ▼
  pointerHeightMm: 2.4,           // each triangle
  pointerWindowMm: 1.8,           // optical window between ▲ and ▼; sensing point at its centre
  beamSpotRadiusMm: 1.0,          // guess
  // media guides
  guideJawWidthMm: 3,
  guideFitClearanceMm: 1,
  guideMaxHalfOpeningMm: 30,      // unknown; 60 mm is the media maximum
  viewBox: { x: -44, y: 0, width: 88, height: 66 },
  // Below the slot, top to bottom: shift arrow, "Ziel" box, "Ist" box. The
  // contract's 36,5 / 38,5 / 41 left the opaque "Ziel" box (text 2,6 mm) over
  // the arrow, so the callouts moved down and the housing and the Lupe grew by
  // 1 mm to hold them (labelSensorDiagram.test.tsx checks the clearances).
  bands: {
    guide: [2, 12], housing: [14, 43], scaleNumbers: [15, 17.5], tickBaseline: 24,
    slot: [25, 35], sensingY: 30, shiftArrowY: 36, calloutTarget: 39.4, calloutActual: 42.1,
    breakMark: 44, platen: [47, 53], printLine: 50, tearEdge: 60,
  },
  zoomHalfWidthMm: 8,             // "Lupe": viewBox (target − 8, 14, 16, 29)
  zoomBand: [14, 43],
  silverMaterialIds: ["wago-210-804", "wago-210-824", "wago-210-812"],
  sideView: {
    viewBox: { x: 0, y: 0, width: 160, height: 70 },
    rollInternal: { cx: 28, cy: 38, r: 13 },
    rollExternal: { cx: 10, cy: 38, r: 9 },
    housingX: [22, 150],
    rearSlotX: 44, guideX: 56, sensorX: 82, platenCx: 116, platenR: 7, tearX: 142,
    pathY: 38,
    // drawing details of the schematic (not measured)
    housingY: [14, 60],
    unitWidth: 8, unitHeight: 4, unitGap: 3,
    headWidth: 12, headHeight: 6, lidY: 18,
    ribbonRoll: { cx: 104, cy: 22, r: 4 },
    ribbonTakeUp: { cx: 128, cy: 22, r: 4 },
    textSize: 4,
    slotWidth: 2, guideWidth: 3, cornerRadius: 2, labelGap: 1,
    arrowGap: 2, arrowHead: 1.5, beamSpread: 2,
    lidOverhang: 8, ribbonDrop: 0.5, tearHalf: 3,
  },
  // drawing details of the top view (not measured)
  textSizeMm: 2.6,                // callouts and mm labels
  zoomTextScale: 0.45,            // the "Lupe" shows 16 mm: text shrinks so it does not cover the ticks
  charWidthEm: 0.6,               // rough glyph width, sizes the callout boxes
  calloutBoxEm: { top: 0.78, height: 0.98 },   // tight box: "Ziel" and "Ist" bands are 2,5 mm apart
  breakLabelSizeMm: 2,            // "nicht maßstäblich" between break mark and roller, and the legends
  strokeMm: { thin: 0.15, tick: 0.25, line: 0.35, target: 0.5 },
  calloutPadMm: 0.8,
  markBarWidthMm: 6,              // black mark drawn under the pointer, across
  platenHalfWidthMm: 34,          // roller and tear edge, drawn wider than the widest web
  legendY: [63.4, 65.7],          // "Trägerbreite …" / "Lage bei offener Führung …", below the tear edge
  breakZigzagMm: 1.2,
  tearToothMm: 2,
  approxGapMm: 1.2,               // "≈" after the number 5 while `measured` is false
  arrowHeadMm: 1,
  // measuring-pattern preview (label to scale plus room for the dimension arrows)
  patternPreview: {
    // text grows with the label so a 99 mm label previewed on a phone stays readable;
    // paddings and arrow offsets follow the text size
    textSizeMm: 2.6, textPerLength: 0.045, paddingEm: 2.7, arrowOffsetEm: 1.35, extensionEm: 0.4,
    rulerTickMm: 1.5,
    // letter placement of the printed pattern (§4.11: 1 / 4 mm, physical at 300 dpi)
    letterInsetMm: 1, letterShiftMm: 4, rulerBaselineGapMm: 1, rulerStepMm: 10, crossArmMm: 3,
    continuousLineMm: 0.17,
  },
} as const;

/** Scale reading → x in mm (0 = centre line), rounded to 0,1 mm: 3.4 → 4, 2.5 → −5. */
export const scaleToX = (reading: number): number =>
  Math.round((reading - SENSOR_GEOMETRY.scaleCentre) * SENSOR_GEOMETRY.scaleUnitMm * 10) / 10;
