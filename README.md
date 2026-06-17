# UnrealFest STT

An Electron app for recording microphone audio, transcribing it through Homelab speech-to-text, saving transcripts as markdown, and refining transcripts into Unreal Engine focused notes with Codex CLI.

## Features

- Record audio from the Mac microphone.
- Save recordings locally with transcript markdown.
- Choose between live transcription and manual transcription after recording.
- Transcribe through the Homelab CLI speech-to-text plugin.
- Convert `.webm` recordings to `.mp3` after successful transcription.
- Browse prior recordings in the left navigation.
- Rename generated markdown files.
- View waveform playback controls for recorded audio.
- Refine transcripts into `_REFINED.md` notes with an editable prompt.
- Dark-mode focused interface.

## Requirements

- macOS with microphone access for Electron.
- Node.js and npm.
- `ffmpeg` available on `PATH` for `.webm` to `.mp3` conversion.
- Homelab CLI checked out at `~/git/gisenberg/homelab-cli`, or a `homelab` binary available through `HOMELAB_CLI_PATH` or `PATH`.
- Homelab STT configured and healthy. The app expects the Homelab STT plugin to provide faster-whisper `large-v3`.
- Codex CLI available if you want to use transcript refinement.

## Setup

Install dependencies:

```sh
npm install
```

Set up Homelab CLI if needed:

```sh
npm run setup:homelab
```

Verify Homelab STT directly:

```sh
homelab health --json
```

If `homelab` is not on `PATH`, the app will also try:

- `HOMELAB_CLI_PATH`
- `~/git/gisenberg/homelab-cli/.venv/bin/homelab`
- `/usr/bin/python3 ~/git/gisenberg/homelab-cli/src/homelab_cli/cli.py`

## Development

Start the Electron app with Vite:

```sh
npm run dev
```

The renderer runs at:

```text
http://127.0.0.1:5185
```

Build the renderer:

```sh
npm run build
```

Run the browser smoke test:

```sh
npm run test:web
```

## Transcription Flow

The app saves microphone recordings first, then lets you transcribe on demand. If live transcription is enabled, the renderer sends audio chunks to Electron while recording. Electron writes each chunk as a temporary WAV file and calls:

```sh
homelab stt <audio> --language en --json
```

Manual transcription uses the same Homelab command against the saved recording file. After successful full transcription, the app writes the markdown transcript and creates an `.mp3` version of the original `.webm` recording.

## Refinement

The refinement panel sends the selected markdown transcript and the current refinement prompt to Codex CLI. Refined output is saved next to the source markdown with a `_REFINED.md` suffix.

Before sending the transcript to Codex, the app compacts generated markdown by preserving the title, metadata, and `## Transcript` body while omitting duplicated timestamped `## Segments` content.

The default prompt is tuned for Unreal Engine experts and prioritizes details that are new, novel, or especially relevant to Unreal Engine 5.8.

## Local Data

Electron stores app data under the normal user data directory. On macOS, recordings are typically in:

```text
~/Library/Application Support/ue-stt/recordings
```

Prompt settings are stored in:

```text
~/Library/Application Support/ue-stt/settings.json
```

## Notes

Generated and heavyweight local artifacts are intentionally not committed, including `node_modules/`, `dist/`, `.venv/`, `models/`, `test-results/`, logs, and downloaded model files.
