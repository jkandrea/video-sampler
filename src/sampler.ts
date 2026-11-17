export type SamplerMode = "sample" | "perform";

export type VideoSample = {
  sourceId: string;
  inSeconds: number;
  outSeconds: number;
  sourceName: string;
};

export type LatencyReading = {
  playPromiseMs: number | null;
  firstFrameMs: number | null;
  audioBaseMs: number | null;
  audioOutputMs: number | null;
};

export const MIN_SAMPLE_SECONDS = 0.1;

export function sampleDuration(sample: VideoSample | null): number {
  if (!sample) return 0;
  return Math.max(0, sample.outSeconds - sample.inSeconds);
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00.000";

  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest
    .toFixed(3)
    .padStart(6, "0")}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0.00s";
  return `${seconds.toFixed(2)}s`;
}

export function clampTime(value: number, duration: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, value);
  return Math.min(Math.max(0, value), duration);
}
