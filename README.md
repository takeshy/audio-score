# Audio Score

A [GemiHub](https://github.com/takeshy/gemihub) plugin that converts audio files into sheet music using Spotify's [basic-pitch](https://github.com/spotify/basic-pitch) ML model.

[Japanese / 日本語](README_ja.md)

## Features

- **ML-based pitch detection** — Polyphonic (chord) detection powered by basic-pitch
- **Staff notation rendering** — Canvas 2D rendering with clef, key signature, and time signature
- **Chord support** — Simultaneous notes grouped with shared stems
- **Playback** — Listen to detected scores via Web Audio API
- **Export** — Save to Google Drive as `.md` or download as PNG
- **Auto-load** — Opening a `-score.md` file automatically displays the score
- **Drag & drop** — Load audio files directly
- **i18n** — English and Japanese

## Installation

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/takeshy/audio-score/releases) and place them in your GemiHub plugins directory:

```
plugins/audio-score/
  main.js
  manifest.json
  styles.css
```

## Usage

1. Open the Audio Score panel in the GemiHub sidebar
2. Click **Load File** or drag & drop an audio file (MP3, WAV, etc.)
3. Wait for analysis to complete — the score will be displayed automatically
4. Use the toolbar to play, export to Drive, or save as PNG

### Score Text Format

Exported `-score.md` files use a simple text format:

```
BPM: 120
Key: C major
Time: 4/4
Clef: treble

M1: C4(quarter) E4(quarter) G4(quarter) [C4,E4,G4](quarter)
M2: ...
```

## Settings

| Setting | Default | Description |
|---|---|---|
| Onset Threshold | 0.5 | Sensitivity for note onset detection (0–1) |
| Frame Threshold | 0.3 | Sensitivity for note presence detection (0–1) |
| Min Note Duration | 0.05s | Filter out notes shorter than this |
| Beats Per Measure | 4 | Time signature numerator |

## Development

```bash
npm install --legacy-peer-deps
npm run dev    # watch mode
npm run build  # production build
npm test       # run tests
```

## License

MIT
