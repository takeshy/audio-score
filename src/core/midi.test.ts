import { describe, it, expect } from "vitest";
import { exportScoreToMidi } from "./midiExport";
import { parseMidi } from "./midiImport";
import { ScoreData } from "../types";

function makeScore(overrides: Partial<ScoreData> = {}): ScoreData {
  return {
    bpm: 120,
    beatsPerMeasure: 4,
    beatUnit: 4,
    key: { root: "C", mode: "major", accidentals: 0 },
    clef: "treble",
    measures: [
      {
        number: 1,
        totalBeats: 4,
        notes: [
          { midi: 60, name: "C4", startTime: 0, duration: 0.5, durationType: "quarter", dotted: false, frequency: 261.63, amplitude: 0.8 },
          { midi: 62, name: "D4", startTime: 0.5, duration: 0.5, durationType: "quarter", dotted: false, frequency: 293.66, amplitude: 0.7 },
          { midi: 64, name: "E4", startTime: 1.0, duration: 0.5, durationType: "quarter", dotted: false, frequency: 329.63, amplitude: 0.75 },
          { midi: 65, name: "F4", startTime: 1.5, duration: 0.5, durationType: "quarter", dotted: false, frequency: 349.23, amplitude: 0.6 },
        ],
      },
    ],
    totalDuration: 2.0,
    ...overrides,
  };
}

describe("MIDI export", () => {
  it("produces a valid MIDI file header", () => {
    const score = makeScore();
    const midi = exportScoreToMidi(score);

    // MThd header
    expect(String.fromCharCode(midi[0], midi[1], midi[2], midi[3])).toBe("MThd");
    // Header length = 6
    expect((midi[4] << 24) | (midi[5] << 16) | (midi[6] << 8) | midi[7]).toBe(6);
    // Format 0
    expect((midi[8] << 8) | midi[9]).toBe(0);
    // 1 track
    expect((midi[10] << 8) | midi[11]).toBe(1);
    // 480 ticks per quarter
    expect((midi[12] << 8) | midi[13]).toBe(480);
    // MTrk header
    expect(String.fromCharCode(midi[14], midi[15], midi[16], midi[17])).toBe("MTrk");
  });

  it("skips rest notes", () => {
    const score = makeScore({
      measures: [
        {
          number: 1,
          totalBeats: 4,
          notes: [
            { midi: -1, name: "rest", startTime: 0, duration: 0.5, durationType: "quarter", dotted: false, frequency: 0, amplitude: 0 },
            { midi: 60, name: "C4", startTime: 0.5, duration: 0.5, durationType: "quarter", dotted: false, frequency: 261.63, amplitude: 0.8 },
          ],
        },
      ],
    });
    const midi = exportScoreToMidi(score);
    // Should contain exactly 1 note on and 1 note off (not 2)
    let noteOnCount = 0;
    for (let i = 14; i < midi.length; i++) {
      if (midi[i] === 0x90) noteOnCount++;
    }
    expect(noteOnCount).toBe(1);
  });
});

describe("MIDI import", () => {
  it("round-trips export then import preserving notes", () => {
    const original = makeScore();
    const midiData = exportScoreToMidi(original);
    const imported = parseMidi(midiData);

    expect(imported.bpm).toBe(120);
    expect(imported.beatsPerMeasure).toBe(4);
    expect(imported.beatUnit).toBe(4);
    expect(imported.key.accidentals).toBe(0);
    expect(imported.key.mode).toBe("major");

    // Count non-rest notes
    const importedNotes = imported.measures
      .flatMap((m) => m.notes)
      .filter((n) => n.midi >= 0);
    expect(importedNotes.length).toBe(4);

    // Check MIDI note numbers are preserved
    const midiNumbers = importedNotes.map((n) => n.midi).sort();
    expect(midiNumbers).toEqual([60, 62, 64, 65]);
  });

  it("rejects invalid data", () => {
    expect(() => parseMidi(new Uint8Array([0, 0, 0, 0]))).toThrow("Not a valid MIDI file");
  });

  it("handles empty score", () => {
    const score = makeScore({ measures: [] });
    const midiData = exportScoreToMidi(score);
    const imported = parseMidi(midiData);
    expect(imported.measures.length).toBe(0);
  });

  it("preserves key signature with sharps", () => {
    const score = makeScore({
      key: { root: "G", mode: "major", accidentals: 1 },
    });
    const midiData = exportScoreToMidi(score);
    const imported = parseMidi(midiData);
    expect(imported.key.accidentals).toBe(1);
    expect(imported.key.mode).toBe("major");
  });

  it("preserves key signature with flats", () => {
    const score = makeScore({
      key: { root: "F", mode: "major", accidentals: -1 },
    });
    const midiData = exportScoreToMidi(score);
    const imported = parseMidi(midiData);
    expect(imported.key.accidentals).toBe(-1);
    expect(imported.key.mode).toBe("major");
  });

  it("preserves minor key", () => {
    const score = makeScore({
      key: { root: "A", mode: "minor", accidentals: 0 },
    });
    const midiData = exportScoreToMidi(score);
    const imported = parseMidi(midiData);
    expect(imported.key.accidentals).toBe(0);
    expect(imported.key.mode).toBe("minor");
  });

  it("preserves time signature", () => {
    const score = makeScore({
      beatsPerMeasure: 3,
      beatUnit: 8,
      measures: [
        {
          number: 1,
          totalBeats: 3,
          notes: [
            { midi: 60, name: "C4", startTime: 0, duration: 0.25, durationType: "eighth", dotted: false, frequency: 261.63, amplitude: 0.8 },
          ],
        },
      ],
    });
    const midiData = exportScoreToMidi(score);
    const imported = parseMidi(midiData);
    expect(imported.beatsPerMeasure).toBe(3);
    expect(imported.beatUnit).toBe(8);
  });
});
