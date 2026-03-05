/**
 * Import Standard MIDI File (SMF Format 0/1) to ScoreData.
 * Pure TypeScript, no external dependencies.
 */

import {
  ScoreData,
  DetectedNote,
  Measure,
  DurationType,
  DURATION_BEATS,
} from "../types";
import {
  midiToNoteName,
  midiToFrequency,
  quantizeDuration,
  detectKey,
  chooseClef,
  quantizeStartTimes,
  splitIntoMeasures,
  detectDownbeatOffset,
} from "./musicTheory";

/** Read a variable-length quantity. Returns [value, bytesConsumed]. */
function readVLQ(data: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let bytesRead = 0;
  let b: number;
  do {
    b = data[offset + bytesRead];
    value = (value << 7) | (b & 0x7f);
    bytesRead++;
  } while (b & 0x80);
  return [value, bytesRead];
}

/** Read a 16-bit big-endian value. */
function read16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

/** Read a 32-bit big-endian value. */
function read32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) >>> 0) |
    (data[offset + 1] << 16) |
    (data[offset + 2] << 8) |
    data[offset + 3]
  ) >>> 0;
}

/** Read a 24-bit big-endian value. */
function read24(data: Uint8Array, offset: number): number {
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
}

interface RawNote {
  midi: number;
  startTick: number;
  endTick: number;
  velocity: number;
}

interface TempoEvent {
  tick: number;
  usPerQuarter: number;
}

interface TimeSigEvent {
  tick: number;
  numerator: number;
  denominator: number;
}

interface KeySigEvent {
  tick: number;
  sf: number; // -7..7
  mi: number; // 0=major, 1=minor
}

interface ParsedTrack {
  notes: RawNote[];
  tempos: TempoEvent[];
  timeSigs: TimeSigEvent[];
  keySigs: KeySigEvent[];
}

/** Parse a single MIDI track chunk. */
function parseTrack(data: Uint8Array, start: number, length: number): ParsedTrack {
  const notes: RawNote[] = [];
  const tempos: TempoEvent[] = [];
  const timeSigs: TimeSigEvent[] = [];
  const keySigs: KeySigEvent[] = [];

  // Track active notes for pairing Note On/Off
  const activeNotes = new Map<number, { tick: number; velocity: number }>();

  let offset = start;
  const end = start + length;
  let absoluteTick = 0;
  let runningStatus = 0;

  while (offset < end) {
    // Read delta time
    const [delta, vlqLen] = readVLQ(data, offset);
    offset += vlqLen;
    absoluteTick += delta;

    // Read event
    let statusByte = data[offset];

    if (statusByte < 0x80) {
      // Running status: reuse previous status byte
      statusByte = runningStatus;
    } else {
      offset++;
      if (statusByte < 0xf0) {
        runningStatus = statusByte;
      }
    }

    const eventType = statusByte & 0xf0;

    if (statusByte === 0xff) {
      // Meta event
      const metaType = data[offset++];
      const [metaLen, metaVlqLen] = readVLQ(data, offset);
      offset += metaVlqLen;

      if (metaType === 0x51 && metaLen === 3) {
        // Set Tempo
        tempos.push({ tick: absoluteTick, usPerQuarter: read24(data, offset) });
      } else if (metaType === 0x58 && metaLen >= 2) {
        // Time Signature
        timeSigs.push({
          tick: absoluteTick,
          numerator: data[offset],
          denominator: 1 << data[offset + 1],
        });
      } else if (metaType === 0x59 && metaLen === 2) {
        // Key Signature
        const sf = data[offset] > 127 ? data[offset] - 256 : data[offset]; // signed
        keySigs.push({ tick: absoluteTick, sf, mi: data[offset + 1] });
      }

      offset += metaLen;
    } else if (statusByte === 0xf0 || statusByte === 0xf7) {
      // SysEx event
      const [sysexLen, sysexVlqLen] = readVLQ(data, offset);
      offset += sysexVlqLen + sysexLen;
    } else if (eventType === 0x90) {
      // Note On
      const note = data[offset++];
      const velocity = data[offset++];
      if (velocity === 0) {
        // Note On with velocity 0 = Note Off
        const active = activeNotes.get(note);
        if (active) {
          notes.push({
            midi: note,
            startTick: active.tick,
            endTick: absoluteTick,
            velocity: active.velocity,
          });
          activeNotes.delete(note);
        }
      } else {
        // Close any existing note on same pitch (re-trigger)
        const existing = activeNotes.get(note);
        if (existing) {
          notes.push({
            midi: note,
            startTick: existing.tick,
            endTick: absoluteTick,
            velocity: existing.velocity,
          });
        }
        activeNotes.set(note, { tick: absoluteTick, velocity });
      }
    } else if (eventType === 0x80) {
      // Note Off
      const note = data[offset++];
      offset++; // velocity (ignored)
      const active = activeNotes.get(note);
      if (active) {
        notes.push({
          midi: note,
          startTick: active.tick,
          endTick: absoluteTick,
          velocity: active.velocity,
        });
        activeNotes.delete(note);
      }
    } else if (
      eventType === 0xa0 || // Aftertouch
      eventType === 0xb0 || // Control Change
      eventType === 0xe0    // Pitch Bend
    ) {
      offset += 2;
    } else if (
      eventType === 0xc0 || // Program Change
      eventType === 0xd0    // Channel Pressure
    ) {
      offset += 1;
    }
  }

  return { notes, tempos, timeSigs, keySigs };
}

/** Convert tick to seconds using tempo map. */
function tickToSeconds(
  tick: number,
  ticksPerQuarter: number,
  tempos: TempoEvent[],
): number {
  let seconds = 0;
  let prevTick = 0;
  let usPerQuarter = 500_000; // default 120 BPM

  for (const t of tempos) {
    if (t.tick > tick) break;
    seconds += ((t.tick - prevTick) / ticksPerQuarter) * (usPerQuarter / 1_000_000);
    prevTick = t.tick;
    usPerQuarter = t.usPerQuarter;
  }

  seconds += ((tick - prevTick) / ticksPerQuarter) * (usPerQuarter / 1_000_000);
  return seconds;
}

/** Rest duration types, largest first. */
const REST_TYPES: DurationType[] = ["whole", "half", "quarter", "eighth", "sixteenth", "thirty_second"];

function makeRest(startTime: number, durationSec: number, durationType: DurationType, dotted: boolean): DetectedNote {
  return {
    midi: -1,
    name: "rest",
    startTime,
    duration: durationSec,
    durationType,
    dotted,
    frequency: 0,
    amplitude: 0,
  };
}

function emitRests(out: DetectedNote[], from: number, to: number, beatDur: number): void {
  let cursor = from;
  const tolerance = beatDur * 0.06;
  for (const rt of REST_TYPES) {
    const beats = DURATION_BEATS[rt];
    const dur = beats * beatDur;
    while (cursor + dur <= to + tolerance) {
      out.push(makeRest(cursor, dur, rt, false));
      cursor += dur;
    }
  }
}

function fillRests(measures: Measure[], bpm: number, beatsPerMeasure: number, downbeatOffset: number): void {
  const beatDur = 60 / bpm;
  const measureDur = beatDur * beatsPerMeasure;

  for (const measure of measures) {
    const measureStart = downbeatOffset + (measure.number - 1) * measureDur;
    const measureEnd = measureStart + measureDur;
    const filled: DetectedNote[] = [];
    let cursor = measureStart;

    const sorted = [...measure.notes].sort((a, b) => a.startTime - b.startTime);

    let i = 0;
    while (i < sorted.length) {
      const noteStart = sorted[i].startTime;

      if (noteStart > cursor + beatDur * 0.06) {
        emitRests(filled, cursor, noteStart, beatDur);
      }

      let maxEnd = 0;
      while (i < sorted.length && Math.abs(sorted[i].startTime - noteStart) < beatDur * 0.06) {
        filled.push(sorted[i]);
        const noteEnd = sorted[i].startTime + sorted[i].duration;
        if (noteEnd > maxEnd) maxEnd = noteEnd;
        i++;
      }
      cursor = Math.max(cursor, maxEnd);
    }

    if (measureEnd > cursor + beatDur * 0.06) {
      emitRests(filled, cursor, measureEnd, beatDur);
    }

    measure.notes = filled;
  }
}

/**
 * Parse a Standard MIDI File (Format 0 or 1) into ScoreData.
 */
export function parseMidi(data: Uint8Array): ScoreData {
  // Validate header
  if (
    data[0] !== 0x4d || data[1] !== 0x54 ||
    data[2] !== 0x68 || data[3] !== 0x64
  ) {
    throw new Error("Not a valid MIDI file (missing MThd header)");
  }

  const headerLen = read32(data, 4);
  const format = read16(data, 8);
  const numTracks = read16(data, 10);
  const ticksPerQuarter = read16(data, 12);

  if (format > 1) {
    throw new Error(`Unsupported MIDI format ${format} (only 0 and 1 supported)`);
  }

  // Parse all tracks
  let offset = 8 + headerLen;
  const allNotes: RawNote[] = [];
  const allTempos: TempoEvent[] = [];
  const allTimeSigs: TimeSigEvent[] = [];
  const allKeySigs: KeySigEvent[] = [];

  for (let t = 0; t < numTracks; t++) {
    if (
      data[offset] !== 0x4d || data[offset + 1] !== 0x54 ||
      data[offset + 2] !== 0x72 || data[offset + 3] !== 0x6b
    ) {
      throw new Error(`Invalid track chunk at offset ${offset}`);
    }
    const trackLen = read32(data, offset + 4);
    const track = parseTrack(data, offset + 8, trackLen);

    allNotes.push(...track.notes);
    allTempos.push(...track.tempos);
    allTimeSigs.push(...track.timeSigs);
    allKeySigs.push(...track.keySigs);

    offset += 8 + trackLen;
  }

  // Sort tempos by tick
  allTempos.sort((a, b) => a.tick - b.tick);

  // Determine BPM from first tempo event
  const bpm = allTempos.length > 0
    ? Math.round(60_000_000 / allTempos[0].usPerQuarter)
    : 120;

  // Determine time signature from first event
  const beatsPerMeasure = allTimeSigs.length > 0 ? allTimeSigs[0].numerator : 4;
  const beatUnit = allTimeSigs.length > 0 ? allTimeSigs[0].denominator : 4;

  // Determine key signature
  let key: ScoreData["key"];
  if (allKeySigs.length > 0) {
    const ks = allKeySigs[0];
    const sfToRoot: Record<number, string> = {
      "-7": "Cb", "-6": "Gb", "-5": "Db", "-4": "Ab", "-3": "Eb",
      "-2": "Bb", "-1": "F", "0": "C", "1": "G", "2": "D",
      "3": "A", "4": "E", "5": "B", "6": "F#", "7": "C#",
    };
    const sfToMinorRoot: Record<number, string> = {
      "-7": "Ab", "-6": "Eb", "-5": "Bb", "-4": "F", "-3": "C",
      "-2": "G", "-1": "D", "0": "A", "1": "E", "2": "B",
      "3": "F#", "4": "C#", "5": "G#", "6": "D#", "7": "A#",
    };
    const root = ks.mi === 1 ? sfToMinorRoot[ks.sf] : sfToRoot[ks.sf];
    key = {
      root: root ?? "C",
      mode: ks.mi === 1 ? "minor" : "major",
      accidentals: ks.sf,
    };
  } else {
    key = detectKey(allNotes.map((n) => n.midi));
  }

  // Convert raw notes to DetectedNote[]
  const beatDuration = 60 / bpm;

  const detectedNotes: DetectedNote[] = allNotes
    .sort((a, b) => a.startTick - b.startTick || a.midi - b.midi)
    .map((raw) => {
      const startTime = tickToSeconds(raw.startTick, ticksPerQuarter, allTempos);
      const endTime = tickToSeconds(raw.endTick, ticksPerQuarter, allTempos);
      const duration = endTime - startTime;
      const { type: durationType, dotted } = quantizeDuration(duration, bpm);

      return {
        midi: raw.midi,
        name: midiToNoteName(raw.midi, key.accidentals < 0),
        startTime,
        duration,
        durationType,
        dotted,
        frequency: midiToFrequency(raw.midi),
        amplitude: raw.velocity / 127,
      };
    });

  if (detectedNotes.length === 0) {
    return {
      bpm,
      beatsPerMeasure,
      beatUnit,
      key,
      clef: "treble",
      measures: [],
      totalDuration: 0,
    };
  }

  // Determine clef
  const clef = chooseClef(detectedNotes.map((n) => n.midi));

  // Quantize start times to grid
  const onsetTimes = detectedNotes.map((n) => n.startTime);
  const downbeatOffset = detectDownbeatOffset(onsetTimes, bpm);
  const quantized = quantizeStartTimes(detectedNotes, bpm, downbeatOffset);

  // Split into measures
  const measures = splitIntoMeasures(quantized, bpm, beatsPerMeasure, downbeatOffset);

  // Fill rests
  fillRests(measures, bpm, beatsPerMeasure, downbeatOffset);

  const lastNote = quantized[quantized.length - 1];
  const totalDuration = lastNote.startTime + lastNote.duration;

  return {
    bpm,
    beatsPerMeasure,
    beatUnit,
    key,
    clef,
    measures,
    totalDuration,
    downbeatOffset,
  };
}
