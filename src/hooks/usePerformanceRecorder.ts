import { useCallback, useEffect, useRef, useState } from "react";
import { drawVideoCover } from "../samplerUi";

type RecordingDownload = { url: string; filename: string };

type RecorderOptions = {
  initializeAudioContext: () => Promise<AudioContext | null>;
  performanceVideos: { current: Array<HTMLVideoElement | null> };
  performanceAudioSources: { current: Array<AudioBufferSourceNode | null> };
  metronomeGain: { current: GainNode | null };
  metronomeConnected: { current: boolean };
  setStatus: (message: string) => void;
};

export function usePerformanceRecorder({
  initializeAudioContext,
  performanceVideos,
  performanceAudioSources,
  metronomeGain,
  metronomeConnected,
  setStatus,
}: RecorderOptions) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const connectedNodesRef = useRef(new WeakSet<AudioBufferSourceNode>());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const frameRef = useRef<number | null>(null);
  const downloadRef = useRef<RecordingDownload | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [download, setDownload] = useState<RecordingDownload | null>(null);

  useEffect(() => {
    downloadRef.current = download;
  }, [download]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") {
        recorder.onstop = null;
        recorder.stop();
      }
      if (downloadRef.current) URL.revokeObjectURL(downloadRef.current.url);
    };
  }, []);

  const drawFrame = useCallback(function renderFrame() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const activeVideos = performanceVideos.current.filter(
      (video): video is HTMLVideoElement =>
        Boolean(
          video &&
            !video.paused &&
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
        ),
    );
    const columns = activeVideos.length === 1 ? 1 : 2;
    const rows = activeVideos.length <= 2 ? 1 : 2;
    const cellWidth = canvas.width / columns;
    const cellHeight = canvas.height / rows;
    activeVideos.forEach((video, index) => {
      drawVideoCover(
        context,
        video,
        (index % columns) * cellWidth,
        Math.floor(index / columns) * cellHeight,
        cellWidth,
        cellHeight,
      );
    });
    frameRef.current = window.requestAnimationFrame(renderFrame);
  }, [performanceVideos]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    setIsRecording(false);
    setStatus("녹화를 마무리하고 저장 파일을 만드는 중입니다.");
  }, [setStatus]);

  const startRecording = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || typeof MediaRecorder === "undefined" || !("captureStream" in canvas)) {
      setStatus("이 브라우저에서는 화면 녹화를 지원하지 않습니다.");
      return;
    }

    const audioContext = await initializeAudioContext();
    if (!audioContext) {
      setStatus("녹화용 오디오를 준비하지 못했습니다.");
      return;
    }
    if (!destinationRef.current) {
      destinationRef.current = audioContext.createMediaStreamDestination();
    }
    const destination = destinationRef.current;
    performanceAudioSources.current.forEach((source) => {
      if (source && !connectedNodesRef.current.has(source)) {
        source.connect(destination);
        connectedNodesRef.current.add(source);
      }
    });
    if (metronomeGain.current && !metronomeConnected.current) {
      metronomeGain.current.connect(destination);
      metronomeConnected.current = true;
    }

    if (downloadRef.current) {
      URL.revokeObjectURL(downloadRef.current.url);
      downloadRef.current = null;
      setDownload(null);
    }

    const canvasStream = canvas.captureStream(30);
    const stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ]);
    const mimeType = [
      "video/mp4;codecs=h264,aac",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));

    try {
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        canvasStream.getVideoTracks().forEach((track) => track.stop());
        const actualType = recorder.mimeType || mimeType || "video/webm";
        const extension = actualType.includes("mp4") ? "mp4" : "webm";
        const blob = new Blob(chunksRef.current, { type: actualType });
        const nextDownload = {
          url: URL.createObjectURL(blob),
          filename: `video-sampler-${new Date()
            .toISOString()
            .replace(/[:.]/g, "-")}.${extension}`,
        };
        downloadRef.current = nextDownload;
        setDownload(nextDownload);
        setStatus("녹화가 완료되었습니다. 저장 버튼으로 내려받으세요.");
      };
      recorder.onerror = () => {
        setIsRecording(false);
        setStatus("녹화 중 오류가 발생했습니다.");
      };
      drawFrame();
      recorder.start(250);
      setIsRecording(true);
      setStatus("출력 영상과 오디오를 녹화 중입니다.");
    } catch {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      canvasStream.getVideoTracks().forEach((track) => track.stop());
      setStatus("이 브라우저에서 녹화를 시작하지 못했습니다.");
    }
  }, [
    drawFrame,
    initializeAudioContext,
    metronomeGain,
    metronomeConnected,
    performanceAudioSources,
    setStatus,
  ]);

  return {
    canvasRef,
    destinationRef,
    connectedNodesRef,
    isRecording,
    download,
    startRecording,
    stopRecording,
  };
}
