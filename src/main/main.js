import { app, BrowserWindow, clipboard, ipcMain, shell, session } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactMarkdownForRefinement } from './refinementInput.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const isDev = Boolean(process.env.ELECTRON_START_URL);
const recordingsDir = () => path.join(app.getPath('userData'), 'recordings');
const indexPath = () => path.join(recordingsDir(), 'index.json');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const speechBackends = {
  homelab: {
    id: 'homelab',
    label: 'Homelab CLI',
    model: 'homelab stt large-v3'
  },
  local: {
    id: 'local',
    label: 'Local Whisper',
    model: 'mlx whisper large-v3'
  }
};
const homelabCliScript = path.join(os.homedir(), 'git/gisenberg/homelab-cli/src/homelab_cli/cli.py');
const homelabVenvBin = path.join(os.homedir(), 'git/gisenberg/homelab-cli/.venv/bin/homelab');
const localWhisperBin = path.join(projectRoot, '.venv/bin/mlx_whisper');
const localWhisperModel = path.join(projectRoot, 'models/whisper-large-v3-mlx');
const localPyannoteModel = path.join(projectRoot, 'models/pyannote-segmentation-3.0-mlx');
const speechSwiftDir = path.join(projectRoot, 'vendor/speech-swift');
const speechSwiftBin = path.join(speechSwiftDir, '.build/release/speech');
const localWhisperChunkSeconds = 45;
const localWhisperChunkOverlapSeconds = 5;
const localWhisperChunkThresholdSeconds = 90;
const defaultRefinementPrompt = `Turn this raw speech transcript into concise, high-signal technical notes for an audience deeply experienced in Unreal Engine.

Prioritize:
- Items that are new in Unreal Engine 5.8.
- Features, APIs, workflows, constraints, or behaviors that seem new, novel, experimental, previously unannounced, or easy for experienced Unreal developers to miss.
- Practical implications for production teams, engine programmers, technical artists, tools engineers, rendering engineers, and gameplay programmers.

Write with the assumption that the reader already understands Unreal Engine fundamentals. Avoid introductory explanations, marketing language, and generic summaries. Preserve uncertainty explicitly: if the transcript only implies something, label it as inferred rather than confirmed.

Format the result as markdown with:
- A short title.
- A "TL;DR" section with one concise paragraph and 3-5 bullets summarizing what the talk is about.
- Executive bullets.
- Sections grouped by system or workflow.
- A final "Watch Items" section for unclear, risky, or potentially important details to verify.`;

async function ensureStore() {
  await fs.mkdir(recordingsDir(), { recursive: true });
  try {
    await fs.access(indexPath());
  } catch {
    await fs.writeFile(indexPath(), '[]', 'utf8');
  }
  try {
    await fs.access(settingsPath());
  } catch {
    await fs.writeFile(
      settingsPath(),
      JSON.stringify({ refinementPrompt: defaultRefinementPrompt, speechBackend: 'homelab' }, null, 2),
      'utf8'
    );
  }
}

async function readIndex() {
  await ensureStore();
  return JSON.parse(await fs.readFile(indexPath(), 'utf8'));
}

async function writeIndex(items) {
  await ensureStore();
  await fs.writeFile(indexPath(), JSON.stringify(items, null, 2), 'utf8');
}

async function readSettings() {
  await ensureStore();
  return JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
}

