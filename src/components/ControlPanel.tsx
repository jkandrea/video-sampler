import type {
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from "react";
import type { SamplerMode, VideoSample } from "../sampler";
import type { PadIndex } from "../samplerUi";
import { PadGrid } from "./PadGrid";

type Download = { url: string; filename: string };

type ControlPanelProps = {
  mode: SamplerMode;
  bpm: number;
  isMetronomeOn: boolean;
  metronomeBeat: number | null;
  isRecording: boolean;
  recordingDownload: Download | null;
  samples: Array<VideoSample | null>;
  isCapturing: boolean[];
  isPerforming: boolean[];
  captureLengths: number[];
  loopEnabled: boolean[];
  activePad: PadIndex;
  canUndo: boolean;
  status: string;
  setBpm: (value: number) => void;
  toggleMetronome: () => void;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
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
  onUndo: () => void;
};

export function ControlPanel({
  mode,
  bpm,
  isMetronomeOn,
  metronomeBeat,
  isRecording,
  recordingDownload,
  samples,
  isCapturing,
  isPerforming,
  captureLengths,
  loopEnabled,
  activePad,
  canUndo,
  status,
  setBpm,
  toggleMetronome,
  startRecording,
  stopRecording,
  onPointerDown,
  onPointerUp,
  onTouchStart,
  onTouchEnd,
  onToggleLoop,
  onUndo,
}: ControlPanelProps) {
  return (
    <aside className="control-panel">
      <div className="instruction-block">
        <p className="panel-kicker">
          {mode === "sample" ? "CAPTURE PADS" : "PERFORMANCE PADS · RETRIGGER"}
        </p>
        <h2>
          {mode === "sample"
            ? "장면이 나오는 동안 누르세요"
            : "네 장면을 자유롭게 연주하세요"}
        </h2>
        <p>
          {mode === "sample"
            ? "영상을 여러 개 추가하고 소스를 바꿔가며 패드마다 다른 구간을 저장할 수 있습니다."
            : "네 패드는 독립적으로 겹쳐 재생됩니다. LOOP를 켜면 각 샘플의 IN~OUT 길이로 반복합니다."}
        </p>
      </div>

      <div className="metronome-panel">
        <button
          className={isMetronomeOn ? "metronome-toggle active" : "metronome-toggle"}
          type="button"
          onClick={toggleMetronome}
          aria-pressed={isMetronomeOn}
        >
          <span>{isMetronomeOn ? "■" : "▶"}</span> METRONOME
        </button>
        <label className="bpm-control">
          <span>BPM</span>
          <input
            type="number"
            min="40"
            max="240"
            value={bpm}
            onChange={(event) => setBpm(Number(event.target.value))}
          />
        </label>
        <div
          className="beat-lights"
          aria-label={`4박자 중 ${metronomeBeat === null ? 0 : metronomeBeat + 1}박`}
        >
          {[0, 1, 2, 3].map((beat) => (
            <span
              key={beat}
              className={`${metronomeBeat === beat && isMetronomeOn ? "active" : ""} ${beat === 0 ? "accent" : ""}`}
            />
          ))}
        </div>
        <p className="loop-station-note">LOOP STATION · SAMPLE LENGTH</p>
      </div>

      <div className="recording-panel">
        <button
          className={isRecording ? "record-toggle active" : "record-toggle"}
          type="button"
          onClick={() => {
            if (isRecording) stopRecording();
            else void startRecording();
          }}
          disabled={mode !== "perform"}
        >
          <span aria-hidden="true">{isRecording ? "■" : "●"}</span>
          {isRecording ? "녹화 정지" : "녹화 시작"}
        </button>
        {recordingDownload ? (
          <a href={recordingDownload.url} download={recordingDownload.filename}>
            녹화 파일 저장
          </a>
        ) : (
          <p>연주 화면과 패드 오디오를 함께 저장합니다.</p>
        )}
      </div>

      <PadGrid
        mode={mode}
        samples={samples}
        isCapturing={isCapturing}
        isPerforming={isPerforming}
        captureLengths={captureLengths}
        loopEnabled={loopEnabled}
        activePad={activePad}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onToggleLoop={onToggleLoop}
      />

      <button
        className="undo-button"
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
      >
        ↶ 마지막 덮어쓰기 취소
      </button>
      <div className="status-line" role="status" aria-live="polite">
        <span
          className={
            isCapturing.some(Boolean) || isPerforming.some(Boolean) ? "pulse" : ""
          }
        />
        {status}
      </div>
    </aside>
  );
}
