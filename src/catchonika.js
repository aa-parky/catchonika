// Catchonika — default-on MIDI capture and one-click export to .mid
// Card-ready: render neatly inside any container (tabs, panels, etc.)
// v1.1.3 — show take duration and wall-clock start time; preserve global alignment on export

(() => {
    const PPQ = 128;
    const DEFAULT_BPM = 120;

    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
    const ts = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

    function midiNoteToName(n) {
        const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
    }
    function msToTicks(ms, bpm, ppq = PPQ) {
        return Math.max(1, Math.round((ms / 60000) * (bpm * ppq)));
    }

    class Catchonika {
        /**
         * @param {Object} opts
         * @param {HTMLElement|string} [opts.mount] Element or selector to render UI. If omitted, creates a floating widget.
         * @param {"card"|"floating"} [opts.mode="card"] Presentation mode. "card" is ideal for tabs.
         * @param {number} [opts.bufferMinutes=30] Rolling buffer length.
         * @param {number} [opts.defaultBpm=120] Default BPM for export.
         * @param {boolean} [opts.groupByChannel=false] Track per MIDI channel on export.
         * @param {number} [opts.takeIdleSeconds=3] Seconds of inactivity to end an auto-take.
         */
        constructor(opts = {}) {
            this.settings = {
                bufferMinutes: opts.bufferMinutes ?? 30,
                defaultBpm: opts.defaultBpm ?? DEFAULT_BPM,
                groupByChannel: opts.groupByChannel ?? false,
                mode: opts.mode ?? 'card',
                takeIdleSeconds: opts.takeIdleSeconds ?? 3,
            };

            this._mount = typeof opts.mount === 'string' ? document.querySelector(opts.mount) : opts.mount;
            this._midi = null;
            this._inputs = new Map();
            this._start = ts();
            this._startEpoch = Date.now(); // wall-clock epoch for display

            this._events = [];             // {t, type, ch, note, vel, cc, val, inputId, inputName}
            this._active = new Map();      // "ch:note" -> {tOn, vel, inputId}
            this._sustain = new Map();     // ch -> bool
            this._pendingRelease = new Map(); // ch -> Set(keys)

            // Auto-take state
            this._takes = [];              // [{ startMs, endMs }]
            this._currentTake = null;      // { startMs, lastActivityMs }
            this._idleTimer = null;        // inactivity timeout id

            this._renderUI();
            this._attachUIHandlers();
            void this._initMIDI();
            this._gcInterval = setInterval(() => this._gc(), 10_000);
            // Ensure cleanup on the page unloaded and mark destroy as used internally
            this._onBeforeUnload = () => this.destroy();
            window.addEventListener('beforeunload', this._onBeforeUnload);
        }

        destroy() {
            if (this._onBeforeUnload) {
                window.removeEventListener('beforeunload', this._onBeforeUnload);
                this._onBeforeUnload = null;
            }
            if (this._midi) {
                this._midi.onstatechange = null;
                this._inputs.forEach(inp => inp.onmidimessage = null);
                this._midi = null; // ensure GC of MIDI access
            }
            if (this._idleTimer) {
                clearTimeout(this._idleTimer);
                this._idleTimer = null;
            }
            clearInterval(this._gcInterval);
            this._teardownUI();
        }

        // --- MIDI ---------------------------------------------------------------

        async _initMIDI() {
            if (!navigator.requestMIDIAccess) {
                this._status(`Web MIDI not supported in this browser.`);
                return;
            }
            try {
                this._midi = await navigator.requestMIDIAccess({ sysex: false });
                this._midi.onstatechange = () => this._refreshInputs();
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
            const names = [...this._inputs.values()].map(i => i.name).join(', ') || 'none';
            this._status(`Inputs: ${names}`);
        }

        _onMIDIMessage(input, message) {
            const data = message.data;
            if (!data || data.length < 1) return;

            const status = data[0];
            const type = status & 0xF0;
            const ch = (status & 0x0F) + 1;
            const tNow = ts();
            const t = tNow - this._start;
            const inputId = input.id;
            const inputName = input.name || '';

            const sustainDown = (c) => this._sustain.get(c) === true;
            const setSustain = (c, val) => this._sustain.set(c, !!val);
            const pendKeySet = (c) => {
                if (!this._pendingRelease.has(c)) this._pendingRelease.set(c, new Set());
                return this._pendingRelease.get(c);
            };

            // Mark activity for auto-take idle tracking
            this._markActivity(t);

            if (type === 0x90) {
                const note = data[1];
                const vel = data[2] || 0;
                if (vel > 0) {
                    this._events.push({ t, type: 'noteon', ch, note, vel, inputId, inputName });
                    this._active.set(`${ch}:${note}`, { tOn: t, vel, inputId });
                } else {
                    this._handleNoteOff(t, ch, note, inputId, inputName, sustainDown, pendKeySet);
                }
                return;
            }

            if (type === 0x80) {
                this._handleNoteOff(t, ch, data[1], inputId, inputName, sustainDown, pendKeySet);
                return;
            }

            if (type === 0xB0) {
                const cc = data[1];
                const val = data[2] ?? 0;
                this._events.push({ t, type: 'cc', ch, cc, val, inputId, inputName });

                if (cc === 64) {
                    const wasDown = sustainDown(ch);
                    const nowDown = val >= 64;
                    setSustain(ch, nowDown);

                    // Sustain pressed: start a new take if none active
                    if (!wasDown && nowDown) {
                        this._startTake(t);
                    }

                    // Sustain released: flush deferred note-offs
                    if (wasDown && !nowDown) {
                        const keys = pendKeySet(ch);
                        keys.forEach(key => {
                            const active = this._active.get(key);
                            if (active) {
                                this._events.push({ t, type: 'noteoff', ch, note: parseInt(key.split(':')[1], 10), inputId, inputName });
                                this._active.delete(key);
                            }
                        });
                        keys.clear();
                    }
                }
                return;
            }

            if (type === 0xE0) {
                const lsb = data[1] ?? 0;
                const msb = data[2] ?? 0;
                const value = ((msb << 7) | lsb) - 8192;
                this._events.push({ t, type: 'pitchbend', ch, value, inputId, inputName });
                return;
            }

            this._events.push({ t, type: 'raw', bytes: Array.from(data), ch, inputId, inputName });
        }

        _handleNoteOff(t, ch, note, inputId, inputName, sustainDown, pendKeySet) {
            const key = `${ch}:${note}`;
            const active = this._active.get(key);
            if (!active) {
                this._events.push({ t, type: 'noteoff', ch, note, inputId, inputName });
                return;
            }
            if (sustainDown(ch)) {
                pendKeySet(ch).add(key);
                this._events.push({ t, type: 'noteoff_deferred', ch, note, inputId, inputName });
            } else {
                this._events.push({ t, type: 'noteoff', ch, note, inputId, inputName });
                this._active.delete(key);
            }
        }

        // --- Auto-takes ----------------------------------------------------------

        saveTake(index, opts = {}) {
            const take = this._takes?.[index];
            if (!take) {
                this._status(`No take #${index + 1}`);
                return;
            }
            const bpmToUse = Number.isFinite(opts.bpm) ? opts.bpm : (parseFloat(this._bpmInput?.value) || this.settings.defaultBpm);
            return this._saveRange(take.startMs, take.endMs ?? (ts() - this._start), { bpm: bpmToUse, label: `take-${index + 1}`, ...opts });
        }

        _startTake(t) {
            if (this._currentTake) return;
            this._currentTake = { startMs: t, lastActivityMs: t };
            this._resetIdleTimer();
            this._renderTakesList();
            this._status(`Take ${this._takes.length + 1} started`);
        }

        _endTake() {
            if (!this._currentTake) return;
            if (this._idleTimer) {
                clearTimeout(this._idleTimer);
                this._idleTimer = null;
            }
            const endMs = this._currentTake.lastActivityMs ?? (ts() - this._start);
            this._takes.push({ startMs: this._currentTake.startMs, endMs });
            const takeNum = this._takes.length;
            this._currentTake = null;
            this._renderTakesList();
            this._status(`Take ${takeNum} ended`);
        }

        _markActivity(t) {
            if (!this._currentTake) return;
            this._currentTake.lastActivityMs = t;
            this._resetIdleTimer();
        }

        _resetIdleTimer() {
            if (!this._currentTake) return;
            if (this._idleTimer) clearTimeout(this._idleTimer);
            const idleMs = Math.max(500, (this.settings.takeIdleSeconds ?? 3) * 1000);
            this._idleTimer = setTimeout(() => this._endTake(), idleMs);
        }

        _renderTakesList() {
            if (!this._takesListEl) return;

            const rows = [];
            this._takes.forEach((t, i) => {
                const length = t.endMs - t.startMs;
                const startedAtEpoch = this._startEpoch + t.startMs;
                const startedClock = this._fmtClock(startedAtEpoch);
                rows.push(
                    `<div class="catchonika__take" title="Started ${startedClock} • Duration ${Math.max(0, Math.round(length / 1000))}s">
                        <span class="catchonika__take-label">Take ${i + 1}</span>
                        <span class="catchonika__take-time">
                            <span class="catchonika__take-meta">Started: ${startedClock} • Duration: ${Math.max(0, Math.round(length / 1000))} seconds</span>
                        </span>
                        <button class="catchonika__btn catchonika__btn--small" data-action="save-take" data-index="${i}" title="Save this take">Save</button>
                    </div>`
                );
            });
            if (this._currentTake) {
                const i = this._takes.length;
                const t = this._currentTake;
                const now = t.lastActivityMs;
                const length = now - t.startMs;
                const startedAtEpoch = this._startEpoch + t.startMs;
                const startedClock = this._fmtClock(startedAtEpoch);
                rows.push(
                    `<div class="catchonika__take catchonika__take--active" title="Recording… • Started ${startedClock} • Duration ${Math.max(0, Math.round(length / 1000))}s">
                        <span class="catchonika__take-label">Take ${i + 1}</span>
                        <span class="catchonika__take-time">
                            <span class="catchonika__take-meta">Started: ${startedClock} • Duration: ${Math.max(0, Math.round(length / 1000))} seconds</span>
                        </span>
                        <span class="catchonika__take-badge">Recording…</span>
                    </div>`
                );
            }
            this._takesListEl.innerHTML = rows.join('') || `<div class="catchonika__take-empty">No takes yet. Press sustain to start a take.</div>`;
        }

        _fmtClock(epochMs) {
            try {
                return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            } catch {
                return '';
            }
        }

        _saveRange(startMs, endMs, { bpm, label } = {}) {
            const bpmToUse = Number.isFinite(bpm) ? bpm : this.settings.defaultBpm;
            const events = this._events
                .filter(e => e.t >= startMs && e.t <= endMs)
                .sort((a, b) => a.t - b.t);

            const notesByTrack = self._reconstructNotes ? self._reconstructNotes(events, startMs, endMs) : this._reconstructNotes(events, startMs, endMs);
            const writer = this._buildMidi(notesByTrack, bpmToUse);

            const file = writer.buildFile();
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

        _reconstructNotes(events, windowStart, windowEnd) {
            const active = new Map();
            const sustain = new Map();
            const pending = new Map(); // ch -> Set(keys)
            const ensureSet = (m, ch) => {
                if (!m.has(ch)) m.set(ch, new Set());
                return m.get(ch);
            };

            const notes = [];
            const pushNote = (ch, note, tOn, tOff, vel) => {
                const startMs = Math.max(windowStart, Math.min(windowEnd, tOn));
                const endMs = Math.max(windowStart, Math.min(windowEnd, tOff ?? windowEnd));
                if (endMs > startMs) notes.push({ ch, note, startMs, endMs, vel });
            };

            const trackKeyFor = (ch) => (this.settings.groupByChannel ? `ch-${ch}` : `main`);

            for (const e of events) {
                if (e.type === 'cc' && e.cc === 64) {
                    const down = e.val >= 64;
                    const was = sustain.get(e.ch) === true;
                    sustain.set(e.ch, down);
                    if (was && !down) {
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
                    active.set(`${e.ch}:${e.note}`, { tOn: e.t, vel: e.vel });
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
                }
            }
            for (const [key, st] of active.entries()) {
                const [chStr, noteStr] = key.split(':');
                pushNote(parseInt(chStr, 10), parseInt(noteStr, 10), st.tOn, windowEnd, st.vel);
            }

            const byTrack = new Map();
            for (const n of notes) {
                const k = trackKeyFor(n.ch);
                if (!byTrack.has(k)) byTrack.set(k, []);
                byTrack.get(k).push(n);
            }
            for (const arr of byTrack.values()) arr.sort((a, b) => a.startMs - b.startMs);
            return byTrack;
        }

        _buildMidi(notesByTrack, bpm) {
            const MidiWriter = (globalThis.MidiWriter) ? globalThis.MidiWriter : null;
            if (!MidiWriter) {
                throw new Error('MidiWriterJS not found. Load it before Catchonika.');
            }

            const tracks = [];
            // Compute a global earliest note start across all tracks to preserve alignment
            let _t0Global = Infinity;
            for (const [, _notes] of notesByTrack.entries()) {
                if (_notes && _notes.length) {
                    const first = _notes[0].startMs;
                    if (first < _t0Global) _t0Global = first;
                }
            }
            if (!Number.isFinite(_t0Global)) _t0Global = 0;

            for (const [trackKey, notes] of notesByTrack.entries()) {
                const track = new MidiWriter.Track();
                track.setTempo(bpm, 0);
                track.setTimeSignature(4, 4, 24, 8);
                track.addTrackName(`Catchonika ${trackKey}`);

                if (!notes.length) {
                    tracks.push(track);
                    continue;
                }

                // Zero-base against the global earliest start to preserve inter-track alignment
                for (const n of notes) {
                    const startTick = msToTicks(n.startMs - _t0Global, bpm, PPQ);
                    const durTick   = msToTicks(n.endMs - n.startMs, bpm, PPQ);
                    const velocity01_100 = clamp(Math.round((n.vel / 127) * 100), 1, 100);

                    const evt = new MidiWriter.NoteEvent({
                        pitch: [midiNoteToName(n.note)],
                        duration: `T${durTick}`,
                        velocity: velocity01_100,
                        channel: n.ch,
                        tick: startTick,
                    });
                    track.addEvent(evt, undefined);
                }
                tracks.push(track);
            }
            return new MidiWriter.Writer(tracks, {});
        }

        // --- Buffer hygiene ------------------------------------------------------

        _gc() {
            const maxMs = this.settings.bufferMinutes * 60 * 1000;
            const cutoff = (ts() - this._start) - maxMs;
            if (cutoff <= 0) return;
            this._events = this._events.filter(e => e.t >= cutoff);
        }

        clear() {
            this._events.length = 0;
            this._active.clear();
            this._sustain.clear();
            this._pendingRelease.clear();

            // Clear takes and timers
            if (this._idleTimer) {
                clearTimeout(this._idleTimer);
                this._idleTimer = null;
            }
            this._currentTake = null;
            this._takes = [];
            this._renderTakesList();

            this._status('Cleared buffer.');
        }

        // --- UI ------------------------------------------------------------------

        _renderUI() {
            // If no mount provided, we still allow floating mode as a fallback
            const wantsFloating = this.settings.mode === 'floating' || !this._mount;

            if (!this._mount) {
                const el = document.createElement('div');
                el.className = `catchonika ${wantsFloating ? 'catchonika--floating' : 'catchonika--card'}`;
                el.innerHTML = this._uiHTML();
                document.body.appendChild(el);
                this._mount = el;
            } else {
                this._mount.classList.add('catchonika');
                this._mount.classList.add(this.settings.mode === 'card' ? 'catchonika--card' : 'catchonika--floating');
                this._mount.innerHTML = this._uiHTML();
            }

            this._statusEl = this._mount.querySelector('.catchonika__status');
            this._bpmInput = this._mount.querySelector('.catchonika__bpm');
            this._bpmInput.value = String(this.settings.defaultBpm);
            this._idleInput = this._mount.querySelector('.catchonika__idle');
            if (this._idleInput) this._idleInput.value = String(this.settings.takeIdleSeconds);
            this._takesListEl = this._mount.querySelector('.catchonika__takes');
            this._renderTakesList();
        }

        _teardownUI() {
            if (!this._mount) return;
            this._mount.innerHTML = '';
            // Do not remove mount for card mode (caller owns container)
            if (this._mount.classList.contains('catchonika--floating')) {
                this._mount.remove();
            } else {
                this._mount.classList.remove('catchonika', 'catchonika--card', 'catchonika--floating');
            }
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
          <label class="catchonika__idle-wrap" title="Seconds of no MIDI activity to end a take">Idle s
            <input class="catchonika__idle" type="number" min="1" max="30" step="0.5" value="${this.settings.takeIdleSeconds}">
          </label>
        </div>
        <div class="catchonika__row catchonika__row--controls">
          <button class="catchonika__btn catchonika__btn--ghost" data-action="clear" title="Clear buffer">Clear</button>
        </div>
        <div class="catchonika__takes"></div>
        <div class="catchonika__status" aria-live="polite">Starting…</div>
      `;
        }

        _attachUIHandlers() {
            if (!this._mount) return;
            this._mount.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn) return;
                const bpm = parseFloat(this._bpmInput.value) || this.settings.defaultBpm;
                if (btn.dataset.action === 'clear') this.clear();
                if (btn.dataset.action === 'save-take') {
                    const idx = parseInt(btn.dataset.index, 10);
                    if (Number.isInteger(idx)) this.saveTake(idx, { bpm });
                }
            });

            this._mount.addEventListener('change', (e) => {
                if (e.target && e.target.classList.contains('catchonika__idle')) {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v > 0) {
                        this.settings.takeIdleSeconds = v;
                        // If currently recording, reset the timer with the new value
                        if (this._currentTake) this._resetIdleTimer();
                        this._status(`Auto-take idle: ${this.settings.takeIdleSeconds}s`);
                    }
                }
            });
        }

        _status(text) {
            if (this._statusEl) this._statusEl.textContent = text;
        }
    }

    window.Catchonika = Catchonika;
})();