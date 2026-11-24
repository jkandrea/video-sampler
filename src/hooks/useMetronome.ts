import { useCallback, useEffect, useRef, useState } from "react";

type MetronomeOptions = {
  initializeAudioContext: () => Promise<AudioContext | null>;
  gainRef: { current: GainNode | null };
  recordingDestination: { current: MediaStreamAudioDestinationNode | null };
  recordingConnected: { current: boolean };
  setStatus: (message: string) => void;
};

export function useMetronome({
  initializeAudioContext,
  gainRef,
  recordingDestination,
  recordingConnected,
  setStatus,
}: MetronomeOptions) {
  const runningRef = useRef(false);
  const schedulerRef = useRef<number | null>(null);
  const visualTimersRef = useRef<number[]>([]);
  const nextTimeRef = useRef(0);
  const nextBeatRef = useRef(0);
  const bpmRef = useRef(120);
  const [bpm, setBpmState] = useState(120);
  const [isOn, setIsOn] = useState(false);
  const [beat, setBeat] = useState<number | null>(null);

  const silence = useCallback(() => {
    runningRef.current = false;
    if (schedulerRef.current !== null) {
      window.clearTimeout(schedulerRef.current);
      schedulerRef.current = null;
    }
    visualTimersRef.current.forEach(window.clearTimeout);
    visualTimersRef.current = [];
    const master = gainRef.current;
    if (master) {
      const context = master.context;
      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.setValueAtTime(0, context.currentTime);
      master.disconnect();
    }
    gainRef.current = null;
    recordingConnected.current = false;
  }, [gainRef, recordingConnected]);

  useEffect(() => silence, [silence]);

  const stop = useCallback(() => {
    silence();
    setIsOn(false);
    setBeat(null);
    setStatus("메트로놈을 정지했습니다.");
  }, [setStatus, silence]);

  const start = useCallback(async () => {
    const context = await initializeAudioContext();
    if (!context || runningRef.current) return;

    const master = context.createGain();
    master.gain.setValueAtTime(0.72, context.currentTime);
    master.connect(context.destination);
    if (recordingDestination.current) {
      master.connect(recordingDestination.current);
      recordingConnected.current = true;
    }
    gainRef.current = master;
    runningRef.current = true;
    nextTimeRef.current = context.currentTime + 0.06;
    nextBeatRef.current = 0;
    setIsOn(true);
    setStatus(`메트로놈 재생 중 · ${bpmRef.current} BPM`);

    const scheduleClick = (time: number, currentBeat: number) => {
      const oscillator = context.createOscillator();
      const clickGain = context.createGain();
      oscillator.frequency.setValueAtTime(currentBeat === 0 ? 1320 : 880, time);
      clickGain.gain.setValueAtTime(0.0001, time);
      clickGain.gain.exponentialRampToValueAtTime(
        currentBeat === 0 ? 0.22 : 0.13,
        time + 0.002,
      );
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
        visualTimersRef.current = visualTimersRef.current.filter(
          (timer) => timer !== visualTimer,
        );
        if (runningRef.current) setBeat(currentBeat);
      }, delay);
      visualTimersRef.current.push(visualTimer);
    };

    const scheduler = () => {
      if (!runningRef.current) return;
      while (nextTimeRef.current < context.currentTime + 0.1) {
        scheduleClick(nextTimeRef.current, nextBeatRef.current);
        nextTimeRef.current += 60 / bpmRef.current;
        nextBeatRef.current = (nextBeatRef.current + 1) % 4;
      }
      schedulerRef.current = window.setTimeout(scheduler, 25);
    };
    scheduler();
  }, [
    gainRef,
    initializeAudioContext,
    recordingConnected,
    recordingDestination,
    setStatus,
  ]);

  const toggle = useCallback(() => {
    if (runningRef.current) stop();
    else void start();
  }, [start, stop]);

  const setBpm = useCallback((value: number) => {
    const next = Math.min(240, Math.max(40, value || 40));
    bpmRef.current = next;
    setBpmState(next);
  }, []);

  return { bpm, isOn, beat, setBpm, toggle };
}
