/**
 * Settings panel for analysis parameters.
 */

import * as React from "react";
import { AnalysisSettings, DEFAULT_SETTINGS, StemName } from "../types";
import { t } from "../i18n";

interface PluginAPI {
  language?: string;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
}

interface SettingsPanelProps {
  api: PluginAPI;
  language?: string;
  onClose?: () => void;
}

export function SettingsPanel({ api, language, onClose }: SettingsPanelProps) {
  const i = t(language ?? api.language);
  const [settings, setSettings] = React.useState<AnalysisSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    api.storage.get("analysisSettings").then((saved) => {
      if (saved && typeof saved === "object") {
        setSettings({ ...DEFAULT_SETTINGS, ...(saved as Partial<AnalysisSettings>) });
      }
      setLoaded(true);
    });
  }, [api]);

  const update = (key: keyof AnalysisSettings, value: number | boolean | string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const STEMS: StemName[] = ["drums", "bass", "other", "vocals", "guitar", "piano"];

  const handleSave = async () => {
    await api.storage.set("analysisSettings", settings);
    onClose?.();
  };

  const handleReset = () => {
    setSettings(DEFAULT_SETTINGS);
  };

  if (!loaded) return null;

  return (
    <div className="audio-score-settings">
      <h3>{i.settingsTitle}</h3>

      <div className="audio-score-settings-grid">
        <label>{i.onsetThreshold}</label>
        <input
          type="number"
          value={settings.onsetThreshold}
          min={0}
          max={1}
          step={0.05}
          onChange={(e) => update("onsetThreshold", Number(e.target.value))}
        />

        <label>{i.frameThreshold}</label>
        <input
          type="number"
          value={settings.frameThreshold}
          min={0}
          max={1}
          step={0.05}
          onChange={(e) => update("frameThreshold", Number(e.target.value))}
        />

        <label>{i.minNoteDuration}</label>
        <input
          type="number"
          value={settings.minNoteDuration}
          min={0.01}
          max={1}
          step={0.01}
          onChange={(e) => update("minNoteDuration", Number(e.target.value))}
        />

        <label>{i.beatsPerMeasure}</label>
        <input
          type="number"
          value={settings.beatsPerMeasure}
          min={1}
          max={12}
          onChange={(e) => update("beatsPerMeasure", Number(e.target.value))}
        />

        <label>{i.beatUnit}</label>
        <select
          value={settings.beatUnit}
          onChange={(e) => update("beatUnit", Number(e.target.value))}
        >
          <option value={2}>2</option>
          <option value={4}>4</option>
          <option value={8}>8</option>
        </select>

        <label>{i.minAmplitude}</label>
        <input
          type="number"
          value={settings.minAmplitude}
          min={0}
          max={1}
          step={0.01}
          onChange={(e) => update("minAmplitude", Number(e.target.value))}
        />
      </div>

      <div className="audio-score-settings-section">
        <label className="audio-score-settings-checkbox-label">
          <input
            type="checkbox"
            checked={settings.enableSourceSeparation}
            onChange={(e) => update("enableSourceSeparation", e.target.checked)}
          />
          {i.sourceSeparation}
        </label>
        {settings.enableSourceSeparation && (
          <div className="audio-score-settings-grid" style={{ marginTop: 8 }}>
            <label>{i.separationStem}</label>
            <select
              value={settings.separationStem}
              onChange={(e) => update("separationStem", e.target.value as StemName)}
            >
              {STEMS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}
        <p className="audio-score-settings-hint">{i.sourceSeparationHint}</p>
      </div>

      <div className="audio-score-settings-actions">
        <button className="audio-score-btn" onClick={handleReset}>
          {i.resetDefaults}
        </button>
        <div className="audio-score-settings-right">
          {onClose && (
            <button className="audio-score-btn" onClick={onClose}>
              {i.cancel}
            </button>
          )}
          <button className="audio-score-btn mod-cta" onClick={handleSave}>
            {i.save}
          </button>
        </div>
      </div>
    </div>
  );
}
