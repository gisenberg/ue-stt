# AGENTS.md

## Project

`ue-stt` is an Electron + Vite + React app for recording microphone audio, transcribing it through the Homelab speech-to-text plugin, saving transcripts as markdown, and refining transcripts into Unreal Engine focused notes with Codex CLI.

## Commands

- `npm run dev` starts Vite on `http://127.0.0.1:5185` and launches Electron.
- `npm run build` builds the renderer into `dist/`.
- `npm run test:web` runs the Playwright browser smoke tests.
- `npm run setup:homelab` runs the Homelab CLI virtualenv setup script from `~/git/gisenberg/homelab-cli`.

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

## App Data

- Electron recording data is stored in the app user data directory, typically:
  `~/Library/Application Support/ue-stt/recordings`.
- A successful full transcription writes markdown and then converts the original `.webm` recording to `.mp3` with `ffmpeg`.
- Refinement prompt settings are persisted in Electron user data `settings.json`.

## Testing Notes

- Browser tests use the renderer fallback implementation in `src/renderer/platform.js`; they do not require the Electron shell or Homelab.
- Keep tests focused on user-visible recorder, rename, refinement, and dark-mode behavior.
- Before finishing UI work, run `npm run build` and `npm run test:web`.

## Repository Hygiene

- Do not commit generated or heavyweight local artifacts: `node_modules/`, `dist/`, `.venv/`, `models/`, `test-results/`, logs, or downloaded model files.
- Use `apply_patch` for manual file edits.
- Prefer `rg` / `rg --files` for search.
- Avoid reverting unrelated user changes in a dirty worktree.
