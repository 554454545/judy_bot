# Basic Usage Examples

Run these commands from the project root. Relative paths in these examples refer to that root.
Create `outputs/tts/` before choosing an explicit output there.

## Single Text Conversion

**User:** Generate audio for "Hello, welcome to our product demo"

**Expected behavior:**
```bash
set -a && source .env && set +a && \
source .venv/bin/activate && \
python .pi/skills/joye/gemini-tts-fast/tts_cli.py "Hello, welcome to our product demo" --output="outputs/tts/output.wav" --speed=1.2
```

## Custom Output File

**User:** Convert "Thank you for watching" to thanks.wav

**Expected behavior:**
```bash
set -a && source .env && set +a && \
source .venv/bin/activate && \
python .pi/skills/joye/gemini-tts-fast/tts_cli.py "Thank you for watching" --output="outputs/tts/thanks.wav" --speed=1.2
```

## Different Voice

**User:** Use Aoede voice for "This is a smooth narration"

**Expected behavior:**
```bash
set -a && source .env && set +a && \
source .venv/bin/activate && \
python .pi/skills/joye/gemini-tts-fast/tts_cli.py "This is a smooth narration" --output="outputs/tts/output.wav" --voice="Aoede" --speed=1.2
```

## Script File Processing

**User:** Process narration from @script.json

**Expected behavior:**
- Read script.json file
- Extract narration from each scene
- Generate individual WAV files (scene-1.wav, scene-2.wav, etc.)
- All files generated at 1.2x speed automatically
