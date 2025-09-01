// Catchonika — default-on MIDI capture and one-click export to .mid
// Starts recording immediately, listens to all MIDI inputs, and can
// save "last N seconds" or the full session. No framework required.
//
// Requires MidiWriterJS in either global scope (via <script>) or as an import.
// Docs: https://github.com/grimmdude/MidiWriterJS (tempo, ticks, NoteEvent, Writer)
// v1.0.0

(() => {
    const PPQ = 128; // MidiWriterJS uses T128 = 1 beat in docs
    const DEFAULT_BPM = 120;

    // --- Utilities -------------------------------------------------------------

    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

    function midiNoteToName(n) {
        const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        const pitch = names[n % 12];
        const octave = Math.floor(n / 12) - 1;
        return `${pitch}${octave}`;
    }

    function msToTicks(ms, bpm, ppq = PPQ) {
        return Math.max(1, Math.round((ms / 60000) * (bpm * ppq)));
    }

    function ts() {
        // High-res monotonic timestamp (ms)
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
    }

    // --- Recorder core ---------------------------------------------------------

    class Catchonika {
        /**
         * @param {Object} opts
         * @param {HTMLElement|string} [opts.mount]  Element or selector to render UI. If omitted, creates a fixed bubble UI.
         * @param {number} [opts.bufferMinutes=30]   Rolling buffer length.
         * @param {number} [opts.defaultBpm=120]     Default BPM when exporting.
         * @param {boolean} [opts.groupByChannel=false] Export 1 track per channel.
         * @param {number} [opts.minSilenceGapMs=0]  (Optional) future use for auto-slicing.
         */
        constructor(opts = {}) {
            this.settings = {
                bufferMinutes: opts.bufferMinutes ?? 30,
                defaultBpm: opts.defaultBpm ?? DEFAULT_BPM,
                groupByChannel: opts.groupByChannel ?? false,
            };

            this._mount = typeof opts.mount === 'string' ? document.querySelector(opts.mount) : opts.mount;
            this._midi = null;
            this._inputs = new Map();
            this._start = ts();

            // Rolling event buffer: {t, type, ch, note, vel, cc, val, inputId, inputName}
            this._events = [];

            // Active notes & sustain state per channel
            this._active = new Map();     // key "ch:note" -> {tOn, vel, inputId}
            this._sustain = new Map();    // ch -> bool
            this._pendingRelease = new Map(); // ch -> Set(keys) released while sustain held

            // Build UI, request MIDI, start
            this._renderUI();
            this._attachUIHandlers();
            this._initMIDI();
            this._gcInterval = setInterval(() => this._gc(), 10_000);
        }

        destroy() {
            if (this._midi) {
                this._midi.onstatechange = null;
                this._inputs.forEach(inp => inp.onmidimessage = null);
            }
            clearInterval(this._gcInterval);
            this._teardownUI();
        }

        // --- MIDI init & handling ------------------------------------------------

        async _initMIDI() {
            if (!navigator.requestMIDIAccess) {
                this._status(`Web MIDI not supported in this browser.`);
                return;
            }
            try {
                this._midi = await navigator.requestMIDIAccess({ sysex: false });
                this._midi.onstatechange = (e) => this._refreshInputs(e);
                this._refreshInputs();
                this._status(`Catchonika: recording…`);
            } catch (err) {
                this._status(`MIDI access failed: ${err?.message ?? err}`);
            }
        }

        _refreshInputs() {
            this._inputs.forEach((_, id) => this._inputs.delete(id));
            for (const input of this._midi.inputs.values()) {
                input.onmidimessage = (msg) => this._onMIDIMessage(input, msg);
                this._inputs.set(input.id, input);
            }
            this._status(`Inputs: ${[...this._inputs.values()].map(i => i.name).join(', ') || 'none'}`);
        }

        _onMIDIMessage(input, message) {
            const data = message.data;
            if (!data || data.length < 1) return;

            const status = data[0];
            const type = status & 0xF0;
            const ch = (status & 0x0F) + 1;
            const tNow = ts(); // stable timestamp
            const t = tNow - this._start;
            const inputId = input.id;
            const inputName = input.name || '';

            // Helpers to track sustain state
            const sustainDown = (c) => this._sustain.get(c) === true;
            const setSustain = (c, val) => this._sustain.set(c, !!val);
            const pendKeySet = (c) => {
                if (!this._pendingRelease.has(c)) this._pendingRelease.set(c, new Set());
                return this._pendingRelease.get(c);
            };

            // NOTE ON
            if (type === 0x90) {
                const note = data[1];
                const vel = data[2] || 0;
                if (vel > 0) {
                    this._events.push({ t, type: 'noteon', ch, note, vel, inputId, inputName });
                    this._active.set(`${ch}:${note}`, { tOn: t, vel, inputId });
                } else {
                    // velocity 0 treated as noteoff
                    this._handleNoteOff(t, ch, data[1], inputId, inputName, sustainDown, pendKeySet);
                }
                return;
            }

            // NOTE OFF
            if (type === 0x80) {
                this._handleNoteOff(t, ch, data[1], inputId, inputName, sustainDown, pendKeySet);
                return;
            }

            // CONTROL CHANGE
            if (type === 0xB0) {
                const cc = data[1];
                const val = data[2] ?? 0;
                this._events.push({ t, type: 'cc', ch, cc, val, inputId, inputName });

                // Sustain pedal (CC 64): >=64 is ON, <64 is OFF.
                if (cc === 64) {
                    const wasDown = sustainDown(ch);
                    const nowDown = val >= 64;
                    setSustain(ch, nowDown);

                    if (wasDown && !nowDown) {
                        // Pedal released: flush pending releases for this channel at time t
                        const keys = pendKeySet(ch);
                        keys.forEach(key => {
                            const active = this._active.get(key);
                            if (active) {
                                // finalize note at pedal release time
                                this._events.push({ t, type: 'noteoff', ch, note: parseInt(key.split(':')[1], 10), inputId, inputName });
                                this._active.delete(key);
                            }
                        });
                        keys.clear();
                    }
                }
                return;
            }

            // PITCH BEND
            if (type === 0xE0) {
                const lsb = data[1] ?? 0;
                const msb = data[2] ?? 0;
                const value = ((msb << 7) | lsb) - 8192; // center = 0
                this._events.push({ t, type: 'pitchbend', ch, value, inputId, inputName });
                return;
            }

            // AFTERTOUCH (channel or poly), program changes, etc. can be captured for future
            this._events.push({ t, type: 'raw', bytes: Array.from(data), ch, inputId, inputName });
        }

        _handleNoteOff(t, ch, note, inputId, inputName, sustainDown, pendKeySet) {
            const key = `${ch}:${note}`;
            const active = this._active.get(key);

            if (!active) {
                // If we never saw noteon (device race), still log the off.
                this._events.push({ t, type: 'noteoff', ch, note, inputId, inputName });
                return;
            }

            if (sustainDown(ch)) {
                // Defer the release until pedal lifts
                pendKeySet(ch).add(key);
                // log the off event for completeness, but keep active until sustain release
                this._events.push({ t, type: 'noteoff_deferred', ch, note, inputId, inputName });
            } else {
                this._events.push({ t, type: 'noteoff', ch, note, inputId, inputName });
                this._active.delete(key);
            }
        }

        // --- Export --------------------------------------------------------------

        /**
         * Save the last N seconds (default 60s) as a .mid file.
         */
        saveLast(seconds = 60, opts = {}) {
            const endMs = ts() - this._start;
            const startMs = Math.max(0, endMs - (seconds * 1000));
            return this._saveRange(startMs, endMs, { label: `last-${seconds}s`, ...opts });
        }

        /**
         * Save the full session as a .mid file.
         */
        saveFull(opts = {}) {
            const endMs = ts() - this._start;
            return this._saveRange(0, endMs, { label: `session`, ...opts });
        }

        _saveRange(startMs, endMs, { bpm, label } = {}) {
            const bpmToUse = Number.isFinite(bpm) ? bpm : this.settings.defaultBpm;
            const events = this._events
                .filter(e => e.t >= startMs && e.t <= endMs)
                .sort((a, b) => a.t - b.t);

            const notesByTrack = this._reconstructNotes(events, startMs, endMs);
            const writer = this._buildMidi(notesByTrack, bpmToUse);

            const file = writer.buildFile(); // Uint8Array (per docs)
            const blob = new Blob([file], { type: 'audio/midi' });
            const url = URL.createObjectURL(blob);

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fname = `catchonika-${label}-${Math.round(bpmToUse)}bpm-${stamp}.mid`;

            const a = document.createElement('a');
            a.href = url;
            a.download = fname;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);

            this._status(`Saved ${fname}`);
            return blob;
        }

        /**
         * Reconstruct sustained/paired note durations from raw event stream.
         * Output map: trackKey -> array of {ch, note, startMs, endMs, vel}
         */
        _reconstructNotes(events, windowStart, windowEnd) {
            const active = new Map();
            const sustain = new Map();
            const pending = new Map(); // ch -> Set(keys)

            const ensureSet = (map, ch) => {
                if (!map.has(ch)) map.set(ch, new Set());
                return map.get(ch);
            };

            const notes = [];

            const pushNote = (ch, note, tOn, tOff, vel) => {
                const startMs = clamp(tOn, windowStart, windowEnd);
                const endMs = clamp(tOff ?? windowEnd, windowStart, windowEnd);
                if (endMs <= startMs) return;
                notes.push({ ch, note, startMs, endMs, vel });
            };

            // Decide track grouping
            const trackKeyFor = (ch /*, inputName*/) => {
                return this.settings.groupByChannel ? `ch-${ch}` : `main`;
            };

            // Walk events in time order
            for (const e of events) {
                if (e.type === 'cc' && e.cc === 64) {
                    const nowDown = e.val >= 64;
                    sustain.set(e.ch, nowDown);
                    if (!nowDown) {
                        // release any pending notes at this moment
                        const keys = ensureSet(pending, e.ch);
                        keys.forEach(key => {
                            const st = active.get(key);
                            if (st) {
                                pushNote(e.ch, parseInt(key.split(':')[1], 10), st.tOn, e.t, st.vel);
                                active.delete(key);
                            }
                        });
                        keys.clear();
                    }
                    continue;
                }

                if (e.type === 'noteon') {
                    active.set(`${e.ch}:${e.note}`, { tOn: e.t, vel: e.vel, inputName: e.inputName });
                    continue;
                }

                if (e.type === 'noteoff' || e.type === 'noteoff_deferred') {
                    const key = `${e.ch}:${e.note}`;
                    const st = active.get(key);
                    if (!st) continue;

                    if (sustain.get(e.ch)) {
                        ensureSet(pending, e.ch).add(key);
                    } else {
                        pushNote(e.ch, e.note, st.tOn, e.t, st.vel);
                        active.delete(key);
                    }
                    continue;
                }
            }

            // Close any still-active or pending notes at window end
            for (const [key, st] of active.entries()) {
                const [chStr, noteStr] = key.split(':');
                pushNote(parseInt(chStr, 10), parseInt(noteStr, 10), st.tOn, windowEnd, st.vel);
            }

            // Group by track key
            const byTrack = new Map();
            for (const n of notes) {
                const key = trackKeyFor(n.ch);
                if (!byTrack.has(key)) byTrack.set(key, []);
                byTrack.get(key).push(n);
            }
            // Sort within tracks by start time
            for (const arr of byTrack.values()) arr.sort((a, b) => a.startMs - b.startMs);
            return byTrack;
        }

        _buildMidi(notesByTrack, bpm) {
            const MidiWriter = (globalThis.MidiWriter) ? globalThis.MidiWriter : null;
            if (!MidiWriter) {
                throw new Error(
                    'MidiWriterJS not found. Load it via <script src="https://unpkg.com/midi-writer-js"></script> before Catchonika.'
                );
            }

            const tracks = [];
            for (const [trackKey, notes] of notesByTrack.entries()) {
                const track = new MidiWriter.Track();
                track.setTempo(bpm);              // per docs: sets BPM
                track.setTimeSignature(4, 4);     // default feel

                // Optional: name tracks
                track.addTrackName(`Catchonika ${trackKey}`);

                for (const n of notes) {
                    const startTick = msToTicks(n.startMs, bpm, PPQ);
                    const durTick   = msToTicks(n.endMs - n.startMs, bpm, PPQ);
                    const velocity01_100 = clamp(Math.round((n.vel / 127) * 100), 1, 100);

                    // Place the note at an absolute tick; NOTE: when 'tick' is supplied, 'wait' is ignored.
                    const evt = new MidiWriter.NoteEvent({
                        pitch: [midiNoteToName(n.note)],
                        duration: `T${durTick}`,
                        velocity: velocity01_100,
                        channel: n.ch,
                        tick: startTick
                    });
                    track.addEvent(evt);
                }
                tracks.push(track);
            }

            return new MidiWriter.Writer(tracks);
        }

        // --- Buffer hygiene ------------------------------------------------------

        _gc() {
            const maxMs = this.settings.bufferMinutes * 60 * 1000;
            const cutoff = (ts() - this._start) - maxMs;
            if (cutoff <= 0) return;
            // Keep events newer than cutoff
            this._events = this._events.filter(e => e.t >= cutoff);
        }

        clear() {
            this._events.length = 0;
            this._active.clear();
            this._sustain.clear();
            this._pendingRelease.clear();
            this._status('Cleared buffer.');
        }

        // --- UI ------------------------------------------------------------------

        _renderUI() {
            // If a mount wasn't provided, create a fixed mini panel bottom-left
            if (!this._mount) {
                const el = document.createElement('div');
                el.className = 'catchonika';
                el.innerHTML = this._uiHTML();
                document.body.appendChild(el);
                this._mount = el;
            } else {
                this._mount.classList.add('catchonika');
                this._mount.innerHTML = this._uiHTML();
            }
            this._rec = this._mount.querySelector('.catchonika__indicator');
            this._statusEl = this._mount.querySelector('.catchonika__status');
            this._btnSave60 = this._mount.querySelector('[data-action="save-60"]');
            this._btnSaveFull = this._mount.querySelector('[data-action="save-full"]');
            this._btnClear = this._mount.querySelector('[data-action="clear"]');
            this._bpmInput = this._mount.querySelector('.catchonika__bpm');
            this._bpmInput.value = String(this.settings.defaultBpm);
        }

        _teardownUI() {
            if (!this._mount) return;
            this._mount.remove();
            this._mount = null;
        }

        _uiHTML() {
            return `
        <div class="catchonika__row">
          <span class="catchonika__indicator" aria-label="recording" title="Catchonika is recording"></span>
          <strong class="catchonika__title">Catchonika</strong>
          <label class="catchonika__bpm-wrap">BPM
            <input class="catchonika__bpm" type="number" min="30" max="300" step="1" value="${this.settings.defaultBpm}">
          </label>
        </div>
        <div class="catchonika__row catchonika__row--controls">
          <button class="catchonika__btn" data-action="save-60" title="Save last 60 seconds">Save 60s</button>
          <button class="catchonika__btn" data-action="save-full" title="Save full session">Save Full</button>
          <button class="catchonika__btn catchonika__btn--ghost" data-action="clear" title="Clear buffer">Clear</button>
        </div>
        <div class="catchonika__status" aria-live="polite">Starting…</div>
      `;
        }

        _attachUIHandlers() {
            if (!this._mount) return;
            this._mount.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn) return;
                const bpm = parseFloat(this._bpmInput.value) || this.settings.defaultBpm;
                if (btn.dataset.action === 'save-60') this.saveLast(60, { bpm });
                if (btn.dataset.action === 'save-full') this.saveFull({ bpm });
                if (btn.dataset.action === 'clear') this.clear();
            });
        }

        _status(text) {
            if (this._statusEl) this._statusEl.textContent = text;
        }
    }

    // Expose globally (UMD-ish)
    window.Catchonika = Catchonika;
})();