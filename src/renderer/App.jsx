import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Circle,
  FileText,
  FolderOpen,
  Check,
  Loader2,
  Mic,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  AudioWaveform,
  Captions,
  X
} from 'lucide-react';
import { decodeToMono16k, resample } from './audio.js';
import { recordingsApi, refinementApi, whisperEngineApi } from './platform.js';
import './styles.css';

const EMPTY_MARKDOWN = '# Ready to record\n\nPress the record button to capture audio from your MacBook microphone. The transcript will be saved as markdown after Whisper finishes.';
const MODEL_LABEL = 'homelab stt large-v3';

function App() {
  const [recordings, setRecordings] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [markdown, setMarkdown] = useState(EMPTY_MARKDOWN);
  const [status, setStatus] = useState('checking');
  const [statusText, setStatusText] = useState('Checking Homelab STT setup');
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState('');
  const [liveChunks, setLiveChunks] = useState([]);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [refinementPrompt, setRefinementPrompt] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [liveTranscription, setLiveTranscription] = useState(false);
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [promptSaveState, setPromptSaveState] = useState('Saved');
  const [audioUrl, setAudioUrl] = useState('');
  const [audioFileName, setAudioFileName] = useState('');
  const [waveformPeaks, setWaveformPeaks] = useState([]);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioTime, setAudioTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef(null);
  const audioContextRef = useRef(null);
  const liveProcessorRef = useRef(null);
  const liveMuteRef = useRef(null);
  const liveTimerRef = useRef(null);
  const liveSamplesRef = useRef([]);
  const liveInFlightRef = useRef(false);
  const liveSequenceRef = useRef(0);
  const liveOffsetMsRef = useRef(0);
  const liveSourceRateRef = useRef(48000);
  const transcriptPreRef = useRef(null);
  const audioRef = useRef(null);

  const selectedRecording = useMemo(
    () => recordings.find((recording) => recording.id === selectedId),
    [recordings, selectedId]
  );
  const liveTranscript = useMemo(
    () =>
      liveChunks
        .slice()
        .sort((a, b) => a.sequence - b.sequence)
        .map((chunk) => chunk.text.trim())
        .filter(Boolean)
        .join('\n'),
    [liveChunks]
  );
  const paneMarkdown =
    isRecording || status === 'preparing'
      ? `# Live Transcript\n\n${liveTranscript || '_Listening..._'}`
      : markdown;

  useEffect(() => {
    refreshRecordings();
    refreshEngineStatus();
    refreshRefinementPrompt();
  }, []);

  useEffect(() => {
    if (!promptLoaded) {
      return;
    }

    setPromptSaveState('Saving...');
    const timeout = setTimeout(async () => {
      await refinementApi.savePrompt(refinementPrompt);
      setPromptSaveState('Saved');
    }, 500);

    return () => clearTimeout(timeout);
  }, [refinementPrompt, promptLoaded]);

  useEffect(() => {
    if (isRecording || status === 'preparing') {
      scrollTranscriptToBottom();
    }
  }, [liveTranscript, isRecording, status]);

  useEffect(() => {
    loadSelectedAudio();
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [selectedId]);

  async function refreshRecordings() {
    const items = await recordingsApi.list();
    setRecordings(items);

    if (items.length && !selectedId) {
      setSelectedId(items[0].id);
      const content = await recordingsApi.readMarkdown(items[0].id);
      setMarkdown(content || EMPTY_MARKDOWN);
    }
  }

  async function selectRecording(recording) {
    setSelectedId(recording.id);
    setMarkdown((await recordingsApi.readMarkdown(recording.id)) || EMPTY_MARKDOWN);
  }

  async function refreshEngineStatus() {
    const engine = await whisperEngineApi.status();
    setStatus(engine.state);
    setStatusText(engine.message);
    if (engine.state === 'ready') {
      setError('');
    }
  }

  async function refreshRefinementPrompt() {
    setRefinementPrompt(await refinementApi.getPrompt());
    setPromptLoaded(true);
    setPromptSaveState('Saved');
  }

  async function startRecording() {
    setError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1
        }
      });

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      chunksRef.current = [];
      liveSamplesRef.current = [];
      liveSequenceRef.current = 0;
      liveOffsetMsRef.current = 0;
      setLiveChunks([]);
      if (liveTranscription) {
        await startLivePreview(stream);
      }
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      startedAtRef.current = Date.now();

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener('stop', async () => {
        stream.getTracks().forEach((track) => track.stop());
        await handleRecordingComplete(new Blob(chunksRef.current, { type: mimeType }));
      });

      recorder.start();
      setIsRecording(true);
      setStatus('recording');
      setStatusText('Recording microphone audio');
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current);
      }, 250);
      if (liveTranscription) {
        liveTimerRef.current = setInterval(() => {
          void flushLiveChunk(false);
        }, 7000);
      }
    } catch (recordError) {
      setError(recordError.message);
      setStatus('error');
      setStatusText('Could not access microphone');
    }
  }

  function stopRecording() {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      return;
    }

    mediaRecorderRef.current.stop();
    clearInterval(timerRef.current);
    clearInterval(liveTimerRef.current);
    if (liveTranscription) {
      void flushLiveChunk(true);
    }
    stopLivePreview();
    setElapsedMs(Date.now() - startedAtRef.current);
    setIsRecording(false);
    setStatus('preparing');
    setStatusText('Preparing audio for Whisper');
  }

  async function handleRecordingComplete(blob) {
    try {
      const saved = await recordingsApi.saveAudio({
        durationMs: elapsedMs || Date.now() - startedAtRef.current,
        audio: await blob.arrayBuffer()
      });
      const content = await recordingsApi.readMarkdown(saved.id);
      setSelectedId(saved.id);
      setMarkdown(content || EMPTY_MARKDOWN);
      await refreshRecordings();
      setStatus('ready');
      setStatusText('Audio saved');
    } catch (decodeError) {
      setError(decodeError.message);
      setStatus('error');
      setStatusText('Could not save audio');
    }
  }

  async function revealSelected() {
    if (selectedId) {
      await recordingsApi.reveal(selectedId);
    }
  }

  async function refineSelected() {
    if (!selectedRecording?.transcribed || isRefining) {
      return;
    }

    try {
      setError('');
      setIsRefining(true);
      setStatus('refining');
      setStatusText('Refining transcript with Codex CLI');
      const refined = await recordingsApi.refineWithCodex(selectedRecording.id, refinementPrompt);
      const items = await recordingsApi.list();
      setRecordings(items);
      setSelectedId(refined.id);
      setMarkdown((await recordingsApi.readMarkdown(refined.id)) || EMPTY_MARKDOWN);
      setStatus('ready');
      setStatusText('Refined notes saved');
    } catch (refineError) {
      setError(refineError.message);
      setStatus('error');
      setStatusText('Codex refinement failed');
    } finally {
      setIsRefining(false);
    }
  }

  async function transcribeSelected() {
    if (!selectedRecording?.audioFile || selectedRecording.refined || isTranscribing) {
      return;
    }

    try {
      setError('');
      setIsTranscribing(true);
      setStatus('transcribing');
      setStatusText('Transcribing selected recording');
      const updated = await recordingsApi.transcribeExisting(selectedRecording.id);
      const items = await recordingsApi.list();
      setRecordings(items);
      setSelectedId(updated.id);
      setMarkdown((await recordingsApi.readMarkdown(updated.id)) || EMPTY_MARKDOWN);
      setStatus('ready');
      setStatusText('Transcript and MP3 saved');
      await loadSelectedAudio(updated.id);
    } catch (transcribeError) {
      setError(transcribeError.message);
      setStatus('error');
      setStatusText('Transcription failed');
    } finally {
      setIsTranscribing(false);
    }
  }

  function beginRename() {
    if (!selectedRecording) {
      return;
    }
    setRenameValue(selectedRecording.markdownFile.replace(/\.md$/i, ''));
    setIsRenaming(true);
  }

  async function submitRename(event) {
    event?.preventDefault();
    if (!selectedRecording || !renameValue.trim()) {
      setIsRenaming(false);
      return;
    }

    try {
      const updated = await recordingsApi.renameMarkdown(selectedRecording.id, renameValue);
      const items = await recordingsApi.list();
      setRecordings(items);
      setSelectedId(updated.id);
      setMarkdown((await recordingsApi.readMarkdown(updated.id)) || EMPTY_MARKDOWN);
      setIsRenaming(false);
    } catch (renameError) {
      setError(renameError.message);
      setStatus('error');
      setStatusText('Rename failed');
    }
  }

  async function startLivePreview(stream) {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      return;
    }

    const audioContext = new AudioContextConstructor();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    liveSourceRateRef.current = audioContext.sampleRate;

    processor.onaudioprocess = (event) => {
      if (!isRecordingRef(mediaRecorderRef.current)) {
        return;
      }
      liveSamplesRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };

    source.connect(processor);
    processor.connect(mute);
    mute.connect(audioContext.destination);
    audioContextRef.current = audioContext;
    liveProcessorRef.current = processor;
    liveMuteRef.current = mute;
  }

  function stopLivePreview() {
    liveProcessorRef.current?.disconnect();
    liveMuteRef.current?.disconnect();
    liveProcessorRef.current = null;
    liveMuteRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
  }

  async function flushLiveChunk(force) {
    if (!liveTranscription) {
      return;
    }
    if (liveInFlightRef.current || liveSamplesRef.current.length === 0) {
      return;
    }

    const chunk = concatenateSamples(liveSamplesRef.current);
    const sourceRate = liveSourceRateRef.current;
    const durationMs = Math.round((chunk.length / sourceRate) * 1000);
    if (!force && durationMs < 3500) {
      return;
    }

    liveSamplesRef.current = [];
    liveInFlightRef.current = true;
    const sequence = liveSequenceRef.current;
    const offsetMs = liveOffsetMsRef.current;
    liveSequenceRef.current += 1;
    liveOffsetMsRef.current += durationMs;

    try {
      const samples = resample(chunk, sourceRate, 16000);
      const result = await recordingsApi.transcribeChunk({
        samples,
        sampleRate: 16000,
        sequence,
        offsetMs
      });
      if (result.text?.trim()) {
        setLiveChunks((current) => [...current, result]);
      }
    } catch (chunkError) {
      setError(chunkError.message);
    } finally {
      liveInFlightRef.current = false;
    }
  }

  async function loadSelectedAudio(id = selectedId) {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }

    setAudioUrl('');
    setAudioFileName('');
    setWaveformPeaks([]);
    setAudioDuration(0);
    setAudioTime(0);
    setIsPlaying(false);

    if (!id) {
      return;
    }

    try {
      const audio = await recordingsApi.readAudio(id);
      if (!audio?.data || audio.data.byteLength === 0) {
        return;
      }

      const blob = new Blob([audio.data], { type: audio.mimeType });
      setAudioUrl(URL.createObjectURL(blob));
      setAudioFileName(audio.fileName);
      setWaveformPeaks(await createWaveformPeaks(audio.data));
    } catch {
      setWaveformPeaks([]);
    }
  }

  function scrollTranscriptToBottom() {
    requestAnimationFrame(() => {
      const element = transcriptPreRef.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }

  async function togglePlayback() {
    if (!audioRef.current || !audioUrl) {
      return;
    }

    if (audioRef.current.paused) {
      await audioRef.current.play();
      return;
    }

    audioRef.current.pause();
  }

  function seekAudio(value) {
    if (!audioRef.current) {
      return;
    }

    audioRef.current.currentTime = Number(value);
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">
            <AudioWaveform size={24} />
          </div>
          <div>
            <h1>Whisper Recorder</h1>
            <p>Local speech to markdown</p>
          </div>
        </div>

        <div className="navHeader">
          <span>Recordings</span>
          <button className="iconButton" onClick={refreshRecordings} title="Refresh recordings">
            <RefreshCw size={17} />
          </button>
        </div>

        <div className="recordingList">
          {recordings.length === 0 ? (
            <div className="emptyState">
              <FileText size={18} />
              <span>No recordings yet</span>
            </div>
          ) : (
            recordings.map((recording) => (
              <button
                key={recording.id}
                className={`recordingItem ${selectedId === recording.id ? 'active' : ''}`}
                onClick={() => selectRecording(recording)}
              >
                <span className="recordingTitle">{recording.title}</span>
                <span className="recordingMeta">
                  {new Date(recording.createdAt).toLocaleDateString()} · {formatDuration(recording.durationMs)}
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div className="statusCluster">
            <span className={`statusDot ${status}`} />
            <div>
              <p>{statusText}</p>
              {status === 'transcribing' && <span>Large-v3 can take a moment on longer recordings</span>}
              {error && <span className="errorText">{error}</span>}
            </div>
          </div>

          <div className="toolbarActions">
            <button
              className="secondaryButton"
              onClick={transcribeSelected}
              disabled={
                !selectedRecording?.audioFile ||
                selectedRecording?.refined ||
                isRecording ||
                isTranscribing ||
                status === 'preparing' ||
                status === 'transcribing'
              }
              title="Transcribe selected audio"
            >
              {isTranscribing ? <Loader2 className="spin" size={18} /> : <Captions size={18} />}
              <span>{selectedRecording?.transcribed ? 'Retranscribe' : 'Transcribe'}</span>
            </button>
            <button
              className="secondaryButton"
              onClick={refineSelected}
              disabled={!selectedRecording?.transcribed || isRecording || isRefining || status === 'transcribing' || status === 'preparing'}
              title="Refine transcript with Codex CLI"
            >
              {isRefining ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
              <span>Refine</span>
            </button>
            <button
              className="secondaryButton"
              onClick={revealSelected}
              disabled={!selectedRecording}
              title="Show markdown file in Finder"
            >
              <FolderOpen size={18} />
              <span>Show file</span>
            </button>
            <button
              className={`recordButton ${isRecording ? 'recording' : ''}`}
              onClick={isRecording ? stopRecording : startRecording}
              disabled={status === 'preparing' || status === 'transcribing' || status === 'checking' || status === 'refining'}
            >
              {status === 'transcribing' ? (
                <Loader2 className="spin" size={20} />
              ) : isRecording ? (
                <Square size={20} fill="currentColor" />
              ) : (
                <Mic size={20} />
              )}
              <span>{isRecording ? 'Stop' : 'Record'}</span>
            </button>
          </div>
        </header>

        <div className="content">
          <section className="recordPanel">
            <div className="meter">
              <div className={`pulse ${isRecording ? 'live' : ''}`}>
                {isRecording ? <Pause size={32} /> : <Play size={32} />}
              </div>
              <div>
                <p className="timer">{formatDuration(isRecording ? elapsedMs : selectedRecording?.durationMs || elapsedMs)}</p>
                <p className="timerLabel">{isRecording ? 'Recording' : selectedRecording ? 'Selected recording' : 'Ready'}</p>
              </div>
            </div>
            <div className="modelInfo">
              <Circle size={12} fill="currentColor" />
              <span>{MODEL_LABEL}</span>
            </div>
            <label className="toggleRow">
              <input
                type="checkbox"
                checked={liveTranscription}
                onChange={(event) => setLiveTranscription(event.target.checked)}
              />
              <span>Live transcription via Homelab</span>
            </label>
            <section className="audioPanel">
              <div className="audioPanelHeader">
                <span>{audioFileName || 'No audio selected'}</span>
              </div>
              <div className="waveform" aria-label="Audio waveform">
                {waveformPeaks.length ? (
                  waveformPeaks.map((peak, index) => (
                    <span
                      key={`${index}-${peak}`}
                      style={{ height: `${Math.max(8, Math.round(peak * 100))}%` }}
                    />
                  ))
                ) : (
                  <div className="waveformEmpty" />
                )}
              </div>
              <div className="playbackControls">
                <button className="iconButton" onClick={togglePlayback} disabled={!audioUrl} title="Play or pause audio">
                  {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <input
                  aria-label="Audio playback position"
                  type="range"
                  min="0"
                  max={audioDuration || 0}
                  step="0.01"
                  value={Math.min(audioTime, audioDuration || 0)}
                  disabled={!audioUrl || !audioDuration}
                  onChange={(event) => seekAudio(event.target.value)}
                />
                <span>{formatPlaybackTime(audioTime)} / {formatPlaybackTime(audioDuration)}</span>
              </div>
              <audio
                ref={audioRef}
                src={audioUrl}
                onLoadedMetadata={(event) => setAudioDuration(event.currentTarget.duration || 0)}
                onTimeUpdate={(event) => setAudioTime(event.currentTarget.currentTime || 0)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
              />
            </section>
            <label className="promptPanel">
              <span>Refinement Prompt · {promptSaveState}</span>
              <textarea
                aria-label="Refinement prompt"
                value={refinementPrompt}
                onChange={(event) => setRefinementPrompt(event.target.value)}
                spellCheck="true"
              />
            </label>
          </section>

          <section className="markdownPane">
            <div className="paneHeader">
              <FileText size={18} />
              {isRenaming ? (
                <form className="renameForm" onSubmit={submitRename}>
                  <input
                    aria-label="Markdown file name"
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setIsRenaming(false);
                      }
                    }}
                  />
                  <button className="iconButton" type="submit" title="Save markdown file name">
                    <Check size={16} />
                  </button>
                  <button className="iconButton" type="button" onClick={() => setIsRenaming(false)} title="Cancel rename">
                    <X size={16} />
                  </button>
                </form>
              ) : (
                <>
                  <span>{isRecording ? 'Live transcript' : selectedRecording?.markdownFile || 'Transcript.md'}</span>
                  <button
                    className="iconButton"
                    onClick={beginRename}
                    disabled={!selectedRecording || isRecording}
                    title="Rename markdown file"
                  >
                    <Pencil size={16} />
                  </button>
                </>
              )}
            </div>
            <pre ref={transcriptPreRef}>{paneMarkdown}</pre>
          </section>
        </div>
      </section>
    </main>
  );
}

function isRecordingRef(recorder) {
  return recorder?.state === 'recording';
}

function concatenateSamples(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function createWaveformPeaks(arrayBuffer) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    return [];
  }

  const audioContext = new AudioContextConstructor();
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const data = decoded.getChannelData(0);
    const buckets = 96;
    const bucketSize = Math.max(1, Math.floor(data.length / buckets));
    const peaks = [];

    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = bucket * bucketSize;
      const end = Math.min(start + bucketSize, data.length);
      let peak = 0;
      for (let i = start; i < end; i += 1) {
        peak = Math.max(peak, Math.abs(data[i]));
      }
      peaks.push(Math.min(1, peak * 1.8));
    }

    return peaks;
  } finally {
    await audioContext.close();
  }
}

function formatDuration(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatPlaybackTime(seconds = 0) {
  if (!Number.isFinite(seconds)) {
    return '00:00';
  }

  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const remainder = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

createRoot(document.getElementById('root')).render(<App />);
