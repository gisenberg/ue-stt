const SAMPLE_RECORDING = {
  id: 'sample-recording',
  title: 'Sample microphone note',
  createdAt: '2026-06-17T12:00:00.000Z',
  durationMs: 64000,
  model: 'homelab stt large-v3',
  audioFile: 'sample-recording.webm',
  markdownFile: 'sample-recording.md',
  text: 'This is a browser-mode sample transcript for UI verification.',
  transcribed: true,
  refinements: []
};

const SAMPLE_MARKDOWN = `# Sample microphone note

- Recorded: 6/17/2026, 12:00:00 PM
- Duration: 01:04
- Model: homelab stt large-v3

## Transcript

This is a browser-mode sample transcript for UI verification.
`;

const STORAGE_KEY = 'ue-stt-browser-recordings';
const PROMPT_KEY = 'ue-stt-refinement-prompt';
const SPEECH_BACKEND_KEY = 'ue-stt-speech-backend';
const BROWSER_BACKENDS = [
  { id: 'homelab', label: 'Homelab CLI', model: 'homelab stt large-v3' },
  { id: 'local', label: 'Local Whisper', model: 'mlx whisper large-v3' }
];

export const recordingsApi = window.recordings || createBrowserRecordingsApi();
export const whisperEngineApi = window.whisperEngine || createBrowserWhisperEngineApi();
export const refinementApi = window.refinement || createBrowserRefinementApi();

function createBrowserRecordingsApi() {
  return {
    async list() {
      return readBrowserRecordings();
    },
    async saveAudio(payload) {
      const id = `browser-audio-${Date.now()}`;
      const createdAt = new Date().toISOString();
      const recording = {
        id,
        title: 'Browser audio recording',
        createdAt,
        durationMs: payload.durationMs || 1500,
        model: 'Pending transcription',
        audioFile: `${id}.webm`,
        markdownFile: `${id}.md`,
        text: '',
        transcribed: false,
        refinements: []
      };
      const next = [recording, ...readBrowserRecordings()];
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.localStorage.setItem(markdownKey(id), browserMarkdown(recording));
      return recording;
    },
    async transcribeAndSave() {
      const id = `browser-${Date.now()}`;
      const createdAt = new Date().toISOString();
      const recording = {
        id,
        title: 'Browser test recording',
        createdAt,
        durationMs: 1500,
        model: 'browser-test-double',
        audioFile: `${id}.webm`,
        markdownFile: `${id}.md`,
        text: 'Browser test recording transcript.',
        transcribed: true,
        refinements: []
      };
      const next = [recording, ...readBrowserRecordings()];
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.localStorage.setItem(markdownKey(id), browserMarkdown(recording));
      return recording;
    },
    async transcribeExisting(id) {
      const recordings = readBrowserRecordings();
      const updated = recordings.map((recording) =>
        recording.id === id
          ? {
              ...recording,
              model: selectedBrowserBackend().model,
              mp3File: recording.audioFile.replace(/\.webm$/i, '.mp3'),
              text: 'Browser test recording transcript.',
              transcribed: true,
              refinements: recording.refinements || []
            }
          : recording
      );
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      const item = updated.find((recording) => recording.id === id);
      if (item) {
        window.localStorage.setItem(markdownKey(id), browserMarkdown(item));
      }
      return item;
    },
    async transcribeChunk(payload) {
      return {
        sequence: payload.sequence,
        offsetMs: payload.offsetMs || 0,
        text: `Live preview chunk ${payload.sequence + 1}.`,
        segments: []
      };
    },
    async readMarkdown(id, options = {}) {
      if (options.view === 'refined') {
        const source = readBrowserRecordings().find((recording) => recording.id === id);
        const refinement =
          source?.refinements?.find((candidate) => candidate.id === options.refinementId) ||
          source?.refinements?.[0];
        if (refinement) {
          return window.localStorage.getItem(markdownKey(refinement.id)) || '';
        }
      }

      return window.localStorage.getItem(markdownKey(id)) || SAMPLE_MARKDOWN;
    },
    async readAudio() {
      const bytes = new Uint8Array(0);
      return {
        data: bytes.buffer,
        mimeType: 'audio/webm',
        fileName: 'browser-recording.webm'
      };
    },
    async openWithCode() {
      return true;
    },
    async copyPath(id, options = {}) {
      const source = readBrowserRecordings().find((recording) => recording.id === id);
      if (options.view === 'refined') {
        const refinement =
          source?.refinements?.find((candidate) => candidate.id === options.refinementId) ||
          source?.refinements?.[0];
        return `/browser-recordings/${refinement?.markdownFile || 'refined.md'}`;
      }
      return `/browser-recordings/${source?.markdownFile || 'transcript.md'}`;
    },
    async renameMarkdown(id, name) {
      const recordings = readBrowserRecordings();
      const title = String(name || 'Renamed recording').replace(/\.md$/i, '').trim();
      const updated = recordings.map((recording) =>
        recording.id === id
          ? {
              ...recording,
              title,
              markdownFile: `${title.replace(/\s+/g, '-')}.md`
            }
          : recording
      );
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      const item = updated.find((recording) => recording.id === id);
      if (item) {
        window.localStorage.setItem(markdownKey(id), browserMarkdown(item));
      }
      return item;
    },
    async refineWithCodex(id, prompt) {
      const recordings = readBrowserRecordings();
      const source = recordings.find((recording) => recording.id === id) || SAMPLE_RECORDING;
      const refined = {
        id: `${id}-refined`,
        title: `${source.title} REFINED`,
        markdownFile: source.markdownFile.replace(/\.md$/i, '_REFINED.md'),
        createdAt: new Date().toISOString(),
        prompt
      };
      const refinedMarkdown = `# ${refined.title}

## Executive Bullets

- Browser-mode Codex refinement focused on Unreal Engine 5.8 and novel feature implications.
- Prompt length: ${prompt.length} characters.

## Watch Items

- Verify claims against source material before publishing.
`;
      const updatedSource = {
        ...source,
        refinements: [refined, ...(source.refinements || [])],
        activeRefinementId: refined.id
      };
      const next = recordings.map((recording) => (recording.id === id ? updatedSource : recording));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.localStorage.setItem(markdownKey(refined.id), refinedMarkdown);
      return updatedSource;
    },
    async updateRefinementPrompt(id, refinementId, prompt) {
      const recordings = readBrowserRecordings();
      const updated = recordings.map((recording) =>
        recording.id === id
          ? {
              ...recording,
              refinements: (recording.refinements || []).map((refinement) =>
                refinement.id === refinementId ? { ...refinement, prompt } : refinement
              )
            }
          : recording
      );
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return updated.find((recording) => recording.id === id);
    },
    onTranscriptionProgress() {
      return () => {};
    },
    async reveal() {
      return true;
    }
  };
}

