/**
 * AI service: chord analysis using Gemini API.
 */

import { ScoreData, ChordAnnotation } from "../types";
import { scoreToText } from "../ui/ScoreRenderer";

export type { ChordAnnotation };

export interface GeminiAPI {
  chat(
    messages: Array<{ role: string; content: string }>,
    options?: { model?: string; systemPrompt?: string },
  ): Promise<string>;
}

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
