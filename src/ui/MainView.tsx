/**
 * Main view for Audio Score plugin.
 * Displays score canvas and piano roll with tab switching.
 */

import * as React from "react";
import { useStore } from "../store";
import { renderScore, calculateSize, RenderOptions } from "./ScoreRenderer";
import { renderPianoRoll, calculatePianoRollSize, PianoRollOptions } from "./PianoRollRenderer";
import { t } from "../i18n";

interface MainViewProps {
  language?: string;
}

type Tab = "canvas" | "midi";

export function MainView({ language }: MainViewProps) {
  const i = t(language);
  const { score, chordAnnotations } = useStore();

  const [tab, setTab] = React.useState<Tab>("canvas");
  const [saveMsg, setSaveMsg] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(800);

  // Track container width via ResizeObserver
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setContainerWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Read CSS variables for dark mode colors
  const getColors = React.useCallback(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      bg: style.getPropertyValue("--as-bg-primary").trim() || "#ffffff",
      text: style.getPropertyValue("--as-text").trim() || "#1a1a1a",
      secondary: style.getPropertyValue("--as-text-secondary").trim() || "#666666",
      border: style.getPropertyValue("--as-border").trim() || "#d8d8da",
      accent: style.getPropertyValue("--as-accent").trim() || "#2563eb",
      muted: style.getPropertyValue("--as-text-muted").trim() || "#999999",
    };
  }, []);

  // Render score or piano roll to canvas
  React.useEffect(() => {
    if (!score || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const colors = getColors();
    const dpr = window.devicePixelRatio || 1;

    if (tab === "canvas") {
      const opts: RenderOptions = {
        width: containerWidth,
        backgroundColor: colors.bg,
        staffColor: colors.secondary,
        noteColor: colors.text,
        chordAnnotations,
      };
      const size = calculateSize(score, opts);

      canvas.width = size.width * dpr;
      canvas.height = size.height * dpr;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderScore(ctx, score, opts);
    } else {
      const opts: PianoRollOptions = {
        width: containerWidth,
        backgroundColor: colors.bg,
        gridColor: colors.border,
        noteColor: colors.accent,
        barLineColor: colors.muted,
        labelColor: colors.text,
      };
      const size = calculatePianoRollSize(score, opts);

      canvas.width = size.width * dpr;
      canvas.height = size.height * dpr;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderPianoRoll(ctx, score, opts);
    }
  }, [score, chordAnnotations, tab, containerWidth, getColors]);

  // Save image handler
  const handleSaveImage = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = tab === "canvas" ? "score.png" : "piano-roll.png";
      a.click();
      URL.revokeObjectURL(url);
      setSaveMsg(i.saveImageSuccess);
      setTimeout(() => setSaveMsg(""), 3000);
    }, "image/png");
  }, [tab, i]);

  return (
    <div className="audio-score-main" ref={containerRef}>
      {!score ? (
        <div className="audio-score-main-empty">{i.mainViewEmpty}</div>
      ) : (
        <>
          {/* Tab bar */}
          <div className="audio-score-main-tabs">
            <button
              className={`audio-score-main-tab${tab === "canvas" ? " is-active" : ""}`}
              onClick={() => setTab("canvas")}
            >
              {i.tabCanvas}
            </button>
            <button
              className={`audio-score-main-tab${tab === "midi" ? " is-active" : ""}`}
              onClick={() => setTab("midi")}
            >
              {i.tabMidi}
            </button>
            <div className="audio-score-main-tab-spacer" />
            <button className="audio-score-btn" onClick={handleSaveImage}>
              {i.saveImage}
            </button>
            {saveMsg && <span className="audio-score-export-msg">{saveMsg}</span>}
          </div>

          {/* Canvas area */}
          <div className="audio-score-main-canvas-area">
            <canvas ref={canvasRef} className="audio-score-canvas" />
          </div>
        </>
      )}
    </div>
  );
}
