# AGENTS.md

## Project

`ue-stt` is an Electron + Vite + React app for recording microphone audio, transcribing it through the Homelab speech-to-text plugin, saving transcripts as markdown, and refining transcripts into Unreal Engine focused notes with Codex CLI.

## Commands

- `npm run dev` starts Vite on `http://127.0.0.1:5185` and launches Electron.
- `npm run build` builds the renderer into `dist/`.
- `npm run test:web` runs the Playwright browser smoke tests.
- `npm run setup:homelab` runs the Homelab CLI virtualenv setup script from `~/git/gisenberg/homelab-cli`.
- `npm run setup:pyannote` downloads `mlx-community/pyannote-segmentation-3.0-mlx` into the ignored local `models/` directory.
- `npm run setup:diarization` clones/builds Soniqo `speech-swift` into ignored `vendor/speech-swift` and installs the Xcode Metal Toolchain component if `metal` is missing.

## Speech To Text

- Manual and live transcription both use Homelab CLI, not Transformers.js or the old local MLX helper.
- The Electron main process resolves Homelab in this order:
  1. `HOMELAB_CLI_PATH`
  2. `~/git/gisenberg/homelab-cli/.venv/bin/homelab`
  3. `homelab` on `PATH`
  4. `/usr/bin/python3 ~/git/gisenberg/homelab-cli/src/homelab_cli/cli.py`
- Full-file transcription sends the saved source audio path to `homelab stt <audio> --language en --json`.
- Live transcription sends temporary WAV chunks through the same Homelab STT command via `recordings:transcribeChunk`.
- Homelab health is checked through `homelab health --json`; the expected STT backend is faster-whisper with `large-v3`.
- Local Whisper uses `.venv/bin/mlx_whisper` with `models/whisper-large-v3-mlx`.
- Local Whisper transcriptions can produce an `## Annotated Transcript` section. Whisper supplies timestamped text segments; Soniqo `speech-swift` supplies local Apple Silicon diarization through `speech diarize <wav> --engine pyannote --embedding-engine mlx --json`.
- The Electron main process resolves the diarization CLI in this order:
  1. `SONIQO_SPEECH_PATH`
  2. `vendor/speech-swift/.build/release/speech`
  3. `speech` on `PATH`
- Diarization converts source audio to a temporary 16 kHz mono WAV, parses the final JSON payload from `speech-swift` stdout, and assigns each Whisper segment to the speaker with the strongest timestamp overlap.
- If `speech-swift` is unavailable or diarization fails, the app falls back to Whisper timestamp segments labeled as `Speaker 1`.

## App Data

- Electron recording data is stored in the app user data directory, typically:
  `~/Library/Application Support/ue-stt/recordings`.
- A successful full transcription writes markdown and then converts the original `.webm` recording to `.mp3` with `ffmpeg`.
- Refinement input compaction prefers `## Annotated Transcript` when present, otherwise `## Transcript`, and drops duplicated `## Segments`.
- Refinement prompt settings are persisted in Electron user data `settings.json`.

## Testing Notes

- Browser tests use the renderer fallback implementation in `src/renderer/platform.js`; they do not require the Electron shell or Homelab.
- Keep tests focused on user-visible recorder, rename, refinement, and dark-mode behavior.
- Before finishing UI work, run `npm run build` and `npm run test:web`.

## Repository Hygiene

- Do not commit generated or heavyweight local artifacts: `node_modules/`, `dist/`, `.venv/`, `models/`, `vendor/`, `test-results/`, logs, or downloaded model files.
- Use `apply_patch` for manual file edits.
- Prefer `rg` / `rg --files` for search.
- Avoid reverting unrelated user changes in a dirty worktree.
