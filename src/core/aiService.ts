/**
 * AI service functions using Gemini API for score analysis and transformation.
 */

import { ScoreData, ChordAnnotation, Measure, DetectedNote } from "../types";
import { scoreToText } from "../ui/ScoreRenderer";
import { parseScoreText, measuresToText } from "./scoreParser";

export type { ChordAnnotation };

export interface GeminiAPI {
  chat(
    messages: Array<{ role: string; content: string }>,
    options?: { model?: string; systemPrompt?: string },
  ): Promise<string>;
}

export type SimplificationType = "melody" | "bass" | "simplified";

/**
 * Analyze chords in the score and return chord annotations.
 */
export async function analyzeChords(
  gemini: GeminiAPI,
  score: ScoreData,
): Promise<ChordAnnotation[]> {
  const text = scoreToText(score);
  const response = await gemini.chat(
    [
      {
        role: "user",
        content: text,
      },
    ],
    {
      systemPrompt: `You are a music theory expert. Analyze the following score and identify the chord at each beat position.
Return ONLY a JSON array with no other text. Each element should have:
- "measureNumber": the measure number (integer, 1-based)
- "beatIndex": the beat index within the measure (integer, 0-based)
- "chordName": the chord symbol (e.g. "C", "Am", "G7", "Dm7", "F#dim")

Analyze the harmony by looking at the notes sounding at each beat position. Group consecutive beats with the same chord.
Only output one chord annotation per chord change, not for every single beat.

Example output:
[{"measureNumber":1,"beatIndex":0,"chordName":"C"},{"measureNumber":2,"beatIndex":0,"chordName":"G7"}]`,
    },
  );

  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown) =>
        item &&
        typeof item === "object" &&
        typeof (item as ChordAnnotation).measureNumber === "number" &&
        typeof (item as ChordAnnotation).beatIndex === "number" &&
        typeof (item as ChordAnnotation).chordName === "string",
    ) as ChordAnnotation[];
  } catch {
    return [];
  }
}

/**
 * Analyze the music and return a markdown analysis.
 */
export async function analyzeMusic(
  gemini: GeminiAPI,
  score: ScoreData,
  lang: string,
): Promise<string> {
  const text = scoreToText(score);
  const isJa = lang.startsWith("ja");
  const response = await gemini.chat(
    [
      {
        role: "user",
        content: text,
      },
    ],
    {
      systemPrompt: isJa
        ? `あなたは音楽分析の専門家です。以下の楽譜を分析して、Markdown形式で以下の項目を説明してください：
- **構造**: セクション分け（イントロ、Aメロ、Bメロ、サビなど）と対応する小節番号
- **コード進行**: 主要なコード進行パターンとその特徴
- **メロディの特徴**: 音域、動き、特徴的なフレーズ
- **リズムの特徴**: リズムパターン、シンコペーション
- **全体的な雰囲気**: 曲の印象、ジャンルの推測

簡潔に、わかりやすく記述してください。`
        : `You are a music analysis expert. Analyze the following score and provide a Markdown-formatted analysis covering:
- **Structure**: Section breakdown (intro, verse, chorus, etc.) with measure numbers
- **Chord Progression**: Main chord progression patterns and their characteristics
- **Melody**: Range, movement, characteristic phrases
- **Rhythm**: Rhythmic patterns, syncopation
- **Overall Character**: Mood, genre estimation

Be concise and clear.`,
    },
  );

  return response;
}

/**
 * Simplify the score (melody only, bass only, or simplified arrangement).
 */
export async function simplifyScore(
  gemini: GeminiAPI,
  score: ScoreData,
  type: SimplificationType,
): Promise<ScoreData | null> {
  const text = scoreToText(score);

  const instructions: Record<SimplificationType, string> = {
    melody: `Extract only the melody (highest note) from each beat position. Remove all harmony/accompaniment notes.
Keep the same rhythm and structure. Return single notes only, no chords.`,
    bass: `Extract only the bass line (lowest note) from each beat position. Remove all melody/harmony notes.
Keep the same rhythm and structure. Return single notes only, no chords.`,
    simplified: `Simplify this score for a beginner:
- Simplify complex rhythms (convert sixteenth notes to eighth notes, remove dotted rhythms)
- Reduce chords to single notes (keep the melody)
- Keep the overall structure and key intact
- Make it playable for a beginner musician`,
  };

  const response = await gemini.chat(
    [
      {
        role: "user",
        content: text,
      },
    ],
    {
      systemPrompt: `You are a music arrangement expert. ${instructions[type]}

Return the result in EXACTLY the same text format as the input. Do not add explanations.
Keep the header (BPM, Key, Time, Clef, Measures, Duration) and all measure lines (M1:, M2:, etc.).`,
    },
  );

  return parseScoreText(response);
}