function createBrowserWhisperEngineApi() {
  return {
    async status() {
      const backend = selectedBrowserBackend();
      return {
        state: 'ready',
        message: `Browser test ${backend.label} ready`,
        model: backend.model,
        selectedBackend: backend.id,
        backends: BROWSER_BACKENDS
      };
    },
    async setBackend(backendId) {
      const backend = BROWSER_BACKENDS.find((candidate) => candidate.id === backendId) || BROWSER_BACKENDS[0];
      window.localStorage.setItem(SPEECH_BACKEND_KEY, backend.id);
      return {
        state: 'ready',
        message: `Browser test ${backend.label} ready`,
        model: backend.model,
        selectedBackend: backend.id,
        backends: BROWSER_BACKENDS
      };
    }
  };
}

function createBrowserRefinementApi() {
  return {
    async getPrompt() {
      return (
        window.localStorage.getItem(PROMPT_KEY) ||
        `Turn this raw speech transcript into concise, high-signal technical notes for an audience deeply experienced in Unreal Engine.

Prioritize items that are new in Unreal Engine 5.8 or seem new, novel, experimental, previously unannounced, or easy for experienced Unreal developers to miss.`
      );
    },
    async savePrompt(prompt) {
      window.localStorage.setItem(PROMPT_KEY, prompt);
      return prompt;
    }
  };
}

function readBrowserRecordings() {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [SAMPLE_RECORDING];
  }

  try {
    return JSON.parse(raw);
  } catch {
    return [SAMPLE_RECORDING];
  }
}

function browserMarkdown(recording) {
  return `# ${recording.title}

- Recorded: ${new Date(recording.createdAt).toLocaleString()}
- Duration: ${formatDuration(recording.durationMs)}
- Model: ${recording.model}

## Transcript

${recording.text}
`;
}

function markdownKey(id) {
  return `ue-stt-browser-markdown:${id}`;
}

function selectedBrowserBackend() {
  const selected = window.localStorage.getItem(SPEECH_BACKEND_KEY);
  return BROWSER_BACKENDS.find((backend) => backend.id === selected) || BROWSER_BACKENDS[0];
}

function formatDuration(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
