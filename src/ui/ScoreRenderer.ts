/**
 * Canvas 2D sheet music renderer.
 * Draws staff lines, clef, key signature, time signature, notes,
 * stems, flags, accidentals, ledger lines, and bar lines.
 */

import {
  ScoreData,
  DetectedNote,
  ClefType,
  KeySignature,
  Measure,
} from "../types";
import { midiToStaffPosition, getAccidental } from "../core/musicTheory";
import type { ChordAnnotation } from "../core/aiService";

/** Layout constants */
const STAFF_LINE_SPACING = 10; // pixels between staff lines
const STAFF_LINES = 5;
const STAFF_HEIGHT = STAFF_LINE_SPACING * (STAFF_LINES - 1); // 40px
const TOP_MARGIN = 50;
const BOTTOM_MARGIN = 30;
const LEFT_MARGIN = 15;
const RIGHT_MARGIN = 10;
const CLEF_WIDTH = 35;
const KEY_SIG_WIDTH = 14; // per accidental
const TIME_SIG_WIDTH = 24;
const NOTE_HEAD_RX = 5; // horizontal radius
const NOTE_HEAD_RY = 3.5; // vertical radius
const STEM_LENGTH = 30;
const FLAG_LENGTH = 12;
const BARLINE_GAP = 8; // space before/after barline
const SYSTEM_GAP = 70; // vertical gap between systems
const BAR_LINE_EXTRA = 2;

/** Duration-proportional width units (quarter note = 1.0) */
const DURATION_WIDTH: Record<string, number> = {
  whole: 3.0,
  half: 2.0,
  quarter: 1.0,
  eighth: 0.7,
  sixteenth: 0.5,
};

/** A beat position: one or more notes sharing the same startTime. */
interface BeatGroup {
  notes: DetectedNote[];
  durationType: string;
  dotted: boolean;
}

/** Tolerance for grouping simultaneous notes (seconds). */
const CHORD_TOLERANCE = 0.02;

/** Group measure notes into beat positions (chords share startTime). */
function groupBeats(notes: DetectedNote[]): BeatGroup[] {
  if (notes.length === 0) return [];
  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
  const groups: BeatGroup[] = [];
  let cur: DetectedNote[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].startTime - cur[0].startTime) <= CHORD_TOLERANCE) {
      cur.push(sorted[i]);
    } else {
      groups.push({
        notes: cur,
        durationType: cur[0].durationType,
        dotted: cur[0].dotted,
      });
      cur = [notes[i]];
    }
  }
  groups.push({
    notes: cur,
    durationType: cur[0].durationType,
    dotted: cur[0].dotted,
  });
  return groups;
}

/** Compute the width a beat group occupies in pixels given a base unit. */
function beatWidth(bg: BeatGroup, unit: number): number {
  const base = DURATION_WIDTH[bg.durationType] ?? 1.0;
  return (bg.dotted ? base * 1.3 : base) * unit;
}

/** Compute width of a measure in "beat units". */
function measureBeats(measure: Measure): number {
  const groups = groupBeats(measure.notes);
  let total = 0;
  for (const bg of groups) {
    const base = DURATION_WIDTH[bg.durationType] ?? 1.0;
    total += bg.dotted ? base * 1.3 : base;
  }
  return Math.max(total, 0.5);
}

export interface RenderOptions {
  width: number;
  backgroundColor?: string;
  staffColor?: string;
  noteColor?: string;
  chordAnnotations?: ChordAnnotation[];
}

const DEFAULT_OPTIONS: Required<RenderOptions> = {
  width: 800,
  backgroundColor: "#ffffff",
  staffColor: "#333333",
  noteColor: "#000000",
  chordAnnotations: [],
};

/**
 * Calculate required canvas dimensions for the score.
 */
/** Extra vertical space above each system when chord annotations are present. */
const CHORD_TOP_EXTRA = 15;

export function calculateSize(
  score: ScoreData,
  options: RenderOptions
): { width: number; height: number } {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const hasChords = opts.chordAnnotations && opts.chordAnnotations.length > 0;
  const topMargin = hasChords ? TOP_MARGIN + CHORD_TOP_EXTRA : TOP_MARGIN;
  const systemGap = hasChords ? SYSTEM_GAP + CHORD_TOP_EXTRA : SYSTEM_GAP;
  const { systems, canvasWidth } = layoutSystems(score, opts, topMargin, systemGap);
  const height = systems.length * (STAFF_HEIGHT + systemGap) + topMargin + BOTTOM_MARGIN;
  return { width: canvasWidth, height };
}

