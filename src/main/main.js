import { app, BrowserWindow, ipcMain, shell, session } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const isDev = Boolean(process.env.ELECTRON_START_URL);
const recordingsDir = () => path.join(app.getPath('userData'), 'recordings');
const indexPath = () => path.join(recordingsDir(), 'index.json');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const modelRepo = 'homelab stt large-v3';
const homelabCliScript = path.join(os.homedir(), 'git/gisenberg/homelab-cli/src/homelab_cli/cli.py');
const homelabVenvBin = path.join(os.homedir(), 'git/gisenberg/homelab-cli/.venv/bin/homelab');
const defaultRefinementPrompt = `Turn this raw speech transcript into concise, high-signal technical notes for an audience deeply experienced in Unreal Engine.

Prioritize:
- Items that are new in Unreal Engine 5.8.
- Features, APIs, workflows, constraints, or behaviors that seem new, novel, experimental, previously unannounced, or easy for experienced Unreal developers to miss.
- Practical implications for production teams, engine programmers, technical artists, tools engineers, rendering engineers, and gameplay programmers.

Write with the assumption that the reader already understands Unreal Engine fundamentals. Avoid introductory explanations, marketing language, and generic summaries. Preserve uncertainty explicitly: if the transcript only implies something, label it as inferred rather than confirmed.

Format the result as markdown with:
- A short title.
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
    await fs.writeFile(settingsPath(), JSON.stringify({ refinementPrompt: defaultRefinementPrompt }, null, 2), 'utf8');
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
  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
});

ipcMain.handle('recordings:transcribeAndSave', async (_event, payload) => {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const createdAt = new Date().toISOString();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue-stt-'));
  const wavPath = path.join(tmpDir, `${id}.wav`);
  const outputPath = path.join(tmpDir, `${id}.json`);

  try {
    await assertEngineReady();
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
      model: modelRepo,
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
    title: `Recording ${new Date(createdAt).toLocaleString()}`,
    durationMs: payload.durationMs || 0,
    audio: payload.audio,
    transcribed: false
  });
});

ipcMain.handle('recordings:transcribeExisting', async (_event, id) => {
  const items = await readIndex();
  const item = items.find((recording) => recording.id === id);
  if (!item) {
    throw new Error('Recording not found');
  }
  if (!item.audioFile) {
    throw new Error('Recording has no source audio');
  }

  await assertEngineReady();
  const audioPath = path.join(recordingsDir(), item.audioFile);
  const result = await transcribeAudioPath(audioPath);
  const title = item.transcribed ? item.title : createTitle(result.text || '') || item.title;
  const mp3File = await convertRecordingToMp3(item);
  const updated = {
    ...item,
    title,
    text: result.text || '',
    chunks: result.segments || [],
    model: modelRepo,
    transcribed: true,
    mp3File
  };

  await fs.writeFile(path.join(recordingsDir(), updated.markdownFile), createMarkdown(updated), 'utf8');
  await writeIndex(items.map((recording) => (recording.id === id ? updated : recording)));
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

ipcMain.handle('recordings:readMarkdown', async (_event, id) => {
  const items = await readIndex();
  const item = items.find((recording) => recording.id === id);
  if (!item) {
    return null;
  }

  return fs.readFile(path.join(recordingsDir(), item.markdownFile), 'utf8');
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

ipcMain.handle('recordings:reveal', async (_event, id) => {
  const items = await readIndex();
  const item = items.find((recording) => recording.id === id);
  if (!item) {
    return false;
  }

  shell.showItemInFolder(path.join(recordingsDir(), item.markdownFile));
  return true;
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
  const refinedMarkdown = await runCodexRefinement(sourceMarkdown, prompt || defaultRefinementPrompt);
  const refined = await saveRefinedRecording(item, refinedMarkdown);
  return refined;
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
    model: payload.model || (payload.transcribed ? modelRepo : 'Pending transcription'),
    text: payload.text || '',
    chunks: payload.chunks || [],
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

async function saveRefinedRecording(source, refinedMarkdown) {
  const id = `${source.id}-refined-${Date.now()}`;
  const title = `${source.title.replace(/\s+REFINED$/i, '')} REFINED`;
  const markdownFile = await uniqueDerivedMarkdownFileName(source.markdownFile, '_REFINED');
  const recording = {
    ...source,
    id,
    title,
    createdAt: new Date().toISOString(),
    sourceRecordingId: source.sourceRecordingId || source.id,
    markdownFile,
    text: refinedMarkdown,
    chunks: [],
    transcribed: true,
    refined: true
  };

  await fs.writeFile(path.join(recordingsDir(), markdownFile), ensureMarkdownTitle(refinedMarkdown, title), 'utf8');
  const items = await readIndex();
  await writeIndex([recording, ...items]);
  return recording;
}

async function assertEngineReady() {
  const status = await inspectEngine();
  if (status.state !== 'ready') {
    throw new Error(status.message);
  }
}

async function inspectEngine() {
  try {
    const homelab = await resolveHomelabCommand();
    const { stdout } = await runCommandCapture(homelab.command, [...homelab.args, 'health', '--json'], null, 30_000);
    const health = JSON.parse(stdout);
    if (health.stt?.status === 'error' || health.stt?.configured === false || health.stt?.error) {
      return {
        state: 'missing',
        message: `Homelab STT unavailable: ${health.stt?.error || 'not configured'}`,
        model: modelRepo
      };
    }

    return {
      state: 'ready',
      message: `Homelab STT ready (${health.stt?.model || 'large-v3'})`,
      model: modelRepo,
      backend: health.stt
    };
  } catch (error) {
    return {
      state: 'missing',
      message: `Homelab STT unavailable: ${error.message}`,
      model: modelRepo
    };
  }
}

async function transcribeAudioPath(audioPath) {
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
      reject(new Error(`Codex exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
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
  const existing = new Set(items.map((item) => item.markdownFile).filter((file) => file !== currentFile));
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
  const existing = new Set(items.map((item) => item.markdownFile));
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
