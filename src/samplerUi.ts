export type PadIndex = 0 | 1 | 2 | 3;

export type SourceAsset = {
  id: string;
  name: string;
  url: string;
  file: File;
  audioBuffer: AudioBuffer | null;
  audioDecodePromise: Promise<AudioBuffer | null> | null;
};

export const PAD_INDICES: PadIndex[] = [0, 1, 2, 3];
export const PAD_KEYS = ["A", "S", "D", "F"] as const;
export const PAD_KEY_CODES: Record<string, PadIndex> = {
  KeyA: 0,
  KeyS: 1,
  KeyD: 2,
  KeyF: 3,
};

export function createPadValues<T>(value: T): T[] {
  return PAD_INDICES.map(() => value);
}

export function replaceAt<T>(values: readonly T[], index: PadIndex, value: T): T[] {
  const next = [...values];
  next[index] = value;
  return next;
}

export function padLabel(index: PadIndex): string {
  return `PAD ${String(index + 1).padStart(2, "0")}`;
}

export function drawVideoCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  context.drawImage(
    video,
    x + (width - drawnWidth) / 2,
    y + (height - drawnHeight) / 2,
    drawnWidth,
    drawnHeight,
  );
}
