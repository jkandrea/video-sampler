import type { Dispatch, SetStateAction } from "react";
import { formatClock, formatDuration, type SamplerMode, type VideoSample } from "../sampler";
import {
  PAD_INDICES,
  padLabel,
  replaceAt,
  type PadIndex,
  type SourceAsset,
} from "../samplerUi";

type MonitorPanelProps = {
  mode: SamplerMode;
  sourceName: string;
  sourceUrl: string | null;
  sources: SourceAsset[];
  activeSourceId: string | null;
  activeCaptureIndices: PadIndex[];
  isRecording: boolean;
  duration: number;
  sourceTime: number;
  currentMonitorTime: number;
  activePerformanceCount: number;
  isPerforming: boolean[];
  isCapturing: boolean[];
  captureLengths: number[];
  samples: Array<VideoSample | null>;
  selectedSample: VideoSample | null;
  sourceVideoRef: { current: HTMLVideoElement | null };
  performanceVideoRefs: { current: Array<HTMLVideoElement | null> };
  recordingCanvasRef: { current: HTMLCanvasElement | null };
  setDuration: (value: number) => void;
  setSourceTime: (value: number) => void;
  setPerformanceTimes: Dispatch<SetStateAction<number[]>>;
  setStatus: (message: string) => void;
  selectSource: (sourceId: string) => void;
  finishAllCaptures: () => void;
  handleSourceTimeUpdate: () => void;
  toggleSourcePlayback: () => Promise<void>;
  seekSource: (seconds: number) => void;
};

export function MonitorPanel({
  mode,
  sourceName,
  sourceUrl,
  sources,
  activeSourceId,
  activeCaptureIndices,
  isRecording,
  duration,
  sourceTime,
  currentMonitorTime,
  activePerformanceCount,
  isPerforming,
  isCapturing,
  captureLengths,
  samples,
  selectedSample,
  sourceVideoRef,
  performanceVideoRefs,
  recordingCanvasRef,
  setDuration,
  setSourceTime,
  setPerformanceTimes,
  setStatus,
  selectSource,
  finishAllCaptures,
  handleSourceTimeUpdate,
  toggleSourcePlayback,
  seekSource,
}: MonitorPanelProps) {
  return (
    <div className="monitor-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">
            {mode === "sample" ? "SOURCE MONITOR" : "OUTPUT MONITOR"}
          </p>
          <div className="source-heading">
            <h2 title={sourceName}>{sourceName || "No source loaded"}</h2>
            {sources.length > 1 && mode === "sample" && (
              <select
                className="source-select"
                aria-label="샘플링할 소스 영상 선택"
                value={activeSourceId ?? ""}
                onChange={(event) => selectSource(event.target.value)}
              >
                {sources.map((source, index) => (
                  <option key={source.id} value={source.id}>
                    {String.fromCharCode(65 + index)} · {source.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div
          className={`live-indicator ${activeCaptureIndices.length || isRecording ? "recording" : ""}`}
        >
          <span />
          {isRecording
            ? "REC"
            : activeCaptureIndices.length
              ? "SAMPLING"
              : mode === "perform"
                ? "READY"
                : "SOURCE"}
        </div>
      </div>

      <div className={`video-stage ${!sourceUrl ? "empty" : ""}`}>
        {sourceUrl ? (
          <>
            <video
              ref={sourceVideoRef}
              className={mode === "sample" ? "visible" : "hidden-video"}
              src={sourceUrl}
              playsInline
              preload="auto"
              onLoadedMetadata={(event) => {
                setDuration(event.currentTarget.duration);
                setSourceTime(0);
              }}
              onTimeUpdate={handleSourceTimeUpdate}
              onEnded={() => {
                finishAllCaptures();
                setStatus("소스 영상 재생이 끝났습니다.");
              }}
            />

            <div
              className={`performance-grid ${mode === "perform" ? "visible" : "hidden-video"} active-${activePerformanceCount}`}
            >
              {PAD_INDICES.map((padIndex) => (
                <video
                  key={padIndex}
                  ref={(element) => {
                    performanceVideoRefs.current[padIndex] = element;
                  }}
                  className={
                    isPerforming[padIndex]
                      ? "performance-active"
                      : "performance-idle"
                  }
                  src={
                    sources.find(
                      (source) => source.id === samples[padIndex]?.sourceId,
                    )?.url
                  }
                  playsInline
                  muted
                  preload="auto"
                  onLoadedMetadata={(event) => {
                    const sample = samples[padIndex];
                    if (sample) event.currentTarget.currentTime = sample.inSeconds;
                  }}
                  onTimeUpdate={(event) => {
                    const time = event.currentTarget.currentTime;
                    setPerformanceTimes((current) =>
                      replaceAt(current, padIndex, time),
                    );
                  }}
                />
              ))}
              {activePerformanceCount === 0 && (
                <div className="output-standby">
                  <strong>OUTPUT READY</strong>
                  <p>PAD 01~04 중 하나를 눌러 연주하세요.</p>
                </div>
              )}
            </div>
            <canvas
              ref={recordingCanvasRef}
              className="recording-canvas"
              width="1280"
              height="720"
              aria-hidden="true"
            />
          </>
        ) : (
          <div className="empty-monitor">
            <span className="empty-icon">＋</span>
            <strong>로컬 영상을 선택하세요</strong>
            <p>파일은 서버로 업로드되지 않고 이 브라우저에서만 사용됩니다.</p>
          </div>
        )}

        {activeCaptureIndices.length > 0 && (
          <div className="capture-overlay">
            <span className="capture-dot" />
            <strong>{activeCaptureIndices.map(padLabel).join(" + ")}</strong>
            <b>
              {formatDuration(
                Math.max(
                  ...activeCaptureIndices.map((index) => captureLengths[index]),
                ),
              )}
            </b>
          </div>
        )}
      </div>

      <div className="transport">
        <time>{formatClock(currentMonitorTime)}</time>
        {mode === "sample" ? (
          <>
            <button
              type="button"
              onClick={() => seekSource(-5)}
              disabled={!sourceUrl || isCapturing.some(Boolean)}
              aria-label="5초 뒤로"
            >
              −5s
            </button>
            <button
              className="play-button"
              type="button"
              onClick={() => void toggleSourcePlayback()}
              disabled={!sourceUrl}
            >
              {sourceVideoRef.current?.paused === false ? "Ⅱ" : "▶"}
            </button>
            <button
              type="button"
              onClick={() => seekSource(5)}
              disabled={!sourceUrl || isCapturing.some(Boolean)}
              aria-label="5초 앞으로"
            >
              +5s
            </button>
            <input
              aria-label="소스 영상 탐색"
              type="range"
              min="0"
              max={duration || 0}
              step="0.001"
              value={sourceTime}
              disabled={!sourceUrl || isCapturing.some(Boolean)}
              onChange={(event) => {
                const video = sourceVideoRef.current;
                if (video) video.currentTime = Number(event.target.value);
                setSourceTime(Number(event.target.value));
              }}
            />
          </>
        ) : (
          <div className="sample-range" aria-label="선택된 패드 샘플 구간">
            <span>
              {selectedSample
                ? formatClock(selectedSample.inSeconds)
                : "--:--.---"}
            </span>
            <div />
            <span>
              {selectedSample
                ? formatClock(selectedSample.outSeconds)
                : "--:--.---"}
            </span>
          </div>
        )}
        <time>
          {formatClock(
            mode === "sample" ? duration : selectedSample?.outSeconds ?? 0,
          )}
        </time>
      </div>
    </div>
  );
}