/**
 * Algorithmic pre-filter: removes clear ML artifacts before LLM processing.
 * 1. Octave duplicates: simultaneous notes (startTime diff ≤ 0.02s) with MIDI diff = 12;
 *    keep the one with higher amplitude.
 * 2. Low-amplitude ghost notes: amplitude below 10th percentile AND < 0.3.
 */
export function algorithmicFilter(score: ScoreData): ScoreData {
  // Collect all amplitudes to compute 10th percentile
  const allAmplitudes: number[] = [];
  for (const m of score.measures) {
    for (const n of m.notes) {
      if (n.midi >= 0) allAmplitudes.push(n.amplitude);
    }
  }
  allAmplitudes.sort((a, b) => a - b);
  const p10 = allAmplitudes.length > 0
    ? allAmplitudes[Math.floor(allAmplitudes.length * 0.1)]
    : 0;

  const filteredMeasures = score.measures.map((measure) => {
    const removed = new Set<number>(); // indices to remove

    const notes = measure.notes;

    // 1. Octave duplicate removal (only when amplitude ratio < 0.5 — artifact, not intentional octave voicing)
    for (let i = 0; i < notes.length; i++) {
      if (removed.has(i)) continue;
      for (let j = i + 1; j < notes.length; j++) {
        if (removed.has(j)) continue;
        if (Math.abs(notes[i].startTime - notes[j].startTime) > 0.02) continue;
        const midiDiff = Math.abs(notes[i].midi - notes[j].midi);
        if (midiDiff === 12) {
          const ampMax = Math.max(notes[i].amplitude, notes[j].amplitude);
          const ampMin = Math.min(notes[i].amplitude, notes[j].amplitude);
          const ratio = ampMax > 0 ? ampMin / ampMax : 1;
          // Only remove if one note is much quieter (likely a harmonic artifact)
          if (ratio < 0.5) {
            if (notes[i].amplitude >= notes[j].amplitude) {
              removed.add(j);
            } else {
              removed.add(i);
            }
          }
        }
      }
    }

    // 2. Low-amplitude ghost note removal
    for (let i = 0; i < notes.length; i++) {
      if (removed.has(i)) continue;
      if (notes[i].midi >= 0 && notes[i].amplitude <= p10 && notes[i].amplitude < 0.3) {
        removed.add(i);
      }
    }

    const keptNotes = notes.filter((_, idx) => !removed.has(idx));
    return { ...measure, notes: keptNotes };
  });

  return { ...score, measures: filteredMeasures };
}

/**
 * Filter an original measure using the LLM's output as a mask.
 * Keeps original DetectedNote objects (preserving amplitude, startTime, duration)
 * but removes notes that the LLM removed.
 */
function filterMeasureByMask(original: Measure, mask: Measure): Measure {
  // Build a multiset of (name, durationType, dotted) from mask notes
  const maskCounts = new Map<string, number>();
  for (const note of mask.notes) {
    const key = `${note.name}|${note.durationType}|${note.dotted}`;
    maskCounts.set(key, (maskCounts.get(key) || 0) + 1);
  }

  const keptNotes: DetectedNote[] = [];
  for (const note of original.notes) {
    const key = `${note.name}|${note.durationType}|${note.dotted}`;
    const count = maskCounts.get(key) || 0;
    if (count > 0) {
      keptNotes.push(note);
      maskCounts.set(key, count - 1);
    }
  }

  return { ...original, notes: keptNotes };
}

/**
 * Improve score by removing ML artifacts in two stages:
 * 1. Algorithmic filter (octave duplicates, ghost notes) — fast & deterministic
 * 2. LLM refinement (harmonics, out-of-key noise) — conservative, with safety valve
 *
 * Sends measures to Gemini in batches of 20 with 2 measures of context on each side.
 * Safety valve: if LLM removes >30% of a measure's notes, the original (filtered) measure is kept.
 */