async function writeSettings(settings) {
  await ensureStore();
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function createMarkdown(recording) {
  const lines = [
    `# ${recording.title}`,
    '',
    `- Recorded: ${new Date(recording.createdAt).toLocaleString()}`,
    `- Duration: ${formatDuration(recording.durationMs)}`,
    `- Model: ${recording.model}`,
    ...(recording.annotationSource ? [`- Annotation: ${recording.annotationSource}`] : []),
    ...(recording.annotationModel ? [`- Annotation Model Available: ${recording.annotationModel}`] : []),
    '',
    '## Transcript',
    '',
    recording.text.trim() || '_No transcript text was returned._'
  ];

  if (recording.chunks?.length) {
    lines.push('', '## Segments', '');
    for (const chunk of recording.chunks) {
      const stamp = `${formatTimestamp(chunk.start)} - ${formatTimestamp(chunk.end)}`;
      lines.push(`- **${stamp}** ${chunk.text.trim()}`);
    }
  }

  if (recording.annotations?.length) {
    lines.push('', '## Annotated Transcript', '');
    for (const annotation of recording.annotations) {
      const stamp = `${formatTimestamp(annotation.start)} - ${formatTimestamp(annotation.end)}`;
      const label = annotation.speaker || annotation.kind || 'Speech';
      lines.push(`- **${stamp} ${label}:** ${annotation.text.trim()}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function formatDuration(ms = 0) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatTimestamp(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '--:--';
  }

  const totalSeconds = Math.max(0, Math.round(value));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function createWindow() {
  await ensureStore();

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Local Whisper Recorder',
    backgroundColor: '#f5f4ef',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    await win.loadURL(process.env.ELECTRON_START_URL);
    win.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  await win.loadFile(path.join(__dirname, '../../dist/index.html'));
}

ipcMain.handle('recordings:list', async () => {
  const items = await readIndex();
  return publicRecordings(items);
});

ipcMain.handle('recordings:transcribeAndSave', async (_event, payload) => {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const createdAt = new Date().toISOString();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-stt-'));
  const wavPath = path.join(tmpDir, `${id}.wav`);
  const outputPath = path.join(tmpDir, `${id}.json`);

  try {
    await assertEngineReady();
    const backend = await getSelectedSpeechBackend();
    const samples = toFloat32Array(payload.samples);
    await fs.writeFile(wavPath, encodeWav(samples, payload.sampleRate || 16000));

    const result = await transcribeAudioPath(wavPath);
    await fs.writeFile(outputPath, JSON.stringify(result), 'utf8');
    const recording = await saveRecording({
      id,
      createdAt,
      title: createTitle(result.text || ''),
      text: result.text || '',
      chunks: result.segments || [],
      model: backend.model,
      durationMs: payload.durationMs || 0,
      audio: payload.audio,
      transcribed: true
    });

    const mp3File = await convertRecordingToMp3(recording);
    const updated = { ...recording, mp3File };
    const items = await readIndex();
    await writeIndex(items.map((item) => (item.id === updated.id ? updated : item)));
    return updated;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

ipcMain.handle('recordings:saveAudio', async (_event, payload) => {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const createdAt = new Date().toISOString();
  return saveRecording({
    id,
    createdAt,
    title: payload.title || `Recording ${new Date(createdAt).toLocaleString()}`,
    durationMs: payload.durationMs || 0,
    audio: payload.audio,
    transcribed: false
  });
});

ipcMain.handle('recordings:transcribeExisting', async (event, id) => {
  const items = await readIndex();
  const item = items.find((recording) => recording.id === id);
  if (!item) {
    throw new Error('Recording not found');
  }
  if (!item.audioFile) {
    throw new Error('Recording has no source audio');
  }

  await assertEngineReady();
  const backend = await getSelectedSpeechBackend();
  const audioPath = path.join(recordingsDir(), item.audioFile);
  emitTranscriptionProgress(event, id, {
    backend: backend.id,
    phase: 'Preparing audio',
    percent: backend.id === 'local' ? 0 : null
  });
  const result = await transcribeAudioPath(audioPath, {
    durationMs: item.durationMs,
    onProgress: (progress) => emitTranscriptionProgress(event, id, { backend: backend.id, ...progress })
  });
  if (backend.id === 'local') {
    const sanity = checkTranscriptionSanity(result, { label: 'local Whisper transcription' });
    if (!sanity.ok) {
      throw new Error(`Refusing to overwrite transcript: ${sanity.reason}`);
    }
  }
  emitTranscriptionProgress(event, id, {
    backend: backend.id,
    phase: 'Annotating transcript',
    percent: backend.id === 'local' ? 94 : null
  });
  const annotationResult = await annotateTranscript(audioPath, result, {
    backend,
    durationMs: item.durationMs,
    onProgress: (progress) => emitTranscriptionProgress(event, id, { backend: backend.id, ...progress })
  });
  emitTranscriptionProgress(event, id, {
    backend: backend.id,
    phase: 'Writing markdown',
    percent: backend.id === 'local' ? 96 : null
  });
  const title = item.title;
  emitTranscriptionProgress(event, id, {
    backend: backend.id,
    phase: 'Converting MP3',
    percent: backend.id === 'local' ? 98 : null
  });
  const mp3File = await convertRecordingToMp3(item);
  const updated = {
    ...item,
    title,
    text: result.text || '',
    chunks: result.segments || [],
    annotations: annotationResult.annotations,
    annotationModel: annotationResult.model,
    annotationSource: annotationResult.source,
    model: backend.model,
    transcribed: true,
    mp3File
  };

  await fs.writeFile(path.join(recordingsDir(), updated.markdownFile), createMarkdown(updated), 'utf8');
  await writeIndex(items.map((recording) => (recording.id === id ? updated : recording)));
  emitTranscriptionProgress(event, id, {
    backend: backend.id,
    phase: 'Complete',
    percent: 100
  });
  return updated;
});

ipcMain.handle('recordings:transcribeChunk', async (_event, payload) => {
  const id = `chunk-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-stt-live-'));
  const wavPath = path.join(tmpDir, `${id}.wav`);

  try {
    await assertEngineReady();
    const samples = toFloat32Array(payload.samples);
    await fs.writeFile(wavPath, encodeWav(samples, payload.sampleRate || 16000));
    const result = await transcribeAudioPath(wavPath);
    return {
      ...result,
      sequence: payload.sequence,
      offsetMs: payload.offsetMs || 0
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

ipcMain.handle('recordings:readMarkdown', async (_event, id, options = {}) => {
  const items = await readIndex();
  const view = findRecordingView(items, id, options);
  if (!view) {
    return null;
  }

  return fs.readFile(path.join(recordingsDir(), view.markdownFile), 'utf8');
});

ipcMain.handle('recordings:readAudio', async (_event, id) => {
  const items = await readIndex();
  const item = items.find((recording) => recording.id === id);
  if (!item?.audioFile) {
    return null;
  }

  const audioPath = path.join(recordingsDir(), item.mp3File || item.audioFile);
  const data = await fs.readFile(audioPath);
  return {
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    mimeType: item.mp3File ? 'audio/mpeg' : 'audio/webm',
    fileName: item.mp3File || item.audioFile
  };
});

ipcMain.handle('recordings:reveal', async (_event, id, options = {}) => {
  const items = await readIndex();
  const view = findRecordingView(items, id, options);
  if (!view) {
    return false;
  }

  shell.showItemInFolder(path.join(recordingsDir(), view.markdownFile));
  return true;
});

ipcMain.handle('recordings:openWithCode', async (_event, id, options = {}) => {
  const items = await readIndex();
  const view = findRecordingView(items, id, options);
  if (!view) {
    throw new Error('Markdown file not found');
  }

  const markdownPath = path.join(recordingsDir(), view.markdownFile);
  const codePath = await resolveCodePath();
  await runCommand(codePath, [markdownPath], null, 30_000);
  return true;
});

ipcMain.handle('recordings:copyPath', async (_event, id, options = {}) => {
  const items = await readIndex();
  const view = findRecordingView(items, id, options);
  if (!view) {
    throw new Error('Markdown file not found');
  }

  const markdownPath = path.join(recordingsDir(), view.markdownFile);
  clipboard.clear();
  clipboard.write({
    text: markdownPath,
    html: `<span>${escapeHtml(markdownPath)}</span>`
  });
  return markdownPath;
});

ipcMain.handle('recordings:renameMarkdown', async (_event, id, requestedName) => {
  const items = await readIndex();
  const item = items.find((recording) => recording.id === id);
  if (!item) {
    throw new Error('Recording not found');
  }

  const nextTitle = sanitizeTitle(requestedName);
  const nextMarkdownFile = await uniqueMarkdownFileName(nextTitle, item.markdownFile);
  const currentPath = path.join(recordingsDir(), item.markdownFile);
  const nextPath = path.join(recordingsDir(), nextMarkdownFile);
  const updated = {
    ...item,
    title: nextTitle,
    markdownFile: nextMarkdownFile
  };

  const nextContent = item.refined
    ? retitleMarkdown(await fs.readFile(currentPath, 'utf8'), nextTitle)
    : createMarkdown(updated);
  await fs.writeFile(currentPath, nextContent, 'utf8');
  if (nextMarkdownFile !== item.markdownFile) {
    await fs.rename(currentPath, nextPath);
  }

  await writeIndex(items.map((recording) => (recording.id === id ? updated : recording)));
  return updated;
});

ipcMain.handle('recordings:refineWithCodex', async (_event, id, prompt) => {
  const items = await readIndex();
  const item = items.find((recording) => recording.id === id);
  if (!item) {
    throw new Error('Recording not found');
  }

  const sourceMarkdown = await fs.readFile(path.join(recordingsDir(), item.markdownFile), 'utf8');
  const refinementMarkdown = compactMarkdownForRefinement(sourceMarkdown);
  const refinedMarkdown = await runCodexRefinement(refinementMarkdown, prompt || defaultRefinementPrompt);
  const refined = await saveRefinedRecording(item, refinedMarkdown, prompt || defaultRefinementPrompt);
  return refined;
});

ipcMain.handle('recordings:updateRefinementPrompt', async (_event, id, refinementId, prompt) => {
  const items = await readIndex();
  const promptText = String(prompt || '').trim();
  const updated = updateRefinementPrompt(items, id, refinementId, promptText);
  if (!updated) {
    throw new Error('Refinement not found');
  }

  await writeIndex(updated);
  return publicRecordings(updated).find((recording) => recording.id === id) || null;
});

ipcMain.handle('refinement:getPrompt', async () => {
  const settings = await readSettings();
  return settings.refinementPrompt || defaultRefinementPrompt;
});

ipcMain.handle('refinement:savePrompt', async (_event, prompt) => {
  const settings = await readSettings();
  const next = {
    ...settings,
    refinementPrompt: String(prompt || '').trim() || defaultRefinementPrompt
  };
  await writeSettings(next);
  return next.refinementPrompt;
});

ipcMain.handle('engine:status', async () => inspectEngine());

ipcMain.handle('engine:setBackend', async (_event, backendId) => {
  if (!speechBackends[backendId]) {
    throw new Error('Unknown speech-to-text backend');
  }

  const settings = await readSettings();
  await writeSettings({
    ...settings,
    speechBackend: backendId
  });
  return inspectEngine();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

async function saveRecording(payload) {
  const safeTitle = (payload.title || 'Untitled recording').replace(/[\\/:*?"<>|]/g, '-');
  const baseName = `${payload.createdAt.slice(0, 10)}-${payload.id}`;
  const audioFile = `${baseName}.webm`;
  const markdownFile = `${baseName}.md`;
  const recording = {
    id: payload.id,
    title: safeTitle,
    createdAt: payload.createdAt,
    durationMs: payload.durationMs || 0,
    model: payload.model || (payload.transcribed ? speechBackends.homelab.model : 'Pending transcription'),
    text: payload.text || '',
    chunks: payload.chunks || [],
    annotations: payload.annotations || [],
    annotationModel: payload.annotationModel || null,
    audioFile,
    markdownFile,
    mp3File: payload.mp3File || null,
    transcribed: Boolean(payload.transcribed)
  };

  if (payload.audio) {
    await fs.writeFile(path.join(recordingsDir(), audioFile), Buffer.from(payload.audio));
  }

  await fs.writeFile(path.join(recordingsDir(), markdownFile), createMarkdown(recording), 'utf8');

  const items = await readIndex();
  await writeIndex([recording, ...items.filter((item) => item.id !== recording.id)]);
  return recording;
}

async function saveRefinedRecording(source, refinedMarkdown, prompt) {
  const id = `${source.id}-refined-${Date.now()}`;
  const title = `${source.title.replace(/\s+REFINED$/i, '')} REFINED`;
  const markdownFile = await uniqueDerivedMarkdownFileName(source.markdownFile, '_REFINED');
  const refinement = {
    id,
    title,
    createdAt: new Date().toISOString(),
    markdownFile,
    prompt: String(prompt || '').trim()
  };
  const updated = {
    ...source,
    refinements: [refinement, ...(source.refinements || [])]
  };

  await fs.writeFile(path.join(recordingsDir(), markdownFile), ensureMarkdownTitle(refinedMarkdown, title), 'utf8');
  const items = await readIndex();
  await writeIndex(items.map((item) => (item.id === source.id ? updated : item)));
  return { ...updated, activeRefinementId: id };
}

function publicRecordings(items) {
  const bases = items.filter((item) => !item.refined).map((item) => ({ ...item, refinements: normalizeRefinements(item) }));
  const byId = new Map(bases.map((item) => [item.id, item]));

  for (const item of items) {
    if (!item.refined) {
      continue;
    }

    const sourceId = item.sourceRecordingId;
    const source = byId.get(sourceId);
    if (!source) {
      bases.push({ ...item, refinements: normalizeRefinements(item) });
      continue;
    }

    source.refinements.push(refinementFromLegacyItem(item));
  }

  for (const item of bases) {
    item.refinements = dedupeRefinements(item.refinements).sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
  }

  return bases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function normalizeRefinements(item) {
  return dedupeRefinements(
    (item.refinements || []).map((refinement) => ({
      id: refinement.id,
      title: refinement.title || `${item.title} REFINED`,
      createdAt: refinement.createdAt || item.createdAt,
      markdownFile: refinement.markdownFile,
      prompt: refinement.prompt || refinement.refinementPrompt || ''
    }))
  );
}

function refinementFromLegacyItem(item) {
  return {
    id: item.id,
    title: item.title,
    createdAt: item.createdAt,
    markdownFile: item.markdownFile,
    prompt: item.prompt || item.refinementPrompt || ''
  };
}

function dedupeRefinements(refinements) {
  const seen = new Set();
  const output = [];

  for (const refinement of refinements) {
    if (!refinement?.markdownFile || seen.has(refinement.markdownFile)) {
      continue;
    }
    seen.add(refinement.markdownFile);
    output.push(refinement);
  }

  return output;
}

function findRecordingView(items, id, options = {}) {
  const item = items.find((recording) => recording.id === id);
  if (item?.refined) {
    return item;
  }

  if (!item) {
    return null;
  }

  if (options?.view !== 'refined') {
    return item;
  }

  const publicItem = publicRecordings(items).find((recording) => recording.id === id);
  const refinements = publicItem?.refinements || [];
  const selected =
    refinements.find((refinement) => refinement.id === options.refinementId) ||
    refinements[0];

  return selected || item;
}

function updateRefinementPrompt(items, id, refinementId, prompt) {
  let changed = false;
  const source = items.find((item) => item.id === id && !item.refined);
  const next = items.map((item) => {
    if (item.id === id && !item.refined) {
      const refinements = (item.refinements || []).map((refinement) => {
        if (refinement.id !== refinementId) {
          return refinement;
        }
        changed = true;
        return { ...refinement, prompt };
      });
      return { ...item, refinements };
    }

    if (item.refined && item.id === refinementId && item.sourceRecordingId === id) {
      changed = true;
      return { ...item, prompt, refinementPrompt: prompt };
    }

    return item;
  });

  if (changed) {
    return next;
  }

  if (!source) {
    return null;
  }

  const publicSource = publicRecordings(items).find((item) => item.id === id);
  const refinement = publicSource?.refinements?.find((candidate) => candidate.id === refinementId);
  if (!refinement) {
    return null;
  }

  return next.map((item) =>
    item.id === id && !item.refined
      ? {
          ...item,
          refinements: [
            { ...refinement, prompt },
            ...(item.refinements || []).filter((candidate) => candidate.id !== refinementId)
          ]
        }
      : item
  );
}

async function assertEngineReady() {
  const status = await inspectEngine();
  if (status.state !== 'ready') {
    throw new Error(status.message);
  }
}

async function inspectEngine() {
  const selected = await getSelectedSpeechBackend();
  const availableBackends = Object.values(speechBackends);
  const base = {
    selectedBackend: selected.id,
    backends: availableBackends
  };

  try {
    if (selected.id === 'local') {
      await resolveLocalWhisperCommand();
      await fs.access(localWhisperModel);
      return {
        ...base,
        state: 'ready',
        message: 'Local Whisper ready (MLX large-v3)',
        model: selected.model
      };
    }

    const homelab = await resolveHomelabCommand();
    const { stdout } = await runCommandCapture(homelab.command, [...homelab.args, 'health', '--json'], null, 30_000);
    const health = JSON.parse(stdout);
    if (health.stt?.status === 'error' || health.stt?.configured === false || health.stt?.error) {
      throw new Error(health.stt?.error || 'not configured');
    }
    return {
      ...base,
      state: 'ready',
      message: `Homelab STT ready (${health.stt?.model || 'large-v3'})`,
      model: selected.model,
      backend: health.stt
    };
  } catch (error) {
    return {
      ...base,
      state: 'missing',
      message: `${selected.label} unavailable: ${error.message}`,
      model: selected.model
    };
  }
}

async function transcribeAudioPath(audioPath, options = {}) {
  const backend = await getSelectedSpeechBackend();
  if (backend.id === 'local') {
    return transcribeAudioPathWithLocalWhisper(audioPath, options);
  }

  const homelab = await resolveHomelabCommand();
  const { stdout, stderr } = await runCommandCapture(
    homelab.command,
    [...homelab.args, 'stt', audioPath, '--language', 'en', '--json'],
    null,
    3 * 60 * 60 * 1000
  );
  const result = JSON.parse(stdout);
  if (result.error) {
    throw new Error(result.error);
  }
  if (!result.text && result.job?.status !== 'completed') {
    throw new Error(`Homelab transcription did not complete${stderr ? `: ${stderr.trim()}` : ''}`);
  }

  return {
    text: result.text || '',
    segments: [],
    job: result.job || null
  };
}

async function transcribeAudioPathWithLocalWhisper(audioPath, options = {}) {
  const durationSeconds = Math.max(0, Number(options.durationMs || 0) / 1000);
  if (durationSeconds >= localWhisperChunkThresholdSeconds) {
    return transcribeAudioPathWithLocalWhisperChunks(audioPath, {
      ...options,
      durationSeconds
    });
  }

  return transcribeAudioPathWithLocalWhisperSingle(audioPath, options);
}

async function transcribeAudioPathWithLocalWhisperSingle(audioPath, options = {}) {
  const command = await resolveLocalWhisperCommand();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-stt-local-whisper-'));
  const outputName = 'transcript';
  const outputPath = path.join(tmpDir, `${outputName}.json`);
  const durationSeconds = Math.max(0, Number(options.durationMs || 0) / 1000);
  let lastProgressPercent = 0;
  let outputBuffer = '';

  const onOutput = (chunk) => {
    outputBuffer += chunk.replace(/\r/g, '\n');
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop() || '';
    for (const line of lines) {
      const timestamp = parseWhisperSegmentEnd(line);
      if (timestamp === null) {
        continue;
      }

      const rawPercent = durationSeconds ? Math.min(95, Math.max(1, (timestamp / durationSeconds) * 95)) : null;
      const percent = rawPercent === null ? null : Math.max(lastProgressPercent, Math.round(rawPercent));
      if (percent !== null) {
        lastProgressPercent = percent;
      }
      options.onProgress?.({
        phase: 'Transcribing',
        percent,
        detail: `Reached ${formatProgressTimestamp(timestamp)}`
      });
    }
  };

  try {
    options.onProgress?.({
      phase: 'Loading local Whisper model',
      percent: 0,
      detail: 'Initializing MLX Whisper'
    });
    await runCommandStreaming(
      command,
      [
        audioPath,
        '--model',
        localWhisperModel,
        '--output-dir',
        tmpDir,
        '--output-name',
        outputName,
        '--output-format',
        'json',
        '--language',
        'en',
        '--condition-on-previous-text',
        'False',
        '--verbose',
        'True'
      ],
      null,
      3 * 60 * 60 * 1000,
      onOutput
    );
    const result = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    return {
      text: result.text || '',
      segments: result.segments || [],
      job: null
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function transcribeAudioPathWithLocalWhisperChunks(audioPath, options = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-stt-local-whisper-chunks-'));
  const durationSeconds = Math.max(0, Number(options.durationSeconds || 0));
  const chunks = buildAudioChunks(durationSeconds, {
    chunkSeconds: localWhisperChunkSeconds,
    overlapSeconds: localWhisperChunkOverlapSeconds
  });
  const stitchedSegments = [];
  const rejectedChunks = [];

  try {
    options.onProgress?.({
      phase: 'Preparing chunks',
      percent: 1,
      detail: `${chunks.length} audio chunks`
    });

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const label = `chunk ${index + 1}/${chunks.length}`;
      const { result, sanity } = await transcribeLocalWhisperChunk(audioPath, tmpDir, chunk, {
        ...options,
        durationSeconds,
        label
      });
      if (!sanity.ok) {
        options.onProgress?.({
          phase: 'Retrying chunk',
          percent: durationSeconds ? Math.max(1, Math.min(91, Math.round((chunk.start / durationSeconds) * 91))) : null,
          detail: `${label} looked suspicious`
        });
        const retry = await retrySuspiciousWhisperChunk(audioPath, tmpDir, chunk, {
          ...options,
          durationSeconds,
          label
        });
        if (!retry.sanity.ok) {
          rejectedChunks.push(retry.sanity.reason);
          continue;
        }
        stitchedSegments.push(...stitchWhisperSegments(retry.result.segments || [], chunk, stitchedSegments, {
          absolute: true
        }));
        continue;
      }

      stitchedSegments.push(...stitchWhisperSegments(result.segments || [], chunk, stitchedSegments));
    }

    if (rejectedChunks.length) {
      throw new Error(`Local Whisper rejected suspicious output: ${rejectedChunks.slice(0, 3).join('; ')}`);
    }

    const stitched = {
      text: stitchedSegments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim(),
      segments: stitchedSegments,
      job: null
    };
    const sanity = checkTranscriptionSanity(stitched, { label: 'stitched transcript' });
    if (!sanity.ok) {
      throw new Error(`Local Whisper rejected suspicious stitched output: ${sanity.reason}`);
    }

    return stitched;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function transcribeLocalWhisperChunk(audioPath, tmpDir, chunk, options = {}) {
  const safeLabel = String(options.label || `chunk-${chunk.start}`).replace(/[^a-z0-9_-]+/gi, '-');
  const chunkPath = path.join(tmpDir, `${safeLabel}-${Math.round(chunk.start * 1000)}.wav`);
  const durationSeconds = Math.max(0, Number(options.durationSeconds || 0));
  const chunkPercentBase = durationSeconds ? (chunk.start / durationSeconds) * 90 : null;

  options.onProgress?.({
    phase: 'Preparing chunk',
    percent: chunkPercentBase === null ? null : Math.max(1, Math.round(chunkPercentBase)),
    detail: `${options.label || 'chunk'} at ${formatProgressTimestamp(chunk.start)}`
  });
  await convertAudioSlice(audioPath, chunkPath, chunk.start, chunk.duration);

  const result = await transcribeAudioPathWithLocalWhisperSingle(chunkPath, {
    durationMs: chunk.duration * 1000,
    onProgress: (progress) => {
      const localPercent = Number(progress.percent);
      const chunkProgress = Number.isFinite(localPercent) && durationSeconds
        ? (chunk.start + chunk.duration * (localPercent / 95)) / durationSeconds
        : null;
      options.onProgress?.({
        phase: 'Transcribing chunk',
        percent: chunkProgress === null ? null : Math.max(1, Math.min(91, Math.round(chunkProgress * 91))),
        detail: `${options.label || 'chunk'} at ${formatProgressTimestamp(chunk.start)}`
      });
    }
  });

  const sanity = checkTranscriptionSanity(result, {
    label: options.label || 'chunk',
    allowEmpty: true
  });
  return { result, sanity };
}

async function retrySuspiciousWhisperChunk(audioPath, tmpDir, chunk, options = {}) {
  const depth = Number(options.depth || 0);
  const retryChunkSeconds = chunk.duration > 20 ? 12 : 6;
  const retryOverlapSeconds = chunk.duration > 20 ? 2 : 1;
  if (chunk.duration <= retryChunkSeconds + retryOverlapSeconds + 1) {
    return {
      result: { text: '', segments: [], job: null },
      sanity: { ok: false, reason: `${options.label || 'chunk'} stayed suspicious at ${chunk.duration.toFixed(1)}s` }
    };
  }

  const retryChunks = buildAudioChunks(chunk.duration, {
    chunkSeconds: retryChunkSeconds,
    overlapSeconds: retryOverlapSeconds,
    minChunkSeconds: 4
  }).map((retryChunk, index) => ({
    ...retryChunk,
    start: chunk.start + retryChunk.start,
    end: chunk.start + retryChunk.end,
    duration: retryChunk.duration,
    overlapSeconds: retryChunk.overlapSeconds,
    retryIndex: index
  }));
  const stitchedSegments = [];
  const failures = [];

  for (const retryChunk of retryChunks) {
    const label = `${options.label || 'chunk'} retry ${retryChunk.retryIndex + 1}/${retryChunks.length}`;
    const attempt = await transcribeLocalWhisperChunk(audioPath, tmpDir, retryChunk, {
      ...options,
      label
    });
    if (!attempt.sanity.ok) {
      if (depth < 2) {
        const retry = await retrySuspiciousWhisperChunk(audioPath, tmpDir, retryChunk, {
          ...options,
          label,
          depth: depth + 1
        });
        if (retry.sanity.ok) {
          stitchedSegments.push(...stitchWhisperSegments(retry.result.segments || [], retryChunk, stitchedSegments, {
            absolute: true
          }));
          continue;
        }
        failures.push(retry.sanity.reason);
        continue;
      }
      failures.push(attempt.sanity.reason);
      continue;
    }
    stitchedSegments.push(...stitchWhisperSegments(attempt.result.segments || [], retryChunk, stitchedSegments));
  }

  if (failures.length) {
    return {
      result: { text: stitchedSegments.map((segment) => segment.text).join(' ').trim(), segments: stitchedSegments, job: null },
      sanity: { ok: false, reason: failures.slice(0, 2).join('; ') }
    };
  }

  const result = {
    text: stitchedSegments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim(),
    segments: stitchedSegments,
    job: null
  };
  return {
    result,
    sanity: checkTranscriptionSanity(result, { label: `${options.label || 'chunk'} retry`, allowEmpty: true })
  };
}

function buildAudioChunks(durationSeconds, options = {}) {
  const minChunkSeconds = Math.max(1, Number(options.minChunkSeconds || 10));
  const chunkSeconds = Math.max(minChunkSeconds, Number(options.chunkSeconds || localWhisperChunkSeconds));
  const overlapSeconds = Math.max(0, Math.min(chunkSeconds / 3, Number(options.overlapSeconds || 0)));
  const step = chunkSeconds - overlapSeconds;
  const chunks = [];

  for (let start = 0; start < durationSeconds; start += step) {
    const end = Math.min(durationSeconds, start + chunkSeconds);
    chunks.push({
      start,
      end,
      duration: end - start,
      overlapSeconds
    });
    if (end >= durationSeconds) {
      break;
    }
  }

  return chunks;
}

async function convertAudioSlice(inputPath, outputPath, startSeconds, durationSeconds) {
  const ffmpegPath = await resolveFfmpegPath();
  await runCommand(
    ffmpegPath,
    [
      '-y',
      '-loglevel',
      'error',
      '-ss',
      String(Math.max(0, startSeconds)),
      '-t',
      String(Math.max(0.1, durationSeconds)),
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'wav',
      outputPath
    ],
    null,
    180_000
  );
}

function stitchWhisperSegments(segments, chunk, acceptedSegments, options = {}) {
  const overlapBoundary = chunk.start + chunk.overlapSeconds;
  const previousEnd = acceptedSegments.at(-1)?.end || 0;
  return segments
    .map((segment) => ({
      ...segment,
      start: Number(segment.start) + (options.absolute ? 0 : chunk.start),
      end: Number(segment.end) + (options.absolute ? 0 : chunk.start),
      text: String(segment.text || '').trim()
    }))
    .filter((segment) =>
      segment.text &&
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.end >= segment.start
    )
    .filter((segment) => {
      if (chunk.start === 0) {
        return true;
      }
      const normalized = normalizeTranscriptText(segment.text);
      const duplicate = acceptedSegments
        .slice(-8)
        .some((accepted) => normalizeTranscriptText(accepted.text) === normalized);
      if (duplicate && segment.end <= overlapBoundary + 1) {
        return false;
      }
      return segment.end > Math.max(overlapBoundary, previousEnd - 0.5);
    });
}

function checkTranscriptionSanity(result, options = {}) {
  const segments = Array.isArray(result.segments) ? result.segments : [];
  const label = options.label || 'transcript';
  const normalizedSegments = segments
    .map((segment) => normalizeTranscriptText(segment.text))
    .filter(Boolean);

  if (!normalizedSegments.length && !options.allowEmpty) {
    return { ok: false, reason: `${label} returned no text` };
  }

  const counts = new Map();
  for (const text of normalizedSegments) {
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  const topRepeat = Math.max(0, ...counts.values());
  if (normalizedSegments.length >= 8 && topRepeat >= Math.max(6, Math.ceil(normalizedSegments.length * 0.55))) {
    return { ok: false, reason: `${label} repeated one segment ${topRepeat}/${normalizedSegments.length} times` };
  }

  const repeatedRun = longestRepeatedRun(normalizedSegments);
  if (repeatedRun >= 5) {
    return { ok: false, reason: `${label} repeated the same segment ${repeatedRun} times in a row` };
  }

  const suspiciousCompression = segments.filter((segment) => Number(segment.compression_ratio) >= 8).length;
  if (segments.length >= 4 && suspiciousCompression >= Math.max(3, Math.ceil(segments.length * 0.5))) {
    return { ok: false, reason: `${label} had suspicious Whisper compression ratios` };
  }

  return { ok: true };
}

function normalizeTranscriptText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function longestRepeatedRun(values) {
  let longest = 0;
  let current = 0;
  let previous = null;
  for (const value of values) {
    if (value && value === previous) {
      current += 1;
    } else {
      current = value ? 1 : 0;
      previous = value;
    }
    longest = Math.max(longest, current);
  }
  return longest;
}

async function annotateTranscript(audioPath, transcription, options = {}) {
  const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
  if (!segments.length) {
    return {
      annotations: [],
      model: null,
      source: null
    };
  }

  const pyannoteAvailable = await hasLocalPyannoteModel();
  const speechSwift = await resolveSpeechSwiftCommand().catch(() => null);
  if (speechSwift) {
    try {
      const diarization = await runSpeechSwiftDiarization(audioPath, {
        ...options,
        command: speechSwift.command,
        args: speechSwift.args
      });
      return {
        annotations: reconcileAnnotations(segments, {
          source: diarization.source,
          backend: options.backend?.id || null,
          diarizationSegments: diarization.segments
        }),
        model: diarization.model,
        source: diarization.source
      };
    } catch (error) {
      options.onProgress?.({
        phase: 'Annotating transcript',
        percent: options.backend?.id === 'local' ? 95 : null,
        detail: `Diarization unavailable: ${error.message}`
      });
    }
  }

  return {
    annotations: reconcileAnnotations(segments, {
      source: 'whisper-segments',
      backend: options.backend?.id || null
    }),
    model: pyannoteAvailable ? annotationModelLabel() : null,
    source: pyannoteAvailable ? 'whisper-segments-pyannote-ready' : 'whisper-segments'
  };
}

function reconcileAnnotations(segments, options = {}) {
  const mapped = segments
    .map((segment, index) => ({
      id: `annotation-${index + 1}`,
      start: Number(segment.start),
      end: Number(segment.end),
      speaker: pickSpeakerForSegment(segment, options.diarizationSegments) || 'Speaker 1',
      kind: 'Speech',
      source: options.source,
      text: String(segment.text || '').trim()
    }))
    .filter((segment) =>
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.end >= segment.start &&
      segment.text
    );

  return mergeAdjacentAnnotations(mapped);
}

function mergeAdjacentAnnotations(annotations) {
  const merged = [];
  for (const annotation of annotations) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.speaker === annotation.speaker &&
      previous.source === annotation.source &&
      annotation.start - previous.end <= 1.5
    ) {
      previous.end = annotation.end;
      previous.text = `${previous.text} ${annotation.text}`.replace(/\s+/g, ' ').trim();
      continue;
    }
    merged.push({ ...annotation });
  }

  return merged.map((annotation, index) => ({
    ...annotation,
    id: `annotation-${index + 1}`
  }));
}

function pickSpeakerForSegment(segment, diarizationSegments = []) {
  if (!Array.isArray(diarizationSegments) || !diarizationSegments.length) {
    return null;
  }

  const start = Number(segment.start);
  const end = Number(segment.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  let best = null;
  let bestOverlap = 0;
  for (const diarized of diarizationSegments) {
    const overlap = Math.max(0, Math.min(end, diarized.end) - Math.max(start, diarized.start));
    if (overlap > bestOverlap) {
      best = diarized;
      bestOverlap = overlap;
    }
  }

  return bestOverlap > 0 ? best.speaker : null;
}

async function runSpeechSwiftDiarization(audioPath, options = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-stt-diarize-'));
  const wavPath = path.join(tmpDir, 'diarization.wav');
  const engine = process.env.DIARIZATION_ENGINE || 'pyannote';
  const embeddingEngine = process.env.DIARIZATION_EMBEDDING_ENGINE || 'mlx';
  let outputBuffer = '';
  let stdout = '';

  const onOutput = (chunk) => {
    stdout += chunk;
    outputBuffer += chunk.replace(/\r/g, '\n');
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop() || '';
    for (const line of lines) {
      const progress = parseSpeechSwiftProgress(line);
      if (progress === null) {
        const status = parseSpeechSwiftStatus(line);
        if (status) {
          options.onProgress?.({
            phase: 'Diarizing speakers',
            percent: options.backend?.id === 'local' ? 97 : null,
            detail: status
          });
        }
        continue;
      }
      options.onProgress?.({
        phase: 'Diarizing speakers',
        percent: options.backend?.id === 'local' ? Math.min(98, 95 + Math.round(progress.percent * 0.03)) : null,
        detail: progress.detail
      });
    }
  };

  try {
    options.onProgress?.({
      phase: 'Preparing diarization audio',
      percent: options.backend?.id === 'local' ? 95 : null,
      detail: 'Converting to 16 kHz mono WAV'
    });
    await convertAudio(audioPath, wavPath, ['-ac', '1', '-ar', '16000', '-f', 'wav']);

    options.onProgress?.({
      phase: 'Diarizing speakers',
      percent: options.backend?.id === 'local' ? 95 : null,
      detail: `speech-swift ${engine}`
    });
    await runCommandStreaming(
      options.command,
      [
        ...options.args,
        'diarize',
        wavPath,
        '--engine',
        engine,
        '--embedding-engine',
        embeddingEngine,
        '--json'
      ],
      null,
      3 * 60 * 60 * 1000,
      onOutput
    );

    const result = extractJsonPayload(stdout);
    const segments = normalizeDiarizationSegments(result.segments || []);
    return {
      segments,
      model: speechSwiftModelLabel(engine, embeddingEngine),
      source: `speech-swift-${engine}`
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function parseSpeechSwiftProgress(line) {
  const match = line.match(/\[\s*([0-9]{1,3})%\]\s*(.+)$/);
  if (!match) {
    return null;
  }
  return {
    percent: Math.max(0, Math.min(100, Number(match[1]))),
    detail: match[2].trim()
  };
}

function parseSpeechSwiftStatus(line) {
  const normalized = line.trim();
  if (normalized === 'Running diarization...') {
    return 'Running speaker clustering';
  }
  if (normalized.startsWith('Loading diarization models')) {
    return normalized;
  }
  return null;
}

function extractJsonPayload(text) {
  const candidates = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{' || text[index] === '[') {
      candidates.push(index);
    }
  }

  for (const index of candidates) {
    try {
      const parsed = JSON.parse(text.slice(index).trim());
      if (parsed && (Array.isArray(parsed.segments) || Array.isArray(parsed))) {
        return parsed;
      }
    } catch {
      // Try the next JSON-looking offset.
    }
  }

  throw new Error('speech-swift did not emit parseable diarization JSON');
}

function normalizeDiarizationSegments(segments) {
  return segments
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      speaker: formatDiarizedSpeaker(segment.speaker)
    }))
    .filter((segment) =>
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.end >= segment.start &&
      segment.speaker
    );
}

function formatDiarizedSpeaker(value) {
  const speakerId = Number(value);
  if (Number.isFinite(speakerId)) {
    return `Speaker ${speakerId + 1}`;
  }
  return value ? `Speaker ${String(value)}` : null;
}

async function hasLocalPyannoteModel() {
  try {
    await fs.access(path.join(localPyannoteModel, 'weights.npz'));
    await fs.access(path.join(localPyannoteModel, 'config.json'));
    return true;
  } catch {
    return false;
  }
}

function annotationModelLabel() {
  return 'mlx-community/pyannote-segmentation-3.0-mlx';
}

function speechSwiftModelLabel(engine, embeddingEngine) {
  if (engine === 'sortformer') {
    return 'soniqo/speech-swift sortformer CoreML';
  }
  return `soniqo/speech-swift pyannote + WeSpeaker ${embeddingEngine}`;
}

async function getSelectedSpeechBackend() {
  const settings = await readSettings();
  return speechBackends[settings.speechBackend] || speechBackends.homelab;
}

async function resolveHomelabCommand() {
  if (process.env.HOMELAB_CLI_PATH) {
    return { command: process.env.HOMELAB_CLI_PATH, args: [] };
  }

  const binaryCandidates = [
    homelabVenvBin,
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'homelab'))
  ];

  for (const candidate of binaryCandidates) {
    try {
      await fs.access(candidate);
      return { command: candidate, args: [] };
    } catch {
      // Try the next candidate.
    }
  }

  try {
    await fs.access(homelabCliScript);
    return { command: '/usr/bin/python3', args: [homelabCliScript] };
  } catch {
    throw new Error('homelab-cli not found at ~/git/gisenberg/homelab-cli and homelab is not on PATH');
  }
}

async function resolveLocalWhisperCommand() {
  const candidates = [
    process.env.LOCAL_WHISPER_PATH,
    localWhisperBin,
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'mlx_whisper'))
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('mlx_whisper not found. Set LOCAL_WHISPER_PATH or run the local Whisper setup.');
}

async function resolveSpeechSwiftCommand() {
  const candidates = [
    process.env.SONIQO_SPEECH_PATH,
    speechSwiftBin,
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'speech'))
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { command: candidate, args: [] };
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('speech-swift CLI not found. Set SONIQO_SPEECH_PATH or run npm run setup:diarization.');
}

async function runCodexRefinement(markdown, prompt) {
  const codexPath = await resolveCodexPath();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-stt-codex-'));
  const outputPath = path.join(tmpDir, 'refined.md');
  const fullPrompt = `${prompt}

Return only the refined markdown notes. Do not include surrounding commentary, code fences, or tool-use narration.

Raw transcript markdown:

${markdown}`;

  try {
    await runCommand(
      codexPath,
      [
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never',
        'exec',
        '--cd',
        projectRoot,
        '--output-last-message',
        outputPath,
        '-'
      ],
      fullPrompt,
      300_000
    );

    const output = (await fs.readFile(outputPath, 'utf8')).trim();
    if (!output) {
      throw new Error('Codex returned an empty refinement');
    }
    return output;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function convertRecordingToMp3(recording) {
  const inputPath = path.join(recordingsDir(), recording.audioFile);
  const mp3File = recording.audioFile.replace(/\.[^.]+$/i, '.mp3');
  const outputPath = path.join(recordingsDir(), mp3File);
  await convertAudio(inputPath, outputPath, ['-codec:a', 'libmp3lame', '-q:a', '3']);
  return mp3File;
}

async function convertAudio(inputPath, outputPath, extraArgs = []) {
  const ffmpegPath = await resolveFfmpegPath();
  await runCommand(
    ffmpegPath,
    ['-y', '-loglevel', 'error', '-i', inputPath, ...extraArgs, outputPath],
    null,
    180_000
  );
}

async function resolveFfmpegPath() {
  const candidates = [
    process.env.FFMPEG_PATH,
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'ffmpeg')),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('ffmpeg not found. Set FFMPEG_PATH or install ffmpeg.');
}

async function resolveCodePath() {
  const candidates = [
    process.env.CODE_PATH,
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'code')),
    '/opt/homebrew/bin/code',
    '/usr/local/bin/code',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    path.join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('code CLI not found. Install the VS Code shell command or set CODE_PATH.');
}

function runCommand(command, args, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(command)} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });

    if (stdin !== null && stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function runCommandStreaming(command, args, stdin, timeoutMs, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      onOutput?.(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.(text);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(command)} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });

    if (stdin !== null && stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function runCommandCapture(command, args, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${path.basename(command)} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });

    if (stdin !== null && stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function emitTranscriptionProgress(event, recordingId, progress) {
  event.sender.send('recordings:transcriptionProgress', {
    recordingId,
    percent: progress.percent ?? null,
    phase: progress.phase || 'Transcribing',
    detail: progress.detail || '',
    backend: progress.backend || null,
    updatedAt: Date.now()
  });
}

function parseWhisperSegmentEnd(line) {
  const match = line.match(/\[\s*([0-9:.]+)\s+-->\s+([0-9:.]+)\s*\]/);
  if (!match) {
    return null;
  }
  return parseProgressTimestamp(match[2]);
}

function parseProgressTimestamp(value) {
  const parts = value.split(':').map(Number);
  if (parts.some((part) => Number.isNaN(part))) {
    return null;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

function formatProgressTimestamp(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const remainder = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

async function resolveCodexPath() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'codex')),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('Codex CLI not found. Set CODEX_CLI_PATH or launch the app from a shell where codex is on PATH.');
}

function toFloat32Array(value) {
  if (value instanceof Float32Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Float32Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 4));
  }

  return new Float32Array(value);
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, 44 + i * bytesPerSample);
  }

  return buffer;
}

function createTitle(text) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return `Recording ${new Date().toLocaleString()}`;
  }

  return normalized.slice(0, 48) + (normalized.length > 48 ? '...' : '');
}

function sanitizeTitle(value) {
  const base = String(value || '')
    .replace(/\.md$/i, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim();
  return base || `Recording ${new Date().toLocaleString()}`;
}

async function uniqueMarkdownFileName(title, currentFile) {
  const items = await readIndex();
  const existing = new Set(markdownFiles(items).filter((file) => file !== currentFile));
  const base = sanitizeTitle(title).replace(/\s+/g, '-').slice(0, 80) || 'recording';
  let candidate = `${base}.md`;
  let index = 2;

  while (existing.has(candidate)) {
    candidate = `${base}-${index}.md`;
    index += 1;
  }

  return candidate;
}

async function uniqueDerivedMarkdownFileName(sourceFile, suffix) {
  const items = await readIndex();
  const existing = new Set(markdownFiles(items));
  const ext = path.extname(sourceFile) || '.md';
  const base = sourceFile.slice(0, sourceFile.length - ext.length);
  let candidate = `${base}${suffix}${ext}`;
  let index = 2;

  while (existing.has(candidate)) {
    candidate = `${base}${suffix}-${index}${ext}`;
    index += 1;
  }

  return candidate;
}

function markdownFiles(items) {
  return items.flatMap((item) => [
    item.markdownFile,
    ...(item.refinements || []).map((refinement) => refinement.markdownFile)
  ]).filter(Boolean);
}

function ensureMarkdownTitle(markdown, title) {
  const trimmed = markdown.trim();
  if (/^#\s+/m.test(trimmed)) {
    return `${trimmed}\n`;
  }

  return `# ${title}\n\n${trimmed}\n`;
}

function retitleMarkdown(markdown, title) {
  const trimmed = markdown.trim();
  if (/^#\s+/m.test(trimmed)) {
    return `${trimmed.replace(/^#\s+.*$/m, `# ${title}`)}\n`;
  }

  return `# ${title}\n\n${trimmed}\n`;
}
