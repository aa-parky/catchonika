# Catchonika

**Never miss the melody.** Catchonika is a default-on MIDI recorder for the browser.  
It listens to all available Web MIDI inputs as soon as it loads and lets you export either the **last N seconds** or the **entire session** to a `.mid` file.

- Sustain (CC64) informed durations
- Velocity preserved
- Optional per-channel track grouping
- Renders as a compact **card** that fits inside tabs/panels

---

## Contents

- [Demo](#demo)
- [Features](#features)
- [Quick start (Vendor Option 1)](#quick-start-vendor-option-1)
- [Project layout](#project-layout)
- [Usage in your page](#usage-in-your-page)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Demo

Open the tabbed demo page:

- `demo/index.html` – simple, accessible tabs with Catchonika mounted in the **Recorder** tab

> The demo expects the local **vendor** copy of MidiWriterJS and the card stylesheet.

---

## Features

- **Default-on capture**: starts recording as soon as the page loads
- **Rolling buffer**: configurable minutes (e.g., 30/60/etc.)
- **Sustain pedal aware**: CC64 hold/release applied to note durations
- **Velocity preserved**
- **Export to MIDI**: save the last 60s or entire session
- **Card mode**: clean, self-contained UI suitable for tabs and panels
- **Floating fallback**: if no mount element is provided

---

## Quick start (Vendor Option 1)

This runs completely **offline** and avoids any CDN.

1. **Install dependencies** (ensures `node_modules` exists):

   ```bash
   npm install
   ```

2. **Vendor the browser build of MidiWriterJS**:

   ```bash
   mkdir -p vendor
   cp node_modules/midi-writer-js/browser/midiwriter.js vendor/midiwriter.js
   ```

   Optional convenience scripts (add to `package.json`):

   ```json
   {
     "scripts": {
       "postinstall": "mkdir -p vendor && cp node_modules/midi-writer-js/browser/midiwriter.js vendor/midiwriter.js",
       "serve": "http-server -p 5173"
     },
     "devDependencies": {
       "http-server": "^14.1.1"
     }
   }
   ```

3. **Serve locally** (Web MIDI requires a secure context; `http://localhost` is allowed):

   ```bash
   npx http-server -p 5173
   # or
   python3 -m http.server 5173
   ```

4. **Open the demo**:
    - Go to: `http://localhost:5173/demo/`

---

## Project layout

```
catchonika/
├─ README.md
├─ LICENSE
├─ styles/
│  └─ catchonika.css        # card styles
├─ src/
│  └─ catchonika.js         # recorder logic (card-ready)
├─ vendor/
│  └─ midiwriter.js         # vendored MidiWriterJS (after step 2)
└─ demo/
   └─ index.html            # tabbed demo mounting Catchonika in a card
```

---

## Usage in your page

Minimal example (matches the demo):

```html
<!-- Card styles -->
<link rel="stylesheet" href="../styles/catchonika.css" />

<!-- In-page mount -->
<div id="catchonika-card"></div>

<!-- Vendored MidiWriterJS (global `MidiWriter`) -->
<script src="../vendor/midiwriter.js"></script>

<!-- Catchonika -->
<script src="../src/catchonika.js"></script>

<script>
  new window.Catchonika({
    mount: "#catchonika-card", // render as a card inside this element
    mode: "card",
    bufferMinutes: 60,
    defaultBpm: 120,
    groupByChannel: false,
  });
</script>
```

> If you omit `mount`, Catchonika will render as a **floating** widget so recording is still available.

---

## Troubleshooting

- **Web MIDI not working**  
  Use `https://` or `http://localhost` (served files). Most browsers require a secure context for MIDI.
- **No inputs listed**  
  Check your device is connected and recognized by the OS. Re-open the page after connecting.
- **No .mid-download**  
  Confirm the vendored file exists at `vendor/midiwriter.js` and is loaded **before** `src/catchonika.js`.

---

## License

MIT © 2025
