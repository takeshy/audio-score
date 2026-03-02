/**
 * Parse a score text (as produced by scoreToText) back into ScoreData.
 *
 * Format:
 *   BPM: 120
 *   Key: C major
 *   Time: 4/4
 *   Clef: treble
 *   Measures: 10
 *   Duration: 30.0s
 *
 *   M1: C4(quarter) D4.(eighth) rest(quarter)
 *   M2: ...
 */

import {
  ScoreData,
  DetectedNote,
  Measure,
  DurationType,
  DURATION_BEATS,
  KeySignature,
  ClefType,
} from "../types";
import { midiToFrequency } from "./musicTheory";

const NOTE_NAME_TO_PC: Record<string, number> = {
  "C": 0, "C#": 1, "Db": 1,
  "D": 2, "D#": 3, "Eb": 3,
  "E": 4,
  "F": 5, "F#": 6, "Gb": 6,
  "G": 7, "G#": 8, "Ab": 8,
  "A": 9, "A#": 10, "Bb": 10,
  "B": 11,
};

/** Parse note name like "C#4", "Db5", "rest" into MIDI number. */
function noteNameToMidi(name: string): number {
  if (name === "rest") return -1;
  // Match: optional accidental + octave digit at end
  const m = name.match(/^([A-G][#b]?)(-?\d+)$/);
  if (!m) return -1;
  const pc = NOTE_NAME_TO_PC[m[1]];
  if (pc == null) return -1;
  const octave = parseInt(m[2], 10);
  return (octave + 1) * 12 + pc;
}

const VALID_DURATIONS = new Set<string>([
  "whole", "half", "quarter", "eighth", "sixteenth",
]);

/**
 * Parse a single note token like "C4(quarter)", "D#5.(eighth)",
 * or chord "[C4,E4,G4](quarter)".
 * Returns an array of notes (1 for single, multiple for chord).
 */
function parseNoteToken(
  token: string,
  startTime: number,
  bpm: number,
): DetectedNote[] | null {
  // Try chord format: [C4,E4,G4][.](durationType)
  const chordMatch = token.match(/^\[([^\]]+)\](\.)?\((\w+)\)$/);
  if (chordMatch) {
    const names = chordMatch[1].split(",").map((s) => s.trim());
    const dotted = chordMatch[2] === ".";
    const durationType = chordMatch[3];
    if (!VALID_DURATIONS.has(durationType)) return null;

    const beatDuration = 60 / bpm;
    const beats = DURATION_BEATS[durationType as DurationType] * (dotted ? 1.5 : 1);
    const duration = beats * beatDuration;

    return names.map((name) => {
      const midi = noteNameToMidi(name);
      return {
        midi,
        name,
        startTime,
        duration,
        durationType: durationType as DurationType,
        dotted,
        frequency: midi >= 0 ? midiToFrequency(midi) : 0,
        amplitude: 0.5,
      };
    });
  }

  // Single note format: NoteName[.](durationType)
  const m = token.match(/^(.+?)(\.)?\((\w+)\)$/);
  if (!m) return null;

  const name = m[1];
  const dotted = m[2] === ".";
  const durationType = m[3];

  if (!VALID_DURATIONS.has(durationType)) return null;

  const midi = noteNameToMidi(name);
  const beatDuration = 60 / bpm;
  const beats = DURATION_BEATS[durationType as DurationType] * (dotted ? 1.5 : 1);
  const duration = beats * beatDuration;

  return [{
    midi,
    name,
    startTime,
    duration,
    durationType: durationType as DurationType,
    dotted,
    frequency: midi >= 0 ? midiToFrequency(midi) : 0,
    amplitude: 0.5,
  }];
}

/** Parse key line like "D major" or "Ab minor". */
function parseKey(str: string): KeySignature {
  const parts = str.trim().split(/\s+/);
  const root = parts[0] || "C";
  const mode = (parts[1] === "minor" ? "minor" : "major") as "major" | "minor";

  const accidentalMap: Record<string, number> = {
    "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5,
    "F#": 6, "Gb": -6,
    "F": -1, "Bb": -2, "Eb": -3, "Ab": -4, "Db": -5,
  };
  let accidentals = accidentalMap[root] ?? 0;
  if (mode === "minor") {
    // Relative major
    const minorRootPc = NOTE_NAME_TO_PC[root] ?? 0;
    const majorRootPc = (minorRootPc + 3) % 12;
    const majorNames = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
    accidentals = accidentalMap[majorNames[majorRootPc]] ?? 0;
  }

  return { root, mode, accidentals };
}

/**
 * Parse score text into ScoreData. Returns null if the text is not valid.
 */
export function parseScoreText(text: string): ScoreData | null {
  const lines = text.split("\n").map((l) => l.trim());

  // Parse header
  let bpm = 120;
  let beatsPerMeasure = 4;
  let beatUnit = 4;
  let clef: ClefType = "treble";
  let totalDuration = 0;
  let key: KeySignature = { root: "C", mode: "major", accidentals: 0 };

  for (const line of lines) {
    if (line.startsWith("BPM:")) {
      bpm = parseInt(line.slice(4).trim(), 10) || 120;
    } else if (line.startsWith("Key:")) {
      key = parseKey(line.slice(4));
    } else if (line.startsWith("Time:")) {
      const tm = line.slice(5).trim().match(/^(\d+)\/(\d+)$/);
      if (tm) {
        beatsPerMeasure = parseInt(tm[1], 10);
        beatUnit = parseInt(tm[2], 10);
      }
    } else if (line.startsWith("Clef:")) {
      const c = line.slice(5).trim().toLowerCase();
      clef = c === "bass" ? "bass" : "treble";
    } else if (line.startsWith("Duration:")) {
      totalDuration = parseFloat(line.slice(9).trim()) || 0;
    }
  }

  // Parse measures
  const measures: Measure[] = [];
  const beatDuration = 60 / bpm;
  const measureDuration = beatDuration * beatsPerMeasure;
  let hasMeasures = false;

  for (const line of lines) {
    const mm = line.match(/^M(\d+):\s*(.*)$/);
    if (!mm) continue;
    hasMeasures = true;

    const measureNum = parseInt(mm[1], 10);
    const measureStartTime = (measureNum - 1) * measureDuration;
    // Tokenize: split on whitespace but keep [...] groups intact
    const tokens: string[] = [];
    const raw = mm[2].trim();
    const tokenRe = /\[[^\]]*\]\S*|\S+/g;
    let tm;
    while ((tm = tokenRe.exec(raw)) !== null) {
      tokens.push(tm[0]);
    }

    const notes: DetectedNote[] = [];
    let offset = measureStartTime;

    for (const tok of tokens) {
      const parsed = parseNoteToken(tok, offset, bpm);
      if (parsed) {
        notes.push(...parsed);
        // Advance offset by the first note's duration (chord notes share duration)
        offset += parsed[0].duration;
      }
    }

    measures.push({ number: measureNum, notes, totalBeats: beatsPerMeasure });
  }

  if (!hasMeasures) return null;

  return { bpm, beatsPerMeasure, beatUnit, key, clef, measures, totalDuration };
}
