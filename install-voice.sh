#!/usr/bin/env bash
# Installs the local voice stack (Kokoro TTS + Parakeet STT, MLX) into .venv-voice.
# Apple Silicon only. First run downloads ~1.5 GB of models on first server start.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(uname -m)" = "arm64" ] || { echo "Needs Apple Silicon (arm64)."; exit 1; }
command -v ffmpeg >/dev/null || { echo "Needs ffmpeg: brew install ffmpeg"; exit 1; }
python3 -m venv .venv-voice
.venv-voice/bin/pip install -q -U pip
.venv-voice/bin/pip install -q mlx-audio parakeet-mlx soundfile "misaki[en]" num2words phonemizer-fork espeakng-loader
mkdir -p logs
echo "Local voice installed. Restart the dashboard (./start.sh)."
