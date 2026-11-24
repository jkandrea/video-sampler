import type {
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from "react";
import {
  formatClock,
  formatDuration,
  sampleDuration,
  type SamplerMode,
  type VideoSample,
} from "../sampler";
import { PAD_INDICES, PAD_KEYS, padLabel, type PadIndex } from "../samplerUi";

type PadGridProps = {
  mode: SamplerMode;
  samples: Array<VideoSample | null>;
  isCapturing: boolean[];
  isPerforming: boolean[];
  captureLengths: number[];
  loopEnabled: boolean[];
  activePad: PadIndex;
  onPointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    padIndex: PadIndex,
  ) => void;
  onPointerUp: (
    event: ReactPointerEvent<HTMLButtonElement>,
    padIndex: PadIndex,
  ) => void;
  onTouchStart: (
    event: ReactTouchEvent<HTMLButtonElement>,
    padIndex: PadIndex,
  ) => void;
  onTouchEnd: (
    event: ReactTouchEvent<HTMLButtonElement>,
    padIndex: PadIndex,
  ) => void;
  onToggleLoop: (padIndex: PadIndex) => void;
};

export function PadGrid({
  mode,
  samples,
  isCapturing,
  isPerforming,
  captureLengths,
  loopEnabled,
  activePad,
  onPointerDown,
  onPointerUp,
  onTouchStart,
  onTouchEnd,
  onToggleLoop,
}: PadGridProps) {
  return (
    <div className="pad-grid">
      {PAD_INDICES.map((padIndex) => {
        const sample = samples[padIndex];
        return (
          <div
            className={`pad-slot ${activePad === padIndex ? "selected" : ""}`}
            key={padIndex}
          >
            <button
              className={`sampler-pad ${isCapturing[padIndex] ? "capturing" : ""} ${isPerforming[padIndex] ? "performing" : ""} ${sample ? "loaded" : ""}`}
              type="button"
              onPointerDown={(event) => onPointerDown(event, padIndex)}
              onPointerUp={(event) => onPointerUp(event, padIndex)}
              onPointerCancel={(event) => onPointerUp(event, padIndex)}
              onTouchStart={(event) => onTouchStart(event, padIndex)}
              onTouchEnd={(event) => onTouchEnd(event, padIndex)}
              onTouchCancel={(event) => onTouchEnd(event, padIndex)}
              onContextMenu={(event) => event.preventDefault()}
              aria-label={
                mode === "sample"
                  ? `${padLabel(padIndex)}, 누르고 있는 동안 영상 구간 수집`
                  : `${padLabel(padIndex)}, 저장된 영상 샘플 재생`
              }
            >
              <span className="pad-number">
                {String(padIndex + 1).padStart(2, "0")}
              </span>
              <span className="pad-state">
                {isCapturing[padIndex]
                  ? "CAPTURING"
                  : isPerforming[padIndex]
                    ? "PLAYING"
                    : sample
                      ? "LOADED"
                      : "EMPTY"}
              </span>
              <strong>
                {isCapturing[padIndex]
                  ? formatDuration(captureLengths[padIndex])
                  : sample
                    ? formatDuration(sampleDuration(sample))
                    : mode === "sample"
                      ? "HOLD"
                      : "NO SAMPLE"}
              </strong>
              <kbd>{PAD_KEYS[padIndex]}</kbd>
            </button>
            <div className="sample-meta">
              <div>
                <span>IN</span>
                <strong>
                  {sample ? formatClock(sample.inSeconds) : "--:--.---"}
                </strong>
              </div>
              <div>
                <span>OUT</span>
                <strong>
                  {sample ? formatClock(sample.outSeconds) : "--:--.---"}
                </strong>
              </div>
            </div>
            <div className="pad-utility-row">
              <span className="sample-source-name" title={sample?.sourceName}>
                {sample?.sourceName ?? "NO SOURCE"}
              </span>
              <button
                className={loopEnabled[padIndex] ? "loop-toggle active" : "loop-toggle"}
                type="button"
                onClick={() => onToggleLoop(padIndex)}
                disabled={!sample || mode !== "perform"}
                aria-pressed={loopEnabled[padIndex]}
              >
                LOOP {loopEnabled[padIndex] ? "ON" : "OFF"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
