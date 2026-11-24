import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
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

type AudioContextWithLatency = AudioContext & { outputLatency?: number };
type PadIndex = 0 | 1 | 2 | 3;
type UndoEntry = { padIndex: PadIndex; previousSample: VideoSample };
type SourceAsset = { id: string; name: string; url: string };

const PAD_INDICES: PadIndex[] = [0, 1, 2, 3];
const PAD_KEYS = ["A", "S", "D", "F"] as const;
const PAD_KEY_CODES: Record<string, PadIndex> = {
  KeyA: 0,
  KeyS: 1,
  KeyD: 2,
  KeyF: 3,
};
const EMPTY_LATENCY: LatencyReading = {
  playPromiseMs: null,
  firstFrameMs: null,
  audioBaseMs: null,
  audioOutputMs: null,
};

function createPadValues<T>(value: T): T[] {
  return PAD_INDICES.map(() => value);
}

function replaceAt<T>(values: readonly T[], index: PadIndex, value: T): T[] {
  const next = [...values];
  next[index] = value;
  return next;
}

function padLabel(index: PadIndex): string {
  return `PAD ${String(index + 1).padStart(2, "0")}`;
}

function App() {
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const performanceVideoRefs = useRef<Array<HTMLVideoElement | null>>(
    createPadValues(null),
  );
  const sourceAssetsRef = useRef<SourceAsset[]>([]);
  const audioContextRef = useRef<AudioContextWithLatency | null>(null);
  const performanceAudioSourceRefs = useRef<Array<MediaElementAudioSourceNode | null>>(
    createPadValues(null),
  );
  const captureStartRefs = useRef<Array<number | null>>(createPadValues(null));
  const stopFrameRequestRefs = useRef<Array<number | null>>(createPadValues(null));
  const latencyFrameRequestRefs = useRef<Array<number | null>>(createPadValues(null));
  const triggerGenerationRefs = useRef<number[]>(createPadValues(0));
  const keyboardHeldRef = useRef(new Set<string>());
  const undoEntryRef = useRef<UndoEntry | null>(null);
  const loopEnabledRefs = useRef<boolean[]>(createPadValues(false));

  const metronomeRunningRef = useRef(false);
  const metronomeSchedulerRef = useRef<number | null>(null);
  const metronomeVisualTimersRef = useRef<number[]>([]);
  const metronomeGainRef = useRef<GainNode | null>(null);
  const metronomeNextTimeRef = useRef(0);
  const metronomeNextBeatRef = useRef(0);
  const bpmRef = useRef(120);

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
  const [bpm, setBpm] = useState(120);
  const [isMetronomeOn, setIsMetronomeOn] = useState(false);
  const [metronomeBeat, setMetronomeBeat] = useState<number | null>(null);

  const activeSource =
    sources.find((source) => source.id === activeSourceId) ?? null;
  const sourceUrl = activeSource?.url ?? null;
  const sourceName = activeSource?.name ?? "";

  useEffect(() => {
    bpmRef.current = bpm;
  }, [bpm]);

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

  const silenceMetronome = useCallback(() => {
    metronomeRunningRef.current = false;
    if (metronomeSchedulerRef.current !== null) {
      window.clearTimeout(metronomeSchedulerRef.current);
      metronomeSchedulerRef.current = null;
    }
    metronomeVisualTimersRef.current.forEach(window.clearTimeout);
    metronomeVisualTimersRef.current = [];

    const context = audioContextRef.current;
    const master = metronomeGainRef.current;
    if (context && master) {
      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.setValueAtTime(0, context.currentTime);
      master.disconnect();
    }
    metronomeGainRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cancelAllVideoCallbacks();
      silenceMetronome();
      releaseSourceUrls();
      void audioContextRef.current?.close();
    };
  }, [cancelAllVideoCallbacks, releaseSourceUrls, silenceMetronome]);

  const initializeAudioContext = useCallback(async () => {
    const Context = window.AudioContext;
    if (!Context) return null;
    if (!audioContextRef.current) {
      audioContextRef.current = new Context({ latencyHint: "interactive" });
    }

    const context = audioContextRef.current;
    PAD_INDICES.forEach((padIndex) => {
      const video = performanceVideoRefs.current[padIndex];
      if (!video || performanceAudioSourceRefs.current[padIndex]) return;
      const source = context.createMediaElementSource(video);
      source.connect(context.destination);
      performanceAudioSourceRefs.current[padIndex] = source;
    });

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

  const stopMetronome = useCallback(() => {
    silenceMetronome();
    setIsMetronomeOn(false);
    setMetronomeBeat(null);
    setStatus("메트로놈을 정지했습니다.");
  }, [silenceMetronome]);

  const startMetronome = useCallback(async () => {
    const context = await initializeAudioContext();
    if (!context || metronomeRunningRef.current) return;

    const master = context.createGain();
    master.gain.setValueAtTime(0.72, context.currentTime);
    master.connect(context.destination);
    metronomeGainRef.current = master;
    metronomeRunningRef.current = true;
    metronomeNextTimeRef.current = context.currentTime + 0.06;
    metronomeNextBeatRef.current = 0;
    setIsMetronomeOn(true);
    setStatus(`메트로놈 재생 중 · ${bpmRef.current} BPM`);

    const scheduleClick = (time: number, beat: number) => {
      const oscillator = context.createOscillator();
      const clickGain = context.createGain();
      oscillator.frequency.setValueAtTime(beat === 0 ? 1320 : 880, time);
      clickGain.gain.setValueAtTime(0.0001, time);
      clickGain.gain.exponentialRampToValueAtTime(beat === 0 ? 0.22 : 0.13, time + 0.002);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
      oscillator.connect(clickGain);
      clickGain.connect(master);
      oscillator.start(time);
      oscillator.stop(time + 0.05);
      oscillator.onended = () => {
        oscillator.disconnect();
        clickGain.disconnect();
      };

      const delay = Math.max(0, (time - context.currentTime) * 1000);
      const visualTimer = window.setTimeout(() => {
        metronomeVisualTimersRef.current = metronomeVisualTimersRef.current.filter(
          (timer) => timer !== visualTimer,
        );
        if (metronomeRunningRef.current) setMetronomeBeat(beat);
      }, delay);
      metronomeVisualTimersRef.current.push(visualTimer);
    };

    const scheduler = () => {
      if (!metronomeRunningRef.current) return;
      while (metronomeNextTimeRef.current < context.currentTime + 0.1) {
        scheduleClick(metronomeNextTimeRef.current, metronomeNextBeatRef.current);
        metronomeNextTimeRef.current += 60 / bpmRef.current;
        metronomeNextBeatRef.current = (metronomeNextBeatRef.current + 1) % 4;
      }
      metronomeSchedulerRef.current = window.setTimeout(scheduler, 25);
    };

    scheduler();
  }, [initializeAudioContext]);

  const toggleMetronome = () => {
    if (metronomeRunningRef.current) stopMetronome();
    else void startMetronome();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    finishAllCaptures();
    PAD_INDICES.forEach((padIndex) => {
      triggerGenerationRefs.current[padIndex] += 1;
      performanceVideoRefs.current[padIndex]?.pause();
    });
    cancelAllVideoCallbacks();
    sourceVideoRef.current?.pause();

    const sourceId = crypto.randomUUID();
    const nextUrl = URL.createObjectURL(file);
    const nextSource: SourceAsset = { id: sourceId, name: file.name, url: nextUrl };
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
    [],
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
        await Promise.all([playRequest, audioInitialization, metadataReady]);
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
      initializeAudioContext,
      samples,
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
      if (!isPerforming[padIndex]) void triggerSample(padIndex);
    } else {
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
    event.preventDefault();
    if (
      mode === "sample" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
          <input type="file" accept="video/*" onChange={handleFileChange} />
        </label>
      </header>

      <section className="mode-switch" aria-label="작업 모드">
        <button className={mode === "sample" ? "active" : ""} type="button" onClick={() => switchMode("sample")}>
          <span>01</span>샘플링
        </button>
        <button className={mode === "perform" ? "active" : ""} type="button" onClick={() => switchMode("perform")}>
          <span>02</span>연주
        </button>
      </section>

      <section className="workstation">
        <div className="monitor-panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">{mode === "sample" ? "SOURCE MONITOR" : "OUTPUT MONITOR"}</p>
              <div className="source-heading">
                <h2>{sourceName || "No source loaded"}</h2>
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
            <div className={`live-indicator ${activeCaptureIndices.length ? "recording" : ""}`}>
              <span />
              {activeCaptureIndices.length ? "SAMPLING" : mode === "perform" ? "READY" : "SOURCE"}
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

                <div className={`performance-grid ${mode === "perform" ? "visible" : "hidden-video"} active-${activePerformanceCount}`}>
                  {PAD_INDICES.map((padIndex) => (
                    <video
                      key={padIndex}
                      ref={(element) => {
                        performanceVideoRefs.current[padIndex] = element;
                      }}
                      className={isPerforming[padIndex] ? "performance-active" : "performance-idle"}
                      src={
                        sources.find(
                          (source) => source.id === samples[padIndex]?.sourceId,
                        )?.url
                      }
                      playsInline
                      preload="auto"
                      onLoadedMetadata={(event) => {
                        const sample = samples[padIndex];
                        if (sample) event.currentTarget.currentTime = sample.inSeconds;
                      }}
                      onTimeUpdate={(event) => {
                        const time = event.currentTarget.currentTime;
                        setPerformanceTimes((current) => replaceAt(current, padIndex, time));
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
                <b>{formatDuration(Math.max(...activeCaptureIndices.map((index) => captureLengths[index])))}</b>
              </div>
            )}
          </div>

          <div className="transport">
            <time>{formatClock(currentMonitorTime)}</time>
            {mode === "sample" ? (
              <>
                <button type="button" onClick={() => seekSource(-5)} disabled={!sourceUrl || isCapturing.some(Boolean)} aria-label="5초 뒤로">−5s</button>
                <button className="play-button" type="button" onClick={() => void toggleSourcePlayback()} disabled={!sourceUrl}>
                  {sourceVideoRef.current?.paused === false ? "Ⅱ" : "▶"}
                </button>
                <button type="button" onClick={() => seekSource(5)} disabled={!sourceUrl || isCapturing.some(Boolean)} aria-label="5초 앞으로">+5s</button>
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
                <span>{selectedSample ? formatClock(selectedSample.inSeconds) : "--:--.---"}</span>
                <div />
                <span>{selectedSample ? formatClock(selectedSample.outSeconds) : "--:--.---"}</span>
              </div>
            )}
            <time>{formatClock(mode === "sample" ? duration : selectedSample?.outSeconds ?? 0)}</time>
          </div>
        </div>

        <aside className="control-panel">
          <div className="instruction-block">
            <p className="panel-kicker">{mode === "sample" ? "CAPTURE PADS" : "PERFORMANCE PADS · RETRIGGER"}</p>
            <h2>{mode === "sample" ? "장면이 나오는 동안 누르세요" : "네 장면을 자유롭게 연주하세요"}</h2>
            <p>
              {mode === "sample"
                ? "영상을 여러 개 추가하고 소스를 바꿔가며 패드마다 다른 구간을 저장할 수 있습니다."
                : "네 패드는 독립적으로 겹쳐 재생됩니다. LOOP를 켜면 각 샘플의 IN~OUT 길이로 반복합니다."}
            </p>
          </div>

          <div className="metronome-panel">
            <button className={isMetronomeOn ? "metronome-toggle active" : "metronome-toggle"} type="button" onClick={toggleMetronome} aria-pressed={isMetronomeOn}>
              <span>{isMetronomeOn ? "■" : "▶"}</span> METRONOME
            </button>
            <label className="bpm-control">
              <span>BPM</span>
              <input
                type="number"
                min="40"
                max="240"
                value={bpm}
                onChange={(event) => {
                  const next = Math.min(240, Math.max(40, Number(event.target.value) || 40));
                  bpmRef.current = next;
                  setBpm(next);
                }}
              />
            </label>
            <div className="beat-lights" aria-label={`4박자 중 ${metronomeBeat === null ? 0 : metronomeBeat + 1}박`}>
              {[0, 1, 2, 3].map((beat) => (
                <span key={beat} className={`${metronomeBeat === beat && isMetronomeOn ? "active" : ""} ${beat === 0 ? "accent" : ""}`} />
              ))}
            </div>
            <p className="loop-station-note">LOOP STATION · SAMPLE LENGTH</p>
          </div>

          <div className="pad-grid">
            {PAD_INDICES.map((padIndex) => {
              const sample = samples[padIndex];
              return (
                <div className={`pad-slot ${activePad === padIndex ? "selected" : ""}`} key={padIndex}>
                  <button
                    className={`sampler-pad ${isCapturing[padIndex] ? "capturing" : ""} ${isPerforming[padIndex] ? "performing" : ""} ${sample ? "loaded" : ""}`}
                    type="button"
                    onPointerDown={(event) => handlePadPointerDown(event, padIndex)}
                    onPointerUp={(event) => handlePadPointerUp(event, padIndex)}
                    onPointerCancel={(event) => handlePadPointerUp(event, padIndex)}
                    onContextMenu={(event) => event.preventDefault()}
                    aria-label={mode === "sample" ? `${padLabel(padIndex)}, 누르고 있는 동안 영상 구간 수집` : `${padLabel(padIndex)}, 저장된 영상 샘플 재생`}
                  >
                    <span className="pad-number">{String(padIndex + 1).padStart(2, "0")}</span>
                    <span className="pad-state">
                      {isCapturing[padIndex] ? "CAPTURING" : isPerforming[padIndex] ? "PLAYING" : sample ? "LOADED" : "EMPTY"}
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
                    <div><span>IN</span><strong>{sample ? formatClock(sample.inSeconds) : "--:--.---"}</strong></div>
                    <div><span>OUT</span><strong>{sample ? formatClock(sample.outSeconds) : "--:--.---"}</strong></div>
                  </div>
                  <div className="pad-utility-row">
                    <span className="sample-source-name" title={sample?.sourceName}>
                      {sample?.sourceName ?? "NO SOURCE"}
                    </span>
                    <button
                      className={loopEnabled[padIndex] ? "loop-toggle active" : "loop-toggle"}
                      type="button"
                      onClick={() => toggleSampleLoop(padIndex)}
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

          <button className="undo-button" type="button" onClick={undoOverwrite} disabled={!undoEntryRef.current}>
            ↶ 마지막 덮어쓰기 취소
          </button>
          <div className="status-line" role="status" aria-live="polite">
            <span className={isCapturing.some(Boolean) || isPerforming.some(Boolean) ? "pulse" : ""} />
            {status}
          </div>
        </aside>
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
