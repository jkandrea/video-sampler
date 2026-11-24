import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  MIN_SAMPLE_SECONDS,
  clampTime,
  formatClock,
  formatDuration,
  sampleDuration,
  type LatencyReading,
  type SamplerMode,
  type VideoSample,
} from "./sampler";
import {
  PAD_INDICES,
  PAD_KEY_CODES,
  createPadValues,
  padLabel,
  replaceAt,
  type PadIndex,
  type SourceAsset,
} from "./samplerUi";
import { usePerformanceRecorder } from "./hooks/usePerformanceRecorder";
import { useMetronome } from "./hooks/useMetronome";
import { MonitorPanel } from "./components/MonitorPanel";
import { ControlPanel } from "./components/ControlPanel";

type AudioContextWithLatency = AudioContext & { outputLatency?: number };
type UndoEntry = { padIndex: PadIndex; previousSample: VideoSample };
const EMPTY_LATENCY: LatencyReading = {
  playPromiseMs: null,
  firstFrameMs: null,
  audioBaseMs: null,
  audioOutputMs: null,
};

function App() {
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const performanceVideoRefs = useRef<Array<HTMLVideoElement | null>>(
    createPadValues(null),
  );
  const sourceAssetsRef = useRef<SourceAsset[]>([]);
  const audioContextRef = useRef<AudioContextWithLatency | null>(null);
  const performanceAudioSourceRefs = useRef<Array<AudioBufferSourceNode | null>>(
    createPadValues(null),
  );
  const metronomeRecordingConnectedRef = useRef(false);
  const captureStartRefs = useRef<Array<number | null>>(createPadValues(null));
  const stopFrameRequestRefs = useRef<Array<number | null>>(createPadValues(null));
  const latencyFrameRequestRefs = useRef<Array<number | null>>(createPadValues(null));
  const triggerGenerationRefs = useRef<number[]>(createPadValues(0));
  const keyboardHeldRef = useRef(new Set<string>());
  const undoEntryRef = useRef<UndoEntry | null>(null);
  const loopEnabledRefs = useRef<boolean[]>(createPadValues(false));

  const metronomeGainRef = useRef<GainNode | null>(null);

  const [mode, setMode] = useState<SamplerMode>("sample");
  const [sources, setSources] = useState<SourceAsset[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [sourceTime, setSourceTime] = useState(0);
  const [samples, setSamples] = useState<Array<VideoSample | null>>(
    createPadValues(null),
  );
  const [isCapturing, setIsCapturing] = useState<boolean[]>(createPadValues(false));
  const [captureLengths, setCaptureLengths] = useState<number[]>(createPadValues(0));
  const [isPerforming, setIsPerforming] = useState<boolean[]>(createPadValues(false));
  const [loopEnabled, setLoopEnabled] = useState<boolean[]>(createPadValues(false));
  const [performanceTimes, setPerformanceTimes] = useState<number[]>(createPadValues(0));
  const [activePad, setActivePad] = useState<PadIndex>(0);
  const [status, setStatus] = useState("먼저 로컬 영상을 불러오세요.");
  const [latency, setLatency] = useState<LatencyReading>(EMPTY_LATENCY);
  const [lastLatencyPad, setLastLatencyPad] = useState<PadIndex | null>(null);

  const activeSource =
    sources.find((source) => source.id === activeSourceId) ?? null;
  const sourceUrl = activeSource?.url ?? null;
  const sourceName = activeSource?.name ?? "";

  const stopPadAudio = useCallback((padIndex: PadIndex) => {
    const source = performanceAudioSourceRefs.current[padIndex];
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // The node may already have reached its scheduled end.
    }
    source.disconnect();
    performanceAudioSourceRefs.current[padIndex] = null;
  }, []);

  const stopAllPadAudio = useCallback(() => {
    PAD_INDICES.forEach(stopPadAudio);
  }, [stopPadAudio]);

  const cancelPadVideoCallbacks = useCallback((padIndex: PadIndex) => {
    const video = performanceVideoRefs.current[padIndex];
    if (!video) return;

    const stopRequest = stopFrameRequestRefs.current[padIndex];
    if (stopRequest !== null) {
      if ("cancelVideoFrameCallback" in video) video.cancelVideoFrameCallback(stopRequest);
      else window.cancelAnimationFrame(stopRequest);
      stopFrameRequestRefs.current[padIndex] = null;
    }

    const latencyRequest = latencyFrameRequestRefs.current[padIndex];
    if (latencyRequest !== null) {
      if ("cancelVideoFrameCallback" in video) video.cancelVideoFrameCallback(latencyRequest);
      else window.cancelAnimationFrame(latencyRequest);
      latencyFrameRequestRefs.current[padIndex] = null;
    }
  }, []);

  const cancelAllVideoCallbacks = useCallback(() => {
    PAD_INDICES.forEach(cancelPadVideoCallbacks);
  }, [cancelPadVideoCallbacks]);

  const prepareSample = useCallback((padIndex: PadIndex, sample: VideoSample) => {
    const video = performanceVideoRefs.current[padIndex];
    const source = sourceAssetsRef.current.find((asset) => asset.id === sample.sourceId);
    if (!video || !source) return;

    video.pause();
    if (video.src !== source.url) {
      video.src = source.url;
      video.load();
    }

    const seekToInPoint = () => {
      video.currentTime = sample.inSeconds;
      setPerformanceTimes((current) => replaceAt(current, padIndex, sample.inSeconds));
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) seekToInPoint();
    else video.addEventListener("loadedmetadata", seekToInPoint, { once: true });
  }, []);

  const releaseSourceUrls = useCallback(() => {
    sourceAssetsRef.current.forEach((source) => URL.revokeObjectURL(source.url));
    sourceAssetsRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      cancelAllVideoCallbacks();
      stopAllPadAudio();
      releaseSourceUrls();
      void audioContextRef.current?.close();
    };
  }, [cancelAllVideoCallbacks, releaseSourceUrls, stopAllPadAudio]);

  const initializeAudioContext = useCallback(async () => {
    const Context = window.AudioContext;
    if (!Context) return null;
    if (!audioContextRef.current) {
      audioContextRef.current = new Context({ latencyHint: "interactive" });
    }

    const context = audioContextRef.current;
    if (context.state === "suspended") await context.resume();
    setLatency((current) => ({
      ...current,
      audioBaseMs: Number.isFinite(context.baseLatency)
        ? context.baseLatency * 1000
        : null,
      audioOutputMs: Number.isFinite(context.outputLatency)
        ? (context.outputLatency ?? 0) * 1000
        : null,
    }));
    return context;
  }, []);

  const ensureSourceAudio = useCallback(
    (source: SourceAsset, context: AudioContext): Promise<AudioBuffer | null> => {
      if (source.audioBuffer) return Promise.resolve(source.audioBuffer);
      if (source.audioDecodePromise) return source.audioDecodePromise;

      source.audioDecodePromise = source.file
        .arrayBuffer()
        .then((data) => context.decodeAudioData(data))
        .then((buffer) => {
          source.audioBuffer = buffer;
          return buffer;
        })
        .catch(() => null);
      return source.audioDecodePromise;
    },
    [],
  );

  const {
    canvasRef: recordingCanvasRef,
    destinationRef: recordingDestinationRef,
    connectedNodesRef: recordingConnectedNodesRef,
    isRecording,
    download: recordingDownload,
    startRecording,
    stopRecording,
  } = usePerformanceRecorder({
    initializeAudioContext,
    performanceVideos: performanceVideoRefs,
    performanceAudioSources: performanceAudioSourceRefs,
    metronomeGain: metronomeGainRef,
    metronomeConnected: metronomeRecordingConnectedRef,
    setStatus,
  });

  const {
    bpm,
    isOn: isMetronomeOn,
    beat: metronomeBeat,
    setBpm,
    toggle: toggleMetronome,
  } = useMetronome({
    initializeAudioContext,
    gainRef: metronomeGainRef,
    recordingDestination: recordingDestinationRef,
    recordingConnected: metronomeRecordingConnectedRef,
    setStatus,
  });

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    finishAllCaptures();
    PAD_INDICES.forEach((padIndex) => {
      triggerGenerationRefs.current[padIndex] += 1;
      performanceVideoRefs.current[padIndex]?.pause();
    });
    stopAllPadAudio();
    cancelAllVideoCallbacks();
    sourceVideoRef.current?.pause();

    const sourceId = crypto.randomUUID();
    const nextUrl = URL.createObjectURL(file);
    const nextSource: SourceAsset = {
      id: sourceId,
      name: file.name,
      url: nextUrl,
      file,
      audioBuffer: null,
      audioDecodePromise: null,
    };
    sourceAssetsRef.current = [...sourceAssetsRef.current, nextSource];
    captureStartRefs.current = createPadValues(null);

    setSources((current) => [...current, nextSource]);
    setActiveSourceId(sourceId);
    setDuration(0);
    setSourceTime(0);
    setIsCapturing(createPadValues(false));
    setCaptureLengths(createPadValues(0));
    setIsPerforming(createPadValues(false));
    loopEnabledRefs.current = createPadValues(false);
    setLoopEnabled(createPadValues(false));
    setMode("sample");
    setStatus(
      `${file.name} 소스를 추가했습니다. 기존 패드 샘플은 그대로 유지됩니다.`,
    );
    event.target.value = "";
  };

  const selectSource = (sourceId: string) => {
    finishAllCaptures();
    sourceVideoRef.current?.pause();
    PAD_INDICES.forEach((padIndex) => {
      performanceVideoRefs.current[padIndex]?.pause();
      triggerGenerationRefs.current[padIndex] += 1;
    });
    stopAllPadAudio();
    cancelAllVideoCallbacks();
    loopEnabledRefs.current = createPadValues(false);
    setLoopEnabled(createPadValues(false));
    setIsPerforming(createPadValues(false));
    setActiveSourceId(sourceId);
    setDuration(0);
    setSourceTime(0);
    setMode("sample");
    const source = sourceAssetsRef.current.find((asset) => asset.id === sourceId);
    setStatus(`${source?.name ?? "선택한 영상"}에서 샘플링합니다.`);
  };

  const handleSourceTimeUpdate = () => {
    const video = sourceVideoRef.current;
    if (!video) return;
    setSourceTime(video.currentTime);
    setCaptureLengths((current) => {
      let changed = false;
      const next = [...current];
      PAD_INDICES.forEach((padIndex) => {
        const startedAt = captureStartRefs.current[padIndex];
        if (startedAt === null) return;
        next[padIndex] = Math.max(0, video.currentTime - startedAt);
        changed = true;
      });
      return changed ? next : current;
    });
  };

  function startCapture(padIndex: PadIndex) {
    const video = sourceVideoRef.current;
    if (!video || !sourceUrl) {
      setStatus("먼저 로컬 영상을 불러오세요.");
      return;
    }
    if (video.paused || video.ended) {
      setStatus("소스 영상을 재생한 상태에서 패드를 누르세요.");
      return;
    }
    if (captureStartRefs.current[padIndex] !== null) return;

    captureStartRefs.current[padIndex] = video.currentTime;
    setCaptureLengths((current) => replaceAt(current, padIndex, 0));
    setIsCapturing((current) => replaceAt(current, padIndex, true));
    setActivePad(padIndex);
    setStatus(`${padLabel(padIndex)} 수집 중 · IN ${formatClock(video.currentTime)}`);
  }

  function finishCapture(padIndex: PadIndex) {
    const video = sourceVideoRef.current;
    const startedAt = captureStartRefs.current[padIndex];
    captureStartRefs.current[padIndex] = null;
    setIsCapturing((current) => replaceAt(current, padIndex, false));
    setCaptureLengths((current) => replaceAt(current, padIndex, 0));
    if (!video || startedAt === null || !activeSource) return;

    const endedAt = Math.max(startedAt, video.currentTime);
    if (endedAt - startedAt < MIN_SAMPLE_SECONDS) {
      setStatus(`${padLabel(padIndex)} 입력이 너무 짧아 저장하지 않았습니다.`);
      return;
    }

    const nextSample: VideoSample = {
      sourceId: activeSource.id,
      inSeconds: startedAt,
      outSeconds: endedAt,
      sourceName,
    };

    setSamples((current) => {
      const previousSample = current[padIndex];
      undoEntryRef.current = previousSample ? { padIndex, previousSample } : null;
      return replaceAt(current, padIndex, nextSample);
    });
    setActivePad(padIndex);
    prepareSample(padIndex, nextSample);
    void initializeAudioContext().then((context) => {
      if (context) void ensureSourceAudio(activeSource, context);
    });
    setStatus(
      `${padLabel(padIndex)} 저장 완료 · ${formatClock(startedAt)} → ${formatClock(endedAt)}`,
    );
  }

  const finishAllCaptures = () => {
    PAD_INDICES.forEach((padIndex) => {
      if (captureStartRefs.current[padIndex] !== null) finishCapture(padIndex);
    });
  };

  const toggleSourcePlayback = async () => {
    const video = sourceVideoRef.current;
    if (!video) return;
    await initializeAudioContext();
    if (video.paused) {
      try {
        await video.play();
        setStatus("재생 중입니다. 원하는 장면에서 PAD 01~04 중 하나를 누르세요.");
      } catch {
        setStatus("브라우저가 재생을 막았습니다. 재생 버튼을 다시 눌러주세요.");
      }
    } else {
      video.pause();
      finishAllCaptures();
      setStatus("소스 영상이 일시 정지되었습니다.");
    }
  };

  const seekSource = (seconds: number) => {
    const video = sourceVideoRef.current;
    if (!video || isCapturing.some(Boolean)) return;
    video.currentTime = clampTime(video.currentTime + seconds, video.duration);
  };

  const undoOverwrite = () => {
    const entry = undoEntryRef.current;
    if (!entry) return;
    undoEntryRef.current = null;
    setSamples((current) => replaceAt(current, entry.padIndex, entry.previousSample));
    setActivePad(entry.padIndex);
    prepareSample(entry.padIndex, entry.previousSample);
    setStatus(`${padLabel(entry.padIndex)}의 이전 샘플을 복원했습니다.`);
  };

  const stopPerformanceAtSampleEnd = useCallback(
    (padIndex: PadIndex, activeSample: VideoSample, generation: number) => {
      const video = performanceVideoRefs.current[padIndex];
      if (!video) return;

      const stop = () => {
        if (generation !== triggerGenerationRefs.current[padIndex]) {
          stopFrameRequestRefs.current[padIndex] = null;
          return;
        }
        if (video.currentTime >= activeSample.outSeconds || video.ended) {
          video.pause();
          video.currentTime = activeSample.inSeconds;
          setPerformanceTimes((current) => replaceAt(current, padIndex, activeSample.inSeconds));

          if (loopEnabledRefs.current[padIndex]) {
            setStatus(`${padLabel(padIndex)} 샘플 루프 재생 중`);
            void video
              .play()
              .then(() => {
                if (
                  generation === triggerGenerationRefs.current[padIndex] &&
                  loopEnabledRefs.current[padIndex]
                ) {
                  stop();
                }
              })
              .catch(() => {
                loopEnabledRefs.current[padIndex] = false;
                setLoopEnabled((current) => replaceAt(current, padIndex, false));
                setIsPerforming((current) => replaceAt(current, padIndex, false));
                setStatus(`${padLabel(padIndex)} 루프를 계속 재생하지 못했습니다.`);
              });
            stopFrameRequestRefs.current[padIndex] = null;
            return;
          }

          stopPadAudio(padIndex);
          setIsPerforming((current) => replaceAt(current, padIndex, false));
          setStatus(`${padLabel(padIndex)} 재생 완료 · 다시 누르면 즉시 재생합니다.`);
          stopFrameRequestRefs.current[padIndex] = null;
          return;
        }
        if ("requestVideoFrameCallback" in video) {
          stopFrameRequestRefs.current[padIndex] = video.requestVideoFrameCallback(stop);
        } else {
          stopFrameRequestRefs.current[padIndex] = window.requestAnimationFrame(stop);
        }
      };
      stop();
    },
    [stopPadAudio],
  );

  const triggerSample = useCallback(
    async (padIndex: PadIndex) => {
      const video = performanceVideoRefs.current[padIndex];
      const sample = samples[padIndex];
      const source = sourceAssetsRef.current.find(
        (asset) => asset.id === sample?.sourceId,
      );
      if (!video || !sample || !source) {
        setStatus(`샘플링 모드에서 ${padLabel(padIndex)}을 먼저 채우세요.`);
        return;
      }

      const generation = ++triggerGenerationRefs.current[padIndex];
      cancelPadVideoCallbacks(padIndex);
      stopPadAudio(padIndex);
      // Keep the media play request in the original pointer/key event turn.
      // Mobile browsers can reject a second pad when we await AudioContext.resume()
      // before calling play(), because the transient user activation is then lost.
      const audioInitialization = initializeAudioContext();
      if (generation !== triggerGenerationRefs.current[padIndex]) return;

      video.pause();
      if (video.src !== source.url) {
        video.src = source.url;
        video.load();
      }

      const metadataReady =
        video.readyState >= HTMLMediaElement.HAVE_METADATA
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              video.addEventListener(
                "loadedmetadata",
                () => {
                  if (generation === triggerGenerationRefs.current[padIndex]) {
                    video.currentTime = sample.inSeconds;
                  }
                  resolve();
                },
                { once: true },
              );
              video.addEventListener("error", () => resolve(), { once: true });
            });

      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        video.currentTime = sample.inSeconds;
      }
      setActivePad(padIndex);
      setLastLatencyPad(padIndex);

      const inputAt = performance.now();
      setLatency((current) => ({ ...current, playPromiseMs: null, firstFrameMs: null }));
      setIsPerforming((current) => replaceAt(current, padIndex, true));
      setStatus(`${padLabel(padIndex)} 연주 중 · 다시 누르면 처음부터 재시작합니다.`);

      if ("requestVideoFrameCallback" in video) {
        latencyFrameRequestRefs.current[padIndex] = video.requestVideoFrameCallback(() => {
          if (generation === triggerGenerationRefs.current[padIndex]) {
            setLatency((current) => ({
              ...current,
              firstFrameMs: performance.now() - inputAt,
            }));
          }
          latencyFrameRequestRefs.current[padIndex] = null;
        });
      }

      try {
        // Invoke play() before awaiting metadata so mobile Safari/Chrome still
        // associate every finger press with its own media playback request.
        const playRequest = video.play();
        const audioPlayback = Promise.all([audioInitialization, metadataReady]).then(
          async ([context]) => {
            if (!context || generation !== triggerGenerationRefs.current[padIndex]) return;
            const buffer = await ensureSourceAudio(source, context);
            if (!buffer || generation !== triggerGenerationRefs.current[padIndex]) return;

            const bufferSource = context.createBufferSource();
            const shouldLoop = loopEnabledRefs.current[padIndex];
            const safeIn = Math.min(
              sample.inSeconds,
              Math.max(0, buffer.duration - 0.001),
            );
            const safeOut = Math.min(sample.outSeconds, buffer.duration);
            if (safeOut <= safeIn) return;
            const offset = Math.min(
              Math.max(safeIn, video.currentTime),
              Math.max(safeIn, safeOut - 0.001),
            );
            bufferSource.buffer = buffer;
            bufferSource.loop = shouldLoop;
            bufferSource.loopStart = safeIn;
            bufferSource.loopEnd = safeOut;
            bufferSource.connect(context.destination);
            if (recordingDestinationRef.current) {
              bufferSource.connect(recordingDestinationRef.current);
              recordingConnectedNodesRef.current.add(bufferSource);
            }
            performanceAudioSourceRefs.current[padIndex] = bufferSource;
            if (shouldLoop) {
              bufferSource.start(0, offset);
            } else {
              bufferSource.start(0, offset, Math.max(0.001, safeOut - offset));
            }
          },
        );
        await Promise.all([playRequest, audioPlayback, metadataReady]);
        if (generation !== triggerGenerationRefs.current[padIndex]) return;
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          video.pause();
          setIsPerforming((current) => replaceAt(current, padIndex, false));
          setStatus(`${padLabel(padIndex)}의 소스 영상을 불러오지 못했습니다.`);
          return;
        }
        setLatency((current) => ({
          ...current,
          playPromiseMs: performance.now() - inputAt,
        }));
        stopPerformanceAtSampleEnd(padIndex, sample, generation);
      } catch {
        setIsPerforming((current) => replaceAt(current, padIndex, false));
        setStatus(`${padLabel(padIndex)}을 재생하지 못했습니다. 다시 눌러주세요.`);
      }
    },
    [
      cancelPadVideoCallbacks,
      ensureSourceAudio,
      initializeAudioContext,
      samples,
      stopPadAudio,
      stopPerformanceAtSampleEnd,
    ],
  );

  const toggleSampleLoop = (padIndex: PadIndex) => {
    const sample = samples[padIndex];
    if (!sample) {
      setStatus(`${padLabel(padIndex)}에 먼저 샘플을 저장하세요.`);
      return;
    }

    const nextEnabled = !loopEnabledRefs.current[padIndex];
    loopEnabledRefs.current[padIndex] = nextEnabled;
    setLoopEnabled((current) => replaceAt(current, padIndex, nextEnabled));
    setActivePad(padIndex);

    if (nextEnabled) {
      setStatus(
        `${padLabel(padIndex)} 루프 ON · ${formatDuration(sampleDuration(sample))}마다 반복합니다.`,
      );
      // Restart the pad so both the muted video and its Web Audio source use
      // the same loop boundaries immediately.
      void triggerSample(padIndex);
    } else {
      const audioSource = performanceAudioSourceRefs.current[padIndex];
      if (audioSource) audioSource.loop = false;
      setStatus(`${padLabel(padIndex)} 루프 OFF · 현재 재생 후 정지합니다.`);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const padIndex = PAD_KEY_CODES[event.code];
      if (padIndex === undefined || event.repeat || keyboardHeldRef.current.has(event.code)) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, button, select, textarea")) return;
      keyboardHeldRef.current.add(event.code);
      event.preventDefault();
      if (mode === "sample") startCapture(padIndex);
      else void triggerSample(padIndex);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const padIndex = PAD_KEY_CODES[event.code];
      if (padIndex === undefined || !keyboardHeldRef.current.has(event.code)) return;
      keyboardHeldRef.current.delete(event.code);
      event.preventDefault();
      if (mode === "sample") finishCapture(padIndex);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  });

  const switchMode = (nextMode: SamplerMode) => {
    if (nextMode === mode) return;
    finishAllCaptures();
    sourceVideoRef.current?.pause();
    PAD_INDICES.forEach((padIndex) => {
      performanceVideoRefs.current[padIndex]?.pause();
      triggerGenerationRefs.current[padIndex] += 1;
    });
    stopAllPadAudio();
    cancelAllVideoCallbacks();
    setIsPerforming(createPadValues(false));
    if (nextMode === "sample") {
      loopEnabledRefs.current = createPadValues(false);
      setLoopEnabled(createPadValues(false));
    }
    setMode(nextMode);

    if (nextMode === "perform") {
      PAD_INDICES.forEach((padIndex) => {
        const sample = samples[padIndex];
        if (sample) prepareSample(padIndex, sample);
      });
      setStatus(
        samples.some(Boolean)
          ? "PAD 01~04를 독립적으로 연주할 수 있습니다."
          : "샘플링 모드에서 패드를 먼저 채우세요.",
      );
    } else {
      setStatus("소스 영상을 재생한 뒤 원하는 패드를 누르고 있으세요.");
    }
  };

  const handlePadPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    padIndex: PadIndex,
  ) => {
    if (event.pointerType === "touch") return;
    event.preventDefault();
    if (mode === "sample") {
      event.currentTarget.setPointerCapture(event.pointerId);
      startCapture(padIndex);
    } else {
      // Pointer capture is only needed for hold-to-sample. Avoiding it while
      // performing lets separate fingers trigger separate pads independently.
      void triggerSample(padIndex);
    }
  };

  const handlePadPointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
    padIndex: PadIndex,
  ) => {
    if (event.pointerType === "touch") return;
    event.preventDefault();
    if (
      mode === "sample" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (mode === "sample") finishCapture(padIndex);
  };

  const handlePadTouchStart = (
    event: ReactTouchEvent<HTMLButtonElement>,
    padIndex: PadIndex,
  ) => {
    event.preventDefault();
    if (mode === "sample") startCapture(padIndex);
    else void triggerSample(padIndex);
  };

  const handlePadTouchEnd = (
    event: ReactTouchEvent<HTMLButtonElement>,
    padIndex: PadIndex,
  ) => {
    event.preventDefault();
    if (mode === "sample") finishCapture(padIndex);
  };

  const selectedSample = samples[activePad];
  const activeCaptureIndices = PAD_INDICES.filter((index) => isCapturing[index]);
  const activePerformanceCount = isPerforming.filter(Boolean).length;
  const currentMonitorTime =
    mode === "sample" ? sourceTime : performanceTimes[activePad] || selectedSample?.inSeconds || 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">VS</span>
          <div>
            <p className="eyebrow">FOUR PAD PROTOTYPE</p>
            <h1>Video Sampler</h1>
          </div>
        </div>
        <label className="file-picker">
          <span>{sources.length ? "영상 추가" : "영상 불러오기"}</span>
          <input
            type="file"
            accept="video/*"
            onChange={handleFileChange}
            disabled={isRecording}
          />
        </label>
      </header>

      <section className="mode-switch" aria-label="작업 모드">
        <button className={mode === "sample" ? "active" : ""} type="button" onClick={() => switchMode("sample")} disabled={isRecording}>
          <span>01</span>샘플링
        </button>
        <button className={mode === "perform" ? "active" : ""} type="button" onClick={() => switchMode("perform")} disabled={isRecording}>
          <span>02</span>연주
        </button>
      </section>

      <section className="workstation">
        <MonitorPanel
          mode={mode}
          sourceName={sourceName}
          sourceUrl={sourceUrl}
          sources={sources}
          activeSourceId={activeSourceId}
          activeCaptureIndices={activeCaptureIndices}
          isRecording={isRecording}
          duration={duration}
          sourceTime={sourceTime}
          currentMonitorTime={currentMonitorTime}
          activePerformanceCount={activePerformanceCount}
          isPerforming={isPerforming}
          isCapturing={isCapturing}
          captureLengths={captureLengths}
          samples={samples}
          selectedSample={selectedSample}
          sourceVideoRef={sourceVideoRef}
          performanceVideoRefs={performanceVideoRefs}
          recordingCanvasRef={recordingCanvasRef}
          setDuration={setDuration}
          setSourceTime={setSourceTime}
          setPerformanceTimes={setPerformanceTimes}
          setStatus={setStatus}
          selectSource={selectSource}
          finishAllCaptures={finishAllCaptures}
          handleSourceTimeUpdate={handleSourceTimeUpdate}
          toggleSourcePlayback={toggleSourcePlayback}
          seekSource={seekSource}
        />

        <ControlPanel
          mode={mode}
          bpm={bpm}
          isMetronomeOn={isMetronomeOn}
          metronomeBeat={metronomeBeat}
          isRecording={isRecording}
          recordingDownload={recordingDownload}
          samples={samples}
          isCapturing={isCapturing}
          isPerforming={isPerforming}
          captureLengths={captureLengths}
          loopEnabled={loopEnabled}
          activePad={activePad}
          canUndo={Boolean(undoEntryRef.current)}
          status={status}
          setBpm={setBpm}
          toggleMetronome={toggleMetronome}
          startRecording={startRecording}
          stopRecording={stopRecording}
          onPointerDown={handlePadPointerDown}
          onPointerUp={handlePadPointerUp}
          onTouchStart={handlePadTouchStart}
          onTouchEnd={handlePadTouchEnd}
          onToggleLoop={toggleSampleLoop}
          onUndo={undoOverwrite}
        />
      </section>

      <section className="latency-panel" aria-labelledby="latency-title">
        <div>
          <p className="panel-kicker">LIVE DIAGNOSTICS</p>
          <h2 id="latency-title">레이턴시 측정{lastLatencyPad !== null ? ` · ${padLabel(lastLatencyPad)}` : ""}</h2>
          <p>마지막으로 누른 패드의 브라우저 측정값입니다. 메트로놈은 Web Audio 시계로 예약합니다.</p>
        </div>
        <dl>
          <div><dt>play() 응답</dt><dd>{latency.playPromiseMs?.toFixed(1) ?? "—"}<small>ms</small></dd></div>
          <div><dt>첫 영상 프레임</dt><dd>{latency.firstFrameMs?.toFixed(1) ?? "—"}<small>ms</small></dd></div>
          <div><dt>Audio base</dt><dd>{latency.audioBaseMs?.toFixed(1) ?? "—"}<small>ms</small></dd></div>
          <div><dt>Audio output</dt><dd>{latency.audioOutputMs?.toFixed(1) ?? "—"}<small>ms</small></dd></div>
        </dl>
      </section>

      <footer>
        <span>LOCAL PROTOTYPE · NO UPLOAD</span>
        <span>PAD KEYS: A · S · D · F</span>
      </footer>
    </main>
  );
}

export default App;
