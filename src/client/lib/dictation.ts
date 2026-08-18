// MediaRecorder + interim-polling dictation, shared by every free-text field
// that offers a mic button (StartDialog, plan feedback, feature comments).
// True streaming ASR isn't available from a one-shot Whisper call, so
// "streaming" is simulated by re-transcribing the growing recording on a
// fixed interval while the user talks.

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { isJsonObject, isString } from '../../shared/json.ts';

export interface Dictation {
  supported: boolean;
  recording: boolean;
  interim: string;
  start: () => void;
  stop: () => void;
}

const POLL_INTERVAL_MS = 4000;
const MAX_RECORDING_MS = 120000;

async function postAudio(blob: Blob, signal: AbortSignal): Promise<string> {
  const fd = new FormData();
  fd.append('audio', blob, 'dictation.webm');
  const res = await fetch('/api/transcribe', { method: 'POST', body: fd, signal });
  const body = await res.json().catch(() => null);
  const data = isJsonObject(body) ? body : null;
  if (!res.ok) {
    throw new Error(data && isString(data.error) ? data.error : 'transcription failed');
  }
  return data && isString(data.text) ? data.text : '';
}

export function useDictation(onFinal: (text: string) => void): Dictation {
  const supported =
    'navigator' in globalThis &&
    !!navigator.mediaDevices?.getUserMedia &&
    'MediaRecorder' in globalThis;

  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const pollTimerRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  // Set right before requestData() so the ondataavailable handler knows this
  // flush (as opposed to the recorder's own internal buffering) is the one
  // that should kick off an interim transcription.
  const pendingInterimRef = useRef(false);
  // Guards a slow interim response from clobbering a newer one's preview.
  const requestIdRef = useRef(0);
  const interimAbortRef = useRef<AbortController | null>(null);

  const clearTimers = () => {
    if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
    if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current);
    pollTimerRef.current = null;
    stopTimerRef.current = null;
  };

  const releaseStream = () => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
  };

  // Unmount safety net for call sites where the hook's owning component
  // itself is torn down while recording (e.g. StartDialog closing) — call
  // sites where the hook outlives a child popover/composer must call stop()
  // explicitly instead, since this only fires on the hook's own unmount.
  useEffect(() => {
    return () => {
      clearTimers();
      interimAbortRef.current?.abort();
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
      releaseStream();
    };
  }, []);

  const stop = () => {
    const recorder = recorderRef.current;
    clearTimers();
    interimAbortRef.current?.abort();
    interimAbortRef.current = null;
    if (!recorder || recorder.state === 'inactive') {
      releaseStream();
      setRecording(false);
      setInterim('');
      return;
    }
    recorder.addEventListener(
      'stop',
      () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];
        releaseStream();
        postAudio(blob, new AbortController().signal)
          .then((text) => onFinal(text))
          .catch(() => toast.error('Transcription failed'))
          .finally(() => {
            setRecording(false);
            setInterim('');
          });
      },
      { once: true },
    );
    recorder.stop();
  };

  const start = async () => {
    if (!supported || recording) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error('Microphone access was denied');
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    pendingInterimRef.current = false;
    setInterim('');
    setRecording(true);

    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
      if (!pendingInterimRef.current) return;
      pendingInterimRef.current = false;
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      if (blob.size === 0) return;
      const id = ++requestIdRef.current;
      interimAbortRef.current?.abort();
      const controller = new AbortController();
      interimAbortRef.current = controller;
      postAudio(blob, controller.signal)
        .then((text) => {
          if (id === requestIdRef.current) setInterim(text);
        })
        .catch(() => {
          // A flaky interim tick just means this tick's preview doesn't
          // update — only the final transcription's failure surfaces.
        });
    };
    recorder.start();

    pollTimerRef.current = window.setInterval(() => {
      if (recorderRef.current?.state !== 'recording') return;
      pendingInterimRef.current = true;
      recorderRef.current.requestData();
    }, POLL_INTERVAL_MS);

    stopTimerRef.current = window.setTimeout(stop, MAX_RECORDING_MS);
  };

  return { supported, recording, interim, start, stop };
}