export async function improveScore(
  gemini: GeminiAPI,
  score: ScoreData,
  onProgress?: (completed: number, total: number, stage?: string) => void,
): Promise<ScoreData | null> {
  // Step 1: Algorithmic filter
  onProgress?.(0, 1, "filter");
  const filtered = algorithmicFilter(score);

  const BATCH_SIZE = 20;
  const CONTEXT_SIZE = 2;
  const measures = filtered.measures;
  const totalBatches = Math.ceil(measures.length / BATCH_SIZE);

  const header = `BPM: ${filtered.bpm} / Key: ${filtered.key.root} ${filtered.key.mode} / Time: ${filtered.beatsPerMeasure}/${filtered.beatUnit} / Clef: ${filtered.clef}`;

  const systemPrompt = `You are a music transcription quality expert. You receive measures from an ML-based pitch detector (basic-pitch) that have ALREADY been algorithmically filtered to remove octave duplicates and low-amplitude ghost notes.

Your task is to remove the REMAINING artifacts only:
1. NON-OCTAVE HARMONICS: Spurious notes at non-octave intervals (e.g. fifth, third) of a fundamental that don't fit the harmonic context. These appear as extra high notes above the real melody.
2. RESIDUAL GHOST NOTES: Short isolated notes that don't form a coherent musical phrase — likely false detections in otherwise silent passages.
3. OUT-OF-KEY NOISE: Isolated chromatic notes that don't fit the key signature and aren't intentional chromaticism (no chromatic approach or passing tone pattern).

IMPORTANT RULES:
- Octave duplicates are ALREADY removed — do NOT look for them.
- Be VERY CONSERVATIVE: when in doubt, KEEP the note.
- Remove at most 2–3 notes per measure. If a measure sounds fine, return it unchanged.
- Do NOT add new notes, change pitches, or modify rhythms.
- Do NOT modify CONTEXT measures (they are provided for reference only).
- Return ONLY the improved measures in the EXACT same text format (M1: ... M2: ...).
- Return the IMPROVE section measures only, not the context measures.`;

  const improvedMeasures: Measure[] = [];

  for (let batch = 0; batch < totalBatches; batch++) {
    const startIdx = batch * BATCH_SIZE;
    const endIdx = Math.min(startIdx + BATCH_SIZE, measures.length);
    const batchMeasures = measures.slice(startIdx, endIdx);

    // Context: up to CONTEXT_SIZE measures before/after
    const ctxBefore = measures.slice(Math.max(0, startIdx - CONTEXT_SIZE), startIdx);
    const ctxAfter = measures.slice(endIdx, Math.min(measures.length, endIdx + CONTEXT_SIZE));

    // Build prompt
    const parts: string[] = [header, ""];

    if (ctxBefore.length > 0) {
      parts.push("--- CONTEXT (do not modify) ---");
      parts.push(measuresToText(ctxBefore));
    }

    parts.push("--- IMPROVE THESE MEASURES ---");
    parts.push(measuresToText(batchMeasures));

    if (ctxAfter.length > 0) {
      parts.push("--- CONTEXT (do not modify) ---");
      parts.push(measuresToText(ctxAfter));
    }

    const prompt = parts.join("\n");

    // Try up to 2 times (initial + 1 retry)
    let parsed: Measure[] | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await gemini.chat(
          [{ role: "user", content: prompt }],
          { systemPrompt },
        );

        // Extract only measure lines from response
        const measureLines = response
          .split("\n")
          .filter((line) => /^M\d+:/.test(line.trim()));

        if (measureLines.length === 0) {
          continue;
        }

        // Build a mini score text for parsing
        const miniScoreText = [
          `BPM: ${score.bpm}`,
          `Key: ${score.key.root} ${score.key.mode}`,
          `Time: ${score.beatsPerMeasure}/${score.beatUnit}`,
          `Clef: ${score.clef}`,
          `Measures: ${measureLines.length}`,
          `Duration: ${score.totalDuration.toFixed(1)}s`,
          "",
          ...measureLines,
        ].join("\n");

        const parsedScore = parseScoreText(miniScoreText);
        if (parsedScore && parsedScore.measures.length > 0) {
          parsed = parsedScore.measures;
          break;
        }
      } catch {
        // retry
      }
    }

    if (parsed) {
      // Use LLM output as a mask: keep original DetectedNote objects,
      // only remove notes that the LLM removed.
      // Safety valve: if >30% of notes are removed, keep the original measure.
      for (const original of batchMeasures) {
        const mask = parsed.find((m) => m.number === original.number);
        if (mask) {
          const result = filterMeasureByMask(original, mask);
          if (original.notes.length > 0 && result.notes.length < original.notes.length * 0.7) {
            // Safety valve: LLM removed too many notes, keep original
            improvedMeasures.push(original);
          } else {
            improvedMeasures.push(result);
          }
        } else {
          improvedMeasures.push(original);
        }
      }
    } else {
      // Parse failed after retry — keep originals
      improvedMeasures.push(...batchMeasures);
    }

    onProgress?.(batch + 1, totalBatches, "llm");
  }

  return {
    ...filtered,
    measures: improvedMeasures,
  };
}