export interface SystemLayout {
  measures: Measure[];
  y: number; // top of staff
}

/**
 * Minimum noteUnit so the smallest note (sixteenth = 0.5 units) still
 * occupies enough pixels for a note head + accidental + padding.
 * MIN_NOTE_PX / smallest duration width = 24 / 0.5 = 48.
 */
const MIN_NOTE_UNIT = 48;

function layoutSystems(
  score: ScoreData,
  opts: Required<RenderOptions>,
  topMargin: number = TOP_MARGIN,
  systemGap: number = SYSTEM_GAP,
): { systems: SystemLayout[]; noteUnit: number; canvasWidth: number } {
  // Decoration width that appears on every system
  const decorWidth =
    LEFT_MARGIN + RIGHT_MARGIN + CLEF_WIDTH +
    Math.abs(score.key.accidentals) * KEY_SIG_WIDTH;
  // Time signature only on the first system
  const firstSystemExtra = TIME_SIG_WIDTH;

  const viewWidth = opts.width;
  const availableWidth = viewWidth - decorWidth;

  // Compute noteUnit targeting ~4 measures per system.
  const allBeats = score.measures.map(measureBeats);
  const avgBeats = allBeats.reduce((a, b) => a + b, 0) / Math.max(allBeats.length, 1);
  const targetMeasures = 4;
  const barlinePixels = targetMeasures * BARLINE_GAP * 2;
  const noteSpace = availableWidth - barlinePixels;
  let noteUnit = Math.max(MIN_NOTE_UNIT, noteSpace / (avgBeats * targetMeasures));
  // Cap upper bound so notes don't get absurdly wide
  noteUnit = Math.min(noteUnit, 60);

  // Pack measures into systems; if a single measure exceeds viewWidth, that's OK —
  // the canvas will be wider than the container and scroll horizontally.
  const systems: SystemLayout[] = [];
  let currentMeasures: Measure[] = [];
  let currentWidth = 0;
  let maxSystemWidth = 0;

  for (let i = 0; i < score.measures.length; i++) {
    const measure = score.measures[i];
    const mw = measureBeats(measure) * noteUnit + BARLINE_GAP * 2;
    const isFirstSystem = systems.length === 0;
    const maxWidth = isFirstSystem ? availableWidth - firstSystemExtra : availableWidth;
    if (currentWidth + mw > maxWidth && currentMeasures.length > 0) {
      maxSystemWidth = Math.max(maxSystemWidth, currentWidth + decorWidth +
        (systems.length === 0 ? firstSystemExtra : 0));
      systems.push({
        measures: currentMeasures,
        y: topMargin + systems.length * (STAFF_HEIGHT + systemGap),
      });
      currentMeasures = [];
      currentWidth = 0;
    }
    currentMeasures.push(measure);
    currentWidth += mw;
  }

  if (currentMeasures.length > 0) {
    maxSystemWidth = Math.max(maxSystemWidth, currentWidth + decorWidth +
      (systems.length === 0 ? firstSystemExtra : 0));
    systems.push({
      measures: currentMeasures,
      y: topMargin + systems.length * (STAFF_HEIGHT + systemGap),
    });
  }

  // Canvas width: at least the container width, but wider if any system needs it
  const canvasWidth = Math.max(viewWidth, maxSystemWidth);

  return { systems, noteUnit, canvasWidth };
}

/**
 * Expose layout information for external consumers (e.g. PDF export).
 */
export function getSystemLayouts(
  score: ScoreData,
  opts: RenderOptions,
): {
  systems: SystemLayout[];
  noteUnit: number;
  canvasWidth: number;
  staffHeight: number;
  systemGap: number;
  topMargin: number;
  bottomMargin: number;
} {
  const fullOpts = { ...DEFAULT_OPTIONS, ...opts };
  const hasChords = fullOpts.chordAnnotations && fullOpts.chordAnnotations.length > 0;
  const topM = hasChords ? TOP_MARGIN + CHORD_TOP_EXTRA : TOP_MARGIN;
  const sysGap = hasChords ? SYSTEM_GAP + CHORD_TOP_EXTRA : SYSTEM_GAP;
  const { systems, noteUnit, canvasWidth } = layoutSystems(score, fullOpts, topM, sysGap);
  return {
    systems,
    noteUnit,
    canvasWidth,
    staffHeight: STAFF_HEIGHT,
    systemGap: sysGap,
    topMargin: topM,
    bottomMargin: BOTTOM_MARGIN,
  };
}

