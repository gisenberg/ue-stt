import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import {
  Circle,
  Code,
  Copy,
  FileText,
  FolderOpen,
  Check,
  Loader2,
  Mic,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  ChevronDown,
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
const LIVE_WAVEFORM_BIN_COUNT = 120;
const LIVE_WAVEFORM_WINDOW_SECONDS = 1.6;
const LIVE_WAVEFORM_HEIGHT = 64;
const LIVE_WAVEFORM_CENTER = LIVE_WAVEFORM_HEIGHT / 2;
const LIVE_WAVEFORM_AMPLITUDE = 27;

function App() {
  const [recordings, setRecordings] = useState([]);
  const [draftRecording, setDraftRecording] = useState(null);
  const [recordingName, setRecordingName] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [markdown, setMarkdown] = useState(EMPTY_MARKDOWN);
  const [activeView, setActiveView] = useState('transcript');
  const [selectedRefinementId, setSelectedRefinementId] = useState(null);
  const [status, setStatus] = useState('checking');
  const [statusText, setStatusText] = useState('Checking Homelab STT setup');
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState('');
  const [liveChunks, setLiveChunks] = useState([]);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [navRenamingId, setNavRenamingId] = useState(null);
  const [navRenameValue, setNavRenameValue] = useState('');
  const [refinementPrompt, setRefinementPrompt] = useState('');
  const [currentRefinementPrompt, setCurrentRefinementPrompt] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionProgress, setTranscriptionProgress] = useState(null);
  const [liveTranscription, setLiveTranscription] = useState(false);
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [promptSaveState, setPromptSaveState] = useState('Saved');
  const [refinementPromptSaveState, setRefinementPromptSaveState] = useState('Saved');
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioFileName, setAudioFileName] = useState('');
  const [waveformPeaks, setWaveformPeaks] = useState([]);
  const [liveWaveformBands, setLiveWaveformBands] = useState(() => createFlatLiveWaveform());
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioTime, setAudioTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speechBackends, setSpeechBackends] = useState([]);
  const [selectedSpeechBackend, setSelectedSpeechBackend] = useState('homelab');

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef(null);
  const audioContextRef = useRef(null);
  const liveProcessorRef = useRef(null);
  const liveMuteRef = useRef(null);
  const liveTimerRef = useRef(null);
  const liveSamplesRef = useRef([]);
  const liveWaveformSamplesRef = useRef(new Float32Array(0));
  const liveTranscriptionRef = useRef(false);
  const liveInFlightRef = useRef(false);
  const liveSequenceRef = useRef(0);
  const liveOffsetMsRef = useRef(0);
  const liveSourceRateRef = useRef(48000);
  const transcriptPreRef = useRef(null);
  const audioRef = useRef(null);
  const recordingNameRef = useRef('');
  const selectedIdRef = useRef(null);

  const displayedRecordings = useMemo(
    () => (draftRecording ? [draftRecording, ...recordings] : recordings),
    [draftRecording, recordings]
  );
  const selectedRecording = useMemo(
    () => displayedRecordings.find((recording) => recording.id === selectedId),
    [displayedRecordings, selectedId]
  );
  const selectedRefinement = useMemo(() => {
    const refinements = selectedRecording?.refinements || [];
    return refinements.find((refinement) => refinement.id === selectedRefinementId) || refinements[0] || null;
  }, [selectedRecording, selectedRefinementId]);
  const activeMarkdownFile = activeView === 'refined'
    ? selectedRefinement?.markdownFile || selectedRecording?.markdownFile
    : selectedRecording?.markdownFile;
  const activePromptValue = activeView === 'refined' && selectedRefinement
    ? currentRefinementPrompt
    : refinementPrompt;
  const activePromptSaveState = activeView === 'refined' && selectedRefinement
    ? refinementPromptSaveState
    : promptSaveState;
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
      : activeView === 'refined' && !selectedRefinement
        ? '# Refined Notes\n\n_Run refinement to create notes for this recording._'
      : markdown;

  useEffect(() => {
    refreshRecordings();
    refreshEngineStatus();
    refreshRefinementPrompt();
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    recordingNameRef.current = recordingName;
    if (draftRecording) {
      setDraftRecording((current) => (current ? { ...current, title: recordingName || current.title } : current));
    }
  }, [recordingName]);

  useEffect(() => {
    if (!recordingsApi.onTranscriptionProgress) {
      return undefined;
    }

    return recordingsApi.onTranscriptionProgress((progress) => {
      if (progress.recordingId !== selectedIdRef.current) {
        return;
      }

      setTranscriptionProgress(progress);
      if (progress.phase) {
        setStatusText(progress.phase);
      }
    });
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
    liveTranscriptionRef.current = liveTranscription;
    if (!isRecording) {
      return;
    }

    if (liveTranscription) {
      if (!liveTimerRef.current) {
        liveSamplesRef.current = [];
        liveTimerRef.current = setInterval(() => {
          void flushLiveChunk(false);
        }, 7000);
      }
      setStatusText('Recording microphone audio with live transcription');
      return;
    }

    clearInterval(liveTimerRef.current);
    liveTimerRef.current = null;
    liveSamplesRef.current = [];
    setStatusText('Recording microphone audio');
  }, [liveTranscription, isRecording]);

  useEffect(() => {
    if (activeView !== 'refined' || !selectedRefinement) {
      return;
    }

    setCurrentRefinementPrompt(selectedRefinement.prompt || refinementPrompt);
    setRefinementPromptSaveState('Saved');
  }, [activeView, selectedRefinement?.id]);

  useEffect(() => {
    if (activeView !== 'refined' || !selectedRefinement || currentRefinementPrompt === (selectedRefinement.prompt || '')) {
      return;
    }

    setRefinementPromptSaveState('Saving...');
    const timeout = setTimeout(async () => {
      const updated = await recordingsApi.updateRefinementPrompt(selectedRecording.id, selectedRefinement.id, currentRefinementPrompt);
      if (updated) {
        setRecordings((current) => current.map((recording) => (recording.id === updated.id ? updated : recording)));
      }
      setRefinementPromptSaveState('Saved');
    }, 500);

    return () => clearTimeout(timeout);
  }, [activeView, currentRefinementPrompt, selectedRefinement?.id, selectedRecording?.id]);

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

  useEffect(() => {
    if (!selectedId || isRecording || status === 'preparing') {
      return;
    }

    if (activeView === 'refined' && selectedRecording?.refinements?.length && !selectedRefinementId) {
      setSelectedRefinementId(selectedRecording.refinements[0].id);
      return;
    }

    void loadSelectedMarkdown();
  }, [selectedId, activeView, selectedRefinementId, selectedRecording?.refinements?.length]);

  useEffect(() => {
    setPromptExpanded(false);
  }, [selectedId, activeView, selectedRefinement?.id]);

  async function refreshRecordings() {
    const items = await recordingsApi.list();
    setRecordings(items);

    if (items.length && !selectedId && !draftRecording) {
      setSelectedId(items[0].id);
    }
  }

  async function selectRecording(recording) {
    setSelectedId(recording.id);
    setActiveView('transcript');
    setSelectedRefinementId(recording.refinements?.[0]?.id || null);
    if (recording.draft) {
      setMarkdown('# Live Transcript\n\n_Listening..._');
    }
  }

  async function loadSelectedMarkdown() {
    const options = {
      view: activeView,
      refinementId: selectedRefinementId
    };
    setMarkdown((await recordingsApi.readMarkdown(selectedId, options)) || EMPTY_MARKDOWN);
  }

  async function refreshEngineStatus() {
    const engine = await whisperEngineApi.status();
    setStatus(engine.state);
    setStatusText(engine.message);
    setSpeechBackends(engine.backends || []);
    setSelectedSpeechBackend(engine.selectedBackend || 'homelab');
    if (engine.state === 'ready') {
      setError('');
    }
  }

  async function changeSpeechBackend(backendId) {
    try {
      setError('');
      setSelectedSpeechBackend(backendId);
      setStatus('checking');
      setStatusText('Checking speech-to-text backend');
      const engine = await whisperEngineApi.setBackend(backendId);
      setStatus(engine.state);
      setStatusText(engine.message);
      setSpeechBackends(engine.backends || []);
      setSelectedSpeechBackend(engine.selectedBackend || backendId);
    } catch (backendError) {
      setError(backendError.message);
      setStatus('error');
      setStatusText('Could not switch speech backend');
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
      liveWaveformSamplesRef.current = new Float32Array(0);
      liveSequenceRef.current = 0;
      liveOffsetMsRef.current = 0;
      liveTranscriptionRef.current = liveTranscription;
      setLiveWaveformBands(createFlatLiveWaveform());
      setLiveChunks([]);
      const createdAt = new Date().toISOString();
      const defaultTitle = `Recording ${new Date(createdAt).toLocaleString()}`;
      const draft = {
        id: `draft-${Date.now()}`,
        title: defaultTitle,
        createdAt,
        durationMs: 0,
        model: 'Recording',
        markdownFile: `${defaultTitle.replace(/\s+/g, '-')}.md`,
        transcribed: false,
        draft: true
      };
      setDraftRecording(draft);
      setRecordingName(defaultTitle);
      setSelectedId(draft.id);
      setActiveView('transcript');
      setMarkdown('# Live Transcript\n\n_Listening..._');
      await startLivePreview(stream);
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
      setStatusText(liveTranscription ? 'Recording microphone audio with live transcription' : 'Recording microphone audio');
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
    liveTimerRef.current = null;
    if (liveTranscriptionRef.current) {
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
        title: recordingNameRef.current,
        durationMs: elapsedMs || Date.now() - startedAtRef.current,
        audio: await blob.arrayBuffer()
      });
      const content = await recordingsApi.readMarkdown(saved.id);
      setDraftRecording(null);
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
      await recordingsApi.reveal(selectedId, {
        view: activeView,
        refinementId: selectedRefinementId
      });
    }
  }

  async function openSelectedWithCode() {
    if (!selectedId) {
      return;
    }

    try {
      await recordingsApi.openWithCode(selectedId, {
        view: activeView,
        refinementId: selectedRefinementId
      });
    } catch (openError) {
      setError(openError.message);
      setStatus('error');
      setStatusText('Could not open file in Code');
    }
  }

  async function copySelectedPath() {
    if (!selectedId) {
      return;
    }

    try {
      await recordingsApi.copyPath(selectedId, {
        view: activeView,
        refinementId: selectedRefinementId
      });
      setStatus('ready');
      setStatusText('Path copied');
      setError('');
    } catch (copyError) {
      setError(copyError.message);
      setStatus('error');
      setStatusText('Could not copy file path');
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
      const refined = await recordingsApi.refineWithCodex(selectedRecording.id, activePromptValue);
      const items = await recordingsApi.list();
      setRecordings(items);
      setSelectedId(refined.id);
      setActiveView('refined');
      setSelectedRefinementId(refined.activeRefinementId || refined.refinements?.[0]?.id || null);
      setMarkdown(
        (await recordingsApi.readMarkdown(refined.id, {
          view: 'refined',
          refinementId: refined.activeRefinementId || refined.refinements?.[0]?.id
        })) || EMPTY_MARKDOWN
      );
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
      setTranscriptionProgress({
        recordingId: selectedRecording.id,
        phase: 'Preparing audio',
        percent: selectedSpeechBackend === 'local' ? 0 : null,
        detail: ''
      });
      setStatus('transcribing');
      setStatusText('Transcribing selected recording');
      const updated = await recordingsApi.transcribeExisting(selectedRecording.id);
      const items = await recordingsApi.list();
      setRecordings(items);
      setSelectedId(updated.id);
      setActiveView('transcript');
      setMarkdown((await recordingsApi.readMarkdown(updated.id, { view: 'transcript' })) || EMPTY_MARKDOWN);
      setStatus('ready');
      setStatusText('Transcript and MP3 saved');
      setTranscriptionProgress(null);
      await loadSelectedAudio(updated.id);
    } catch (transcribeError) {
      setError(transcribeError.message);
      setStatus('error');
      setStatusText('Transcription failed');
      setTranscriptionProgress(null);
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
      setMarkdown((await recordingsApi.readMarkdown(updated.id, { view: 'transcript' })) || EMPTY_MARKDOWN);
      setIsRenaming(false);
    } catch (renameError) {
      setError(renameError.message);
      setStatus('error');
      setStatusText('Rename failed');
    }
  }

  function beginNavRename(recording) {
    setNavRenamingId(recording.id);
    setNavRenameValue(recording.title);
  }

  async function submitNavRename(event) {
    event?.preventDefault();
    if (!navRenamingId || !navRenameValue.trim()) {
      setNavRenamingId(null);
      return;
    }

    if (draftRecording?.id === navRenamingId) {
      setRecordingName(navRenameValue.trim());
      setNavRenamingId(null);
      return;
    }

    try {
      const updated = await recordingsApi.renameMarkdown(navRenamingId, navRenameValue);
      const items = await recordingsApi.list();
      setRecordings(items);
      if (selectedId === updated.id) {
        setSelectedId(updated.id);
        setMarkdown((await recordingsApi.readMarkdown(updated.id, { view: activeView, refinementId: selectedRefinementId })) || EMPTY_MARKDOWN);
      }
      setNavRenamingId(null);
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

      const channel = event.inputBuffer.getChannelData(0);
      const maxPreviewSamples = Math.round(audioContext.sampleRate * LIVE_WAVEFORM_WINDOW_SECONDS);
      liveWaveformSamplesRef.current = appendRollingSamples(
        liveWaveformSamplesRef.current,
        channel,
        maxPreviewSamples
      );
      setLiveWaveformBands(createLiveWaveformBands(liveWaveformSamplesRef.current));

      if (liveTranscriptionRef.current) {
        liveSamplesRef.current.push(new Float32Array(channel));
      }
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
    if (!liveTranscriptionRef.current) {
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

  function switchView(view) {
    setActiveView(view);
    setPromptExpanded(false);
    if (view === 'refined') {
      setSelectedRefinementId(selectedRefinement?.id || selectedRecording?.refinements?.[0]?.id || null);
    }
  }

  function updateActivePrompt(value) {
    if (activeView === 'refined' && selectedRefinement) {
      setCurrentRefinementPrompt(value);
      return;
    }

    setRefinementPrompt(value);
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
          {displayedRecordings.length === 0 ? (
            <div className="emptyState">
              <FileText size={18} />
              <span>No recordings yet</span>
            </div>
          ) : (
            displayedRecordings.map((recording) => (
              <div
                key={recording.id}
                className={`recordingItem ${selectedId === recording.id ? 'active' : ''}`}
              >
                {navRenamingId === recording.id ? (
                  <form className="navRenameForm" onSubmit={submitNavRename}>
                    <input
                      aria-label="Recording name"
                      autoFocus
                      value={navRenameValue}
                      onChange={(event) => setNavRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setNavRenamingId(null);
                        }
                      }}
                    />
                    <button className="iconButton" type="submit" title="Save recording name">
                      <Check size={15} />
                    </button>
                    <button className="iconButton" type="button" onClick={() => setNavRenamingId(null)} title="Cancel recording rename">
                      <X size={15} />
                    </button>
                  </form>
                ) : (
                  <>
                    <button className="recordingSelect" type="button" onClick={() => selectRecording(recording)}>
                      <span className="recordingTitle">{recording.title}</span>
                      <span className="recordingMeta">
                        {recording.draft
                          ? `Recording now · ${formatDuration(elapsedMs)}`
                          : `${new Date(recording.createdAt).toLocaleDateString()} · ${formatDuration(recording.durationMs)}`}
                      </span>
                    </button>
                    <button
                      className="iconButton navRenameButton"
                      type="button"
                      onClick={() => beginNavRename(recording)}
                      title="Rename recording"
                    >
                      <Pencil size={15} />
                    </button>
                  </>
                )}
              </div>
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
              {status === 'transcribing' && transcriptionProgress && (
                <div className="transcriptionProgress">
                  <div className="progressMeta">
                    <span>{transcriptionProgress.detail || transcriptionProgress.phase}</span>
                    <span>
                      {typeof transcriptionProgress.percent === 'number'
                        ? `${Math.round(transcriptionProgress.percent)}%`
                        : 'Working'}
                    </span>
                  </div>
                  <div
                    className={`progressTrack ${typeof transcriptionProgress.percent === 'number' ? '' : 'indeterminate'}`}
                    role="progressbar"
                    aria-label="Transcription progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={typeof transcriptionProgress.percent === 'number' ? Math.round(transcriptionProgress.percent) : undefined}
                  >
                    <span style={{ width: `${Math.max(3, Math.min(100, transcriptionProgress.percent ?? 25))}%` }} />
                  </div>
                </div>
              )}
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
            <div className="recordSettings">
              <div className="modelInfo">
                <Circle size={12} fill="currentColor" />
                <select
                  aria-label="Speech-to-text model"
                  value={selectedSpeechBackend}
                  disabled={isRecording || isTranscribing || status === 'transcribing' || status === 'preparing'}
                  onChange={(event) => changeSpeechBackend(event.target.value)}
                >
                  {(speechBackends.length ? speechBackends : [{ id: 'homelab', label: 'Homelab CLI' }]).map((backend) => (
                    <option key={backend.id} value={backend.id}>
                      {backend.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={liveTranscription}
                  onChange={(event) => setLiveTranscription(event.target.checked)}
                />
                <span>Live transcription</span>
              </label>
            </div>
            {isRecording ? (
              <section className="recordingOverlay" aria-label="Live microphone input">
                <div className="recordingOverlayHeader">
                  <div className="recordingMic">
                    <Mic size={22} />
                  </div>
                  <div>
                    <p>Listening</p>
                    <span>{liveTranscription ? 'Live transcription enabled' : 'Capturing audio only'}</span>
                  </div>
                </div>
                <label className="recordingNameField">
                  <span>Recording name</span>
                  <input
                    aria-label="Current recording name"
                    value={recordingName}
                    onChange={(event) => setRecordingName(event.target.value)}
                  />
                </label>
                <svg
                  className="liveWaveform"
                  aria-label="Detected microphone waveform"
                  viewBox={`0 0 ${LIVE_WAVEFORM_BIN_COUNT} ${LIVE_WAVEFORM_HEIGHT}`}
                  preserveAspectRatio="none"
                >
                  <line
                    className="liveWaveformCenter"
                    x1="0"
                    y1={LIVE_WAVEFORM_CENTER}
                    x2={LIVE_WAVEFORM_BIN_COUNT}
                    y2={LIVE_WAVEFORM_CENTER}
                  />
                  {liveWaveformBands.map((band, index) => {
                    const top = LIVE_WAVEFORM_CENTER - band.max * LIVE_WAVEFORM_AMPLITUDE;
                    const bottom = LIVE_WAVEFORM_CENTER - band.min * LIVE_WAVEFORM_AMPLITUDE;
                    const center = (top + bottom) / 2;
                    const halfSpan = Math.max(0.75, Math.abs(bottom - top) / 2);
                    return (
                      <line
                        key={index}
                        className="liveWaveformSample"
                        x1={index + 0.5}
                        y1={center - halfSpan}
                        x2={index + 0.5}
                        y2={center + halfSpan}
                      />
                    );
                  })}
                </svg>
                <label className="toggleRow">
                  <input
                    type="checkbox"
                    checked={liveTranscription}
                    onChange={(event) => setLiveTranscription(event.target.checked)}
                  />
                  <span>Live transcription</span>
                </label>
              </section>
            ) : (
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
            )}
          </section>

          <section className="markdownPane">
            <div className="viewTabs" role="tablist" aria-label="Transcript views">
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'transcript'}
                className={activeView === 'transcript' ? 'active' : ''}
                onClick={() => switchView('transcript')}
              >
                Full Transcript
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'refined'}
                className={activeView === 'refined' ? 'active' : ''}
                onClick={() => switchView('refined')}
                disabled={!selectedRecording?.transcribed && !selectedRecording?.refinements?.length}
              >
                Refined
                {selectedRecording?.refinements?.length ? <span>{selectedRecording.refinements.length}</span> : null}
              </button>
            </div>
            {activeView === 'refined' && (
              <section className={`inlinePromptPanel ${promptExpanded ? 'expanded' : ''}`}>
                <button
                  className="promptToggle"
                  type="button"
                  aria-expanded={promptExpanded}
                  onClick={() => setPromptExpanded((value) => !value)}
                >
                  <ChevronDown size={16} />
                  <span>
                    {selectedRefinement ? 'Refinement Prompt Used' : 'Refinement Prompt'} · {activePromptSaveState}
                  </span>
                </button>
                {promptExpanded && (
                  <textarea
                    aria-label="Refinement prompt"
                    value={activePromptValue}
                    onChange={(event) => updateActivePrompt(event.target.value)}
                    spellCheck="true"
                  />
                )}
              </section>
            )}
            <div className="paneHeader">
              <FileText size={18} />
              {isRenaming && activeView === 'transcript' ? (
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
                  <span>{isRecording ? 'Live transcript' : activeMarkdownFile || 'Transcript.md'}</span>
                  <button
                    className="iconButton"
                    onClick={revealSelected}
                    disabled={!selectedRecording || isRecording}
                    title="Show markdown file in Finder"
                  >
                    <FolderOpen size={16} />
                  </button>
                  <button
                    className="iconButton"
                    onClick={openSelectedWithCode}
                    disabled={!selectedRecording || isRecording}
                    title="Open markdown file with Code"
                  >
                    <Code size={16} />
                  </button>
                  <button
                    className="iconButton"
                    onClick={copySelectedPath}
                    disabled={!selectedRecording || isRecording}
                    title="Copy markdown path"
                  >
                    <Copy size={16} />
                  </button>
                  <button
                    className="iconButton"
                    onClick={beginRename}
                    disabled={!selectedRecording || isRecording || activeView !== 'transcript'}
                    title="Rename markdown file"
                  >
                    <Pencil size={16} />
                  </button>
                </>
              )}
            </div>
            {!isRecording && status !== 'preparing' ? (
              <div ref={transcriptPreRef} className="markdownBody markdownPreview">
                <ReactMarkdown>{paneMarkdown}</ReactMarkdown>
              </div>
            ) : (
              <pre ref={transcriptPreRef} className="markdownBody rawMarkdown">{paneMarkdown}</pre>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function isRecordingRef(recorder) {
  return recorder?.state === 'recording';
}

function createFlatLiveWaveform() {
  return Array.from({ length: LIVE_WAVEFORM_BIN_COUNT }, () => ({ min: 0, max: 0 }));
}

function appendRollingSamples(existingSamples, nextSamples, maxSamples) {
  if (maxSamples <= 0) {
    return new Float32Array(0);
  }

  const nextLength = Math.min(maxSamples, existingSamples.length + nextSamples.length);
  const output = new Float32Array(nextLength);
  const nextSampleCount = Math.min(nextSamples.length, nextLength);
  const existingSampleCount = nextLength - nextSampleCount;

  if (existingSampleCount > 0) {
    output.set(existingSamples.subarray(existingSamples.length - existingSampleCount), 0);
  }
  output.set(nextSamples.subarray(nextSamples.length - nextSampleCount), existingSampleCount);
  return output;
}

function createLiveWaveformBands(samples) {
  if (!samples.length) {
    return createFlatLiveWaveform();
  }

  const bands = [];
  for (let bucket = 0; bucket < LIVE_WAVEFORM_BIN_COUNT; bucket += 1) {
    const start = Math.floor((bucket * samples.length) / LIVE_WAVEFORM_BIN_COUNT);
    if (start >= samples.length) {
      bands.push({ min: 0, max: 0 });
      continue;
    }

    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor(((bucket + 1) * samples.length) / LIVE_WAVEFORM_BIN_COUNT))
    );
    let min = 1;
    let max = -1;

    for (let index = start; index < end; index += 1) {
      const sample = samples[index];
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }

    bands.push({ min, max });
  }

  const amplitudes = bands
    .map((band) => Math.max(Math.abs(band.min), Math.abs(band.max)))
    .sort((a, b) => a - b);
  const ceiling = amplitudes[Math.floor(amplitudes.length * 0.96)] || amplitudes[amplitudes.length - 1] || 0;
  const scale = 0.82 / Math.max(0.08, ceiling);

  return bands.map((band) => ({
    min: clampSampleForDisplay(band.min * scale),
    max: clampSampleForDisplay(band.max * scale)
  }));
}

function clampSampleForDisplay(value) {
  return Math.max(-1, Math.min(1, value));
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
    const levels = [];

    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = bucket * bucketSize;
      const end = Math.min(start + bucketSize, data.length);
      let sumSquares = 0;
      let count = 0;
      for (let i = start; i < end; i += 1) {
        sumSquares += data[i] * data[i];
        count += 1;
      }
      levels.push(Math.sqrt(sumSquares / Math.max(1, count)));
    }

    const sorted = levels.slice().sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.12)] || 0;
    const ceiling = sorted[Math.floor(sorted.length * 0.98)] || sorted[sorted.length - 1] || 0.01;
    const range = Math.max(0.0001, ceiling - floor);
    return levels.map((level) => {
      const normalized = Math.max(0, Math.min(1, (level - floor) / range));
      return Math.min(0.86, Math.max(0.05, Math.pow(normalized, 0.78) * 0.78 + 0.05));
    });
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
