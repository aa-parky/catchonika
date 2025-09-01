# Catchonika — default-on MIDI capture for the browser

**Never miss the melody.** Catchonika starts recording from **every available Web MIDI input** as soon as it loads. Save the last 60s (or any range) or the whole session to a `.mid` using [MidiWriterJS](https://github.com/grimmdude/MidiWriterJS).

## Features
- **Default-on**: starts capturing immediately (all MIDI inputs)
- **Rolling buffer** (configurable minutes)
- **Sustain-aware**: CC64 hold/release is applied to note durations
- **Velocity preserved**
- **Export**: save last N seconds or full session via MidiWriterJS tracks
- Optional **track per channel** grouping

## Quick start
```html
<link rel="stylesheet" href="styles/catchonika.css" />
<script src="https://unpkg.com/midi-writer-js@3.1.1"></script>
<script src="src/catchonika.js"></script>
<script>
  new Catchonika({ bufferMinutes: 30, defaultBpm: 120 });
</script>