/**
 * Render the complete score to a canvas context.
 */
export function renderScore(
  ctx: CanvasRenderingContext2D,
  score: ScoreData,
  options: RenderOptions
): void {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const hasChords = opts.chordAnnotations && opts.chordAnnotations.length > 0;
  const topMargin = hasChords ? TOP_MARGIN + CHORD_TOP_EXTRA : TOP_MARGIN;
  const systemGap = hasChords ? SYSTEM_GAP + CHORD_TOP_EXTRA : SYSTEM_GAP;
  const { systems, noteUnit, canvasWidth } = layoutSystems(score, opts, topMargin, systemGap);

  // Clear
  ctx.fillStyle = opts.backgroundColor;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Use canvasWidth for staff line right edge
  const renderOpts = { ...opts, width: canvasWidth };
  for (const system of systems) {
    renderSystem(ctx, score, system, renderOpts, noteUnit);
  }
}

function renderSystem(
  ctx: CanvasRenderingContext2D,
  score: ScoreData,
  system: SystemLayout,
  opts: Required<RenderOptions>,
  noteUnit: number,
): void {
  const staffTop = system.y;
  const staffLeft = LEFT_MARGIN;
  const staffRight = opts.width - RIGHT_MARGIN;

  // Draw staff lines
  drawStaffLines(ctx, staffLeft, staffTop, staffRight, opts.staffColor);

  // Draw clef
  let x = staffLeft + 5;
  drawClef(ctx, x, staffTop, score.clef, opts.noteColor);
  x += CLEF_WIDTH;

  // Draw key signature
  x = drawKeySignature(ctx, x, staffTop, score.key.accidentals, score.clef, opts.noteColor);

  // Draw time signature (only on first system)
  if (system.measures[0]?.number === 1) {
    drawTimeSignature(ctx, x, staffTop, score.beatsPerMeasure, score.beatUnit, opts.noteColor);
    x += TIME_SIG_WIDTH;
  }

  // Draw measures with proportional spacing
  let noteX = x + BARLINE_GAP;
  const chordAnns = opts.chordAnnotations ?? [];
  for (let mi = 0; mi < system.measures.length; mi++) {
    const measure = system.measures[mi];
    const beats = groupBeats(measure.notes);

    for (let beatIdx = 0; beatIdx < beats.length; beatIdx++) {
      const bg = beats[beatIdx];

      // Draw chord annotation if present
      if (chordAnns.length > 0) {
        const ann = chordAnns.find(
          (a) => a.measureNumber === measure.number && a.beatIndex === beatIdx,
        );
        if (ann) {
          drawChordName(ctx, noteX, staffTop, ann.chordName, opts.noteColor);
        }
      }

      // Draw all note heads + ledger lines + accidentals at the same x
      for (const note of bg.notes) {
        drawNoteHead_full(ctx, noteX, staffTop, note, score.clef, score.key, opts.noteColor);
      }
      // Draw a single shared stem/flags/dot for the beat group
      drawStemForGroup(ctx, noteX, staffTop, bg, score.clef, opts.noteColor);
      noteX += beatWidth(bg, noteUnit);
    }

    // Bar line
    if (mi < system.measures.length - 1) {
      noteX += BARLINE_GAP;
      drawBarLine(ctx, noteX, staffTop, opts.staffColor);
      noteX += BARLINE_GAP;
    }
  }

  // Final bar line (double)
  drawFinalBarLine(ctx, staffRight - 5, staffTop, opts.staffColor);
}

function drawStaffLines(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  right: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = 0; i < STAFF_LINES; i++) {
    const y = top + i * STAFF_LINE_SPACING;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
}

function drawClef(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  clef: ClefType,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.font = "bold 32px serif";
  ctx.textBaseline = "middle";

  if (clef === "treble") {
    // Draw treble clef using canvas paths (Unicode U+1D11E not available in most fonts)
    drawTrebleClef(ctx, x + 14, staffTop, color);
  } else {
    // Draw bass clef using canvas paths
    drawBassClef(ctx, x + 10, staffTop, color);
  }
}

