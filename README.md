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
```

**MidiWriterJS APIs used:** 
- Track.setTempo, 
- Track.setTimeSignature, 
- NoteEvent with tick and duration: 'Tn', and new Writer(tracks).buildFile(). See the project README for details. 

Docs reference: MidiWriterJS README “Getting Started / Documentation” sections.

---

## Notes & roadmap

- **Tempo**: export uses the BPM box (default 120). If you want “smart tempo,” we can add tap-tempo or estimate from inter-onset intervals later.
- **Sustain (CC64)**: handled so held notes end when the pedal lifts — not at key release.
- **CC / pitch bend**: captured in the event log but not yet written to the MIDI file. MidiWriterJS supports additional events; we can add CC envelopes & pitch bend lanes in v1.1.
- **Multiple inputs**: currently merged; we can add per-device tracks on request.
- **PPQ**: using `Tn` ticks mapped from ms with PPQ=128 (per MidiWriterJS doc where `T128 = 1 beat`).  [oai_citation:1‡GitHub](https://github.com/grimmdude/MidiWriterJS)

---

## Suggested repo name
**`catchonika`** (alt: **captureonika**, **recallonika**).  
If you give me the green light on **Catchonika**, create the repo and I’ll tailor any wiring for Midonika/Clavonika harmony in your rack.

Want it embedded as a React Flow node later? Easy: we’ll wrap this class in a tiny node component and forward the buttons & status.