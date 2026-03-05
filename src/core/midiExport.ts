/**
 * Export ScoreData to Standard MIDI File (SMF Format 0).
 * Pure TypeScript, no external dependencies.
 */

import { ScoreData, DURATION_BEATS } from "../types";

const TICKS_PER_QUARTER = 480;

/** Write a variable-length quantity (VLQ) used in MIDI delta times. */
function writeVLQ(value: number): number[] {
  if (value < 0) value = 0;
  const bytes: number[] = [];
  bytes.push(value & 0x7f);
  value >>= 7;
  while (value > 0) {
    bytes.push((value & 0x7f) | 0x80);
    value >>= 7;
  }
  bytes.reverse();
  return bytes;
}

/** Write a 16-bit big-endian value. */
function write16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

/** Write a 32-bit big-endian value. */
function write32(value: number): number[] {
  return [
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ];
}

/** Write a string as ASCII bytes. */
function writeStr(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

interface MidiEvent {
  absoluteTick: number;
  data: number[];
}

/** Key signature accidentals to MIDI key signature sf value. */
function keyToMidiSf(accidentals: number): number {
  // MIDI key signature: sf is signed byte (-7 to 7)
  return accidentals;
}

/**
 * Convert ScoreData to a Standard MIDI File (Format 0) as a Uint8Array.
 */
export function exportScoreToMidi(score: ScoreData): Uint8Array {
  const events: MidiEvent[] = [];
  const usPerQuarter = Math.round(60_000_000 / score.bpm);

  // Meta: Set Tempo
  events.push({
    absoluteTick: 0,
    data: [
      0xff, 0x51, 0x03,
      (usPerQuarter >> 16) & 0xff,
      (usPerQuarter >> 8) & 0xff,
      usPerQuarter & 0xff,
    ],
  });

  // Meta: Time Signature
  const numerator = score.beatsPerMeasure;
  const denominator = Math.round(Math.log2(score.beatUnit));
  events.push({
    absoluteTick: 0,
    data: [0xff, 0x58, 0x04, numerator, denominator, 24, 8],
  });

  // Meta: Key Signature
  const sf = keyToMidiSf(score.key.accidentals);
  const mi = score.key.mode === "minor" ? 1 : 0;
  events.push({
    absoluteTick: 0,
    data: [0xff, 0x59, 0x02, sf & 0xff, mi],
  });

  // Convert notes to MIDI events
  const beatDuration = 60 / score.bpm;
  const measureDuration = beatDuration * score.beatsPerMeasure;
  const downbeat = score.downbeatOffset ?? 0;

  for (const measure of score.measures) {
    const measureStart = downbeat + (measure.number - 1) * measureDuration;

    for (const note of measure.notes) {
      if (note.midi < 0) continue; // skip rests

      const noteStartSec = note.startTime;
      const beats = DURATION_BEATS[note.durationType] * (note.dotted ? 1.5 : 1);
      const noteDurationSec = beats * beatDuration;

      const startTick = Math.round(
        ((noteStartSec - downbeat) / beatDuration) * TICKS_PER_QUARTER,
      );
      const durationTicks = Math.round(beats * TICKS_PER_QUARTER);

      // Velocity: map amplitude (0-1) to MIDI velocity (1-127), default 80
      const velocity = note.amplitude > 0
        ? Math.max(1, Math.min(127, Math.round(note.amplitude * 127)))
        : 80;

      // Note On (channel 0)
      events.push({
        absoluteTick: Math.max(0, startTick),
        data: [0x90, note.midi, velocity],
      });

      // Note Off (channel 0)
      events.push({
        absoluteTick: Math.max(0, startTick + durationTicks),
        data: [0x80, note.midi, 0],
      });
    }
  }

  // Sort by absolute tick, then Note Off before Note On at same tick
  events.sort((a, b) => {
    if (a.absoluteTick !== b.absoluteTick) return a.absoluteTick - b.absoluteTick;
    const aIsOff = a.data[0] === 0x80 ? 0 : 1;
    const bIsOff = b.data[0] === 0x80 ? 0 : 1;
    return aIsOff - bIsOff;
  });

  // Meta: End of Track (after last event)
  const lastTick = events.length > 0 ? events[events.length - 1].absoluteTick : 0;
  events.push({
    absoluteTick: lastTick,
    data: [0xff, 0x2f, 0x00],
  });

  // Build track data with delta times
  const trackBytes: number[] = [];
  let prevTick = 0;
  for (const evt of events) {
    const delta = evt.absoluteTick - prevTick;
    trackBytes.push(...writeVLQ(delta));
    trackBytes.push(...evt.data);
    prevTick = evt.absoluteTick;
  }

  // Build complete MIDI file
  const fileBytes: number[] = [];

  // Header chunk: MThd
  fileBytes.push(...writeStr("MThd"));
  fileBytes.push(...write32(6)); // header length
  fileBytes.push(...write16(0)); // format 0
  fileBytes.push(...write16(1)); // 1 track
  fileBytes.push(...write16(TICKS_PER_QUARTER));

  // Track chunk: MTrk
  fileBytes.push(...writeStr("MTrk"));
  fileBytes.push(...write32(trackBytes.length));
  fileBytes.push(...trackBytes);

  return new Uint8Array(fileBytes);
}