/** Draw a simplified treble clef (G clef) using canvas paths */
function drawTrebleClef(
  ctx: CanvasRenderingContext2D,
  cx: number,
  staffTop: number,
  color: string
): void {
  const scale = STAFF_HEIGHT / 40;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.8 * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Main S-curve of the treble clef
  const baseY = staffTop + STAFF_HEIGHT / 2;
  ctx.beginPath();
  // Bottom curl
  ctx.moveTo(cx - 2 * scale, baseY + 18 * scale);
  ctx.quadraticCurveTo(cx - 8 * scale, baseY + 14 * scale, cx - 6 * scale, baseY + 8 * scale);
  ctx.quadraticCurveTo(cx - 4 * scale, baseY + 2 * scale, cx + 2 * scale, baseY - 2 * scale);
  // Upper curve
  ctx.quadraticCurveTo(cx + 10 * scale, baseY - 10 * scale, cx + 6 * scale, baseY - 18 * scale);
  ctx.quadraticCurveTo(cx + 2 * scale, baseY - 24 * scale, cx - 4 * scale, baseY - 20 * scale);
  // Back down through center
  ctx.quadraticCurveTo(cx - 8 * scale, baseY - 16 * scale, cx - 4 * scale, baseY - 6 * scale);
  ctx.quadraticCurveTo(cx - 1 * scale, baseY + 2 * scale, cx + 0 * scale, baseY + 10 * scale);
  ctx.stroke();

  // Vertical line through center
  ctx.beginPath();
  ctx.moveTo(cx, baseY - 22 * scale);
  ctx.lineTo(cx, baseY + 20 * scale);
  ctx.stroke();

  // Bottom circle
  ctx.beginPath();
  ctx.arc(cx - 1 * scale, baseY + 20 * scale, 2.5 * scale, 0, 2 * Math.PI);
  ctx.fill();

  ctx.restore();
}

/** Draw a simplified bass clef (F clef) using canvas paths */
function drawBassClef(
  ctx: CanvasRenderingContext2D,
  cx: number,
  staffTop: number,
  color: string
): void {
  const scale = STAFF_HEIGHT / 40;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.8 * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Main curve - starts from the 4th line (F line), curls down
  const baseY = staffTop + STAFF_LINE_SPACING; // 2nd line from top (F3)
  ctx.beginPath();
  ctx.arc(cx - 2 * scale, baseY, 3.5 * scale, 0, 2 * Math.PI);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(cx + 1 * scale, baseY);
  ctx.quadraticCurveTo(cx + 12 * scale, baseY + 2 * scale, cx + 10 * scale, baseY + 12 * scale);
  ctx.quadraticCurveTo(cx + 8 * scale, baseY + 22 * scale, cx - 2 * scale, baseY + 24 * scale);
  ctx.stroke();

  // Two dots (to the right of the curve)
  const dotX = cx + 14 * scale;
  ctx.beginPath();
  ctx.arc(dotX, baseY - 3 * scale, 1.5 * scale, 0, 2 * Math.PI);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(dotX, baseY + 7 * scale, 1.5 * scale, 0, 2 * Math.PI);
  ctx.fill();

  ctx.restore();
}

function drawKeySignature(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  accidentals: number,
  clef: ClefType,
  color: string
): number {
  if (accidentals === 0) return x;

  ctx.fillStyle = color;
  ctx.font = "16px serif";
  ctx.textBaseline = "middle";

  // Sharp positions on treble clef (line/space from top, 0-indexed)
  const sharpPositions = clef === "treble"
    ? [0, 1.5, -0.5, 1, 2.5, 0.5, 2]  // F C G D A E B
    : [2, 3.5, 1.5, 3, 4.5, 2.5, 4];   // Bass clef positions

  // Flat positions on treble clef
  const flatPositions = clef === "treble"
    ? [2, 0.5, 2.5, 1, 3, 1.5, 3.5]    // B E A D G C F
    : [4, 2.5, 4.5, 3, 5, 3.5, 5.5];

  const count = Math.abs(accidentals);
  const isSharp = accidentals > 0;
  const positions = isSharp ? sharpPositions : flatPositions;
  const symbol = isSharp ? "\u266F" : "\u266D"; // ♯ or ♭

  for (let i = 0; i < count && i < positions.length; i++) {
    const y = staffTop + positions[i] * STAFF_LINE_SPACING;
    ctx.fillText(symbol, x, y);
    x += KEY_SIG_WIDTH * 0.8;
  }

  return x + 5;
}

function drawTimeSignature(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  numerator: number,
  denominator: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.font = "bold 18px serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  const centerX = x + TIME_SIG_WIDTH / 2;
  ctx.fillText(String(numerator), centerX, staffTop + STAFF_HEIGHT * 0.25);
  ctx.fillText(String(denominator), centerX, staffTop + STAFF_HEIGHT * 0.75);
  ctx.textAlign = "left";
}

/** Convert a note's MIDI to Y coordinate on staff. */
function noteToY(midi: number, staffTop: number, clef: ClefType): number {
  const pos = midiToStaffPosition(midi);
  if (clef === "treble") {
    return staffTop + (10 - pos) * (STAFF_LINE_SPACING / 2);
  }
  // Bass clef: top line is A3 (diatonic position -2)
  return staffTop + (-2 - pos) * (STAFF_LINE_SPACING / 2);
}

/** Draw note head, ledger lines, and accidental (no stem/flags/dot). */
function drawNoteHead_full(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  note: DetectedNote,
  clef: ClefType,
  key: KeySignature,
  color: string
): void {
  if (note.midi < 0) return;

  const y = noteToY(note.midi, staffTop, clef);

  drawLedgerLines(ctx, x, y, staffTop, color);

  const accidental = getAccidental(note.midi, key);
  if (accidental) {
    drawAccidental(ctx, x - 12, y, accidental, color);
  }

  const filled = note.durationType !== "whole" && note.durationType !== "half";
  drawNoteHead(ctx, x, y, filled, color);
}

/** Draw a single shared stem, flags, and dot for a beat group (chord or single note). */
function drawStemForGroup(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  bg: BeatGroup,
  clef: ClefType,
  color: string
): void {
  const validNotes = bg.notes.filter((n) => n.midi >= 0);
  if (validNotes.length === 0) return;

  const ys = validNotes.map((n) => noteToY(n.midi, staffTop, clef));
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const avgY = (minY + maxY) / 2;

  // Stem direction: up if average note is below staff center
  const stemUp = avgY > staffTop + STAFF_HEIGHT / 2;

  if (bg.durationType !== "whole") {
    // Stem from the outermost note head to STEM_LENGTH beyond
    const stemBaseY = stemUp ? maxY : minY;
    const stemTipY = stemUp ? minY - STEM_LENGTH : maxY + STEM_LENGTH;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (stemUp) {
      ctx.moveTo(x + NOTE_HEAD_RX - 1, stemBaseY);
      ctx.lineTo(x + NOTE_HEAD_RX - 1, stemTipY);
    } else {
      ctx.moveTo(x - NOTE_HEAD_RX + 1, stemBaseY);
      ctx.lineTo(x - NOTE_HEAD_RX + 1, stemTipY);
    }
    ctx.stroke();

    // Flags at stem tip
    if (bg.durationType === "eighth" || bg.durationType === "sixteenth") {
      const numFlags = bg.durationType === "sixteenth" ? 2 : 1;
      // drawFlags expects the note Y that the stem was drawn from
      const flagNoteY = stemUp ? minY : maxY;
      drawFlags(ctx, x, flagNoteY, stemUp, numFlags, color);
    }
  }

  // Dot: draw beside the outermost note head (top for stem-up, bottom for stem-down)
  if (bg.dotted) {
    const dotY = stemUp ? minY : maxY;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + NOTE_HEAD_RX + 5, dotY, 1.5, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function drawNoteHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  filled: boolean,
  color: string
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.2); // slight tilt

  ctx.beginPath();
  ctx.ellipse(0, 0, NOTE_HEAD_RX, NOTE_HEAD_RY, 0, 0, 2 * Math.PI);

  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  ctx.restore();
}

function drawStem(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  up: boolean,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();

  if (up) {
    ctx.moveTo(x + NOTE_HEAD_RX - 1, y);
    ctx.lineTo(x + NOTE_HEAD_RX - 1, y - STEM_LENGTH);
  } else {
    ctx.moveTo(x - NOTE_HEAD_RX + 1, y);
    ctx.lineTo(x - NOTE_HEAD_RX + 1, y + STEM_LENGTH);
  }

  ctx.stroke();
}

function drawFlags(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  up: boolean,
  count: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;

  for (let i = 0; i < count; i++) {
    const offset = i * 6;
    ctx.beginPath();
    if (up) {
      const stemX = x + NOTE_HEAD_RX - 1;
      const stemTop = y - STEM_LENGTH + offset;
      ctx.moveTo(stemX, stemTop);
      ctx.quadraticCurveTo(
        stemX + 10,
        stemTop + FLAG_LENGTH * 0.4,
        stemX + 2,
        stemTop + FLAG_LENGTH
      );
    } else {
      const stemX = x - NOTE_HEAD_RX + 1;
      const stemBottom = y + STEM_LENGTH - offset;
      ctx.moveTo(stemX, stemBottom);
      ctx.quadraticCurveTo(
        stemX - 10,
        stemBottom - FLAG_LENGTH * 0.4,
        stemX - 2,
        stemBottom - FLAG_LENGTH
      );
    }
    ctx.stroke();
  }
}

function drawAccidental(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  type: string,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.font = "14px serif";
  ctx.textBaseline = "middle";

  let symbol = "";
  if (type === "#") symbol = "\u266F"; // ♯
  else if (type === "b") symbol = "\u266D"; // ♭
  else if (type === "n") symbol = "\u266E"; // ♮

  ctx.fillText(symbol, x, y);
}

function drawLedgerLines(
  ctx: CanvasRenderingContext2D,
  x: number,
  noteY: number,
  staffTop: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const staffBottom = staffTop + STAFF_HEIGHT;
  const lineLen = NOTE_HEAD_RX * 2 + 4;

  // Ledger lines above staff
  if (noteY < staffTop) {
    for (let ly = staffTop - STAFF_LINE_SPACING; ly >= noteY - 1; ly -= STAFF_LINE_SPACING) {
      ctx.beginPath();
      ctx.moveTo(x - lineLen / 2, ly);
      ctx.lineTo(x + lineLen / 2, ly);
      ctx.stroke();
    }
  }

  // Ledger lines below staff
  if (noteY > staffBottom) {
    for (let ly = staffBottom + STAFF_LINE_SPACING; ly <= noteY + 1; ly += STAFF_LINE_SPACING) {
      ctx.beginPath();
      ctx.moveTo(x - lineLen / 2, ly);
      ctx.lineTo(x + lineLen / 2, ly);
      ctx.stroke();
    }
  }

}

function drawBarLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, staffTop - BAR_LINE_EXTRA);
  ctx.lineTo(x, staffTop + STAFF_HEIGHT + BAR_LINE_EXTRA);
  ctx.stroke();
}

function drawFinalBarLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  color: string
): void {
  ctx.strokeStyle = color;
  // Thin line
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 5, staffTop - BAR_LINE_EXTRA);
  ctx.lineTo(x - 5, staffTop + STAFF_HEIGHT + BAR_LINE_EXTRA);
  ctx.stroke();
  // Thick line
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, staffTop - BAR_LINE_EXTRA);
  ctx.lineTo(x, staffTop + STAFF_HEIGHT + BAR_LINE_EXTRA);
  ctx.stroke();
}

/** Draw a chord name above the staff. */
function drawChordName(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  chordName: string,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = "bold 11px sans-serif";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText(chordName, x - 4, staffTop - 4);
  ctx.restore();
}

/**
 * Generate a text summary of the score for export.
 */
export function scoreToText(score: ScoreData): string {
  const lines: string[] = [];
  lines.push(`BPM: ${score.bpm}`);
  lines.push(`Key: ${score.key.root} ${score.key.mode}`);
  lines.push(`Time: ${score.beatsPerMeasure}/${score.beatUnit}`);
  lines.push(`Clef: ${score.clef}`);
  lines.push(`Measures: ${score.measures.length}`);
  lines.push(`Duration: ${score.totalDuration.toFixed(1)}s`);
  lines.push("");

  for (const measure of score.measures) {
    const beats = groupBeats(measure.notes);
    const tokens = beats.map((bg) => {
      const dot = bg.dotted ? "." : "";
      if (bg.notes.length === 1) {
        return `${bg.notes[0].name}${dot}(${bg.durationType})`;
      }
      // Chord: [C4,E4,G4](quarter)
      const names = bg.notes.map((n) => n.name).join(",");
      return `[${names}]${dot}(${bg.durationType})`;
    });
    lines.push(`M${measure.number}: ${tokens.join(" ")}`);
  }

  return lines.join("\n");
}
