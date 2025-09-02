// Catchonika — default-on MIDI capture and one-click export to .mid
// Card-ready: render neatly inside any container (tabs, panels, etc.)
// v1.3.0 — Refactored for Tonika Design System with BEM naming conventions

(() => {
    const PPQ = 128;
    const DEFAULT_BPM = 120;
    const STORAGE_KEY = "catchonika_state_v1";
    const PERSIST_DEBOUNCE_MS = 750;

    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
    const ts = () =>
        typeof performance !== "undefined" && performance.now
            ? performance.now()
            : Date.now();

    function midiNoteToName(n) {
        const names = [
            "C",
            "C#",
            "D",
            "D#",
            "E",
            "F",
            "F#",
            "G",
            "G#",
            "A",
            "A#",
            "B",
        ];
        return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
    }
    function msToTicks(ms, bpm, ppq = PPQ) {
        return Math.max(1, Math.round((ms / 60000) * (bpm * ppq)));
    }

    class Catchonika {
        /**
         * @param {Object} opts
         * @param {HTMLElement|string} [opts.mount]
         * @param {"card"|"floating"} [opts.mode="card"]
         * @param {number} [opts.bufferMinutes=30]
         * @param {number} [opts.defaultBpm=120]
         * @param {boolean} [opts.groupByChannel=false]
         * @param {number} [opts.takeIdleSeconds=3]
         */
        constructor(opts = {}) {
            this.settings = {
                bufferMinutes: opts.bufferMinutes ?? 30,
                defaultBpm: opts.defaultBpm ?? DEFAULT_BPM,
                groupByChannel: opts.groupByChannel ?? false,
                mode: opts.mode ?? "card",
                takeIdleSeconds: opts.takeIdleSeconds ?? 3,
            };

            this._mount =
                typeof opts.mount === "string"
                    ? document.querySelector(opts.mount)
                    : opts.mount;
            this._midi = null;
            this._inputs = new Map();

            // Base timing: align performance.now() to wall clock so restored items line up
            const nowPerf = ts();
            const nowEpoch = Date.now();
            this._startEpoch = nowEpoch; // wall clock epoch for t=0 default
            this._start = nowPerf - (nowEpoch - this._startEpoch);

            this._events = []; // {t, type, ch, note, vel, cc, val, inputId, inputName}
            this._active = new Map(); // "ch:note" -> {tOn, vel, inputId}
            this._sustain = new Map(); // ch -> bool
            this._pendingRelease = new Map(); // ch -> Set(keys)

            // Auto-take state
            this._takes = []; // [{ startMs, endMs }]
            this._currentTake = null; // { startMs, lastActivityMs }
            this._idleTimer = null; // inactivity timeout id

            // Persistence debounce a handle
            this._persistTimer = null;

            // Try to restore the previous state before we render
            this._loadState();

            this._renderUI();
            this._attachUIHandlers();
            void this._initMIDI();
            this._gcInterval = setInterval(() => {
                this._gc();
            }, 10_000);

            // Save on unload so we don't lose the last few seconds
            this._onBeforeUnload = () => {
                try {
                    this._saveState();
                } catch {}
                this.destroy();
            };
            window.addEventListener("beforeunload", this._onBeforeUnload);
        }

        destroy() {
            if (this._onBeforeUnload) {
                window.removeEventListener("beforeunload", this._onBeforeUnload);
                this._onBeforeUnload = null;
            }
            if (this._midi) {
                this._midi.onstatechange = null;
                this._inputs.forEach((inp) => (inp.onmidimessage = null));
                this._midi = null;
            }
            if (this._idleTimer) {
                clearTimeout(this._idleTimer);
                this._idleTimer = null;
            }
            if (this._persistTimer) {
                clearTimeout(this._persistTimer);
                this._persistTimer = null;
            }
            clearInterval(this._gcInterval);
            this._teardownUI();
        }

        // === Persistence =========================================================

        _schedulePersist() {
            if (this._persistTimer) clearTimeout(this._persistTimer);
            this._persistTimer = setTimeout(
                () => this._saveState(),
                PERSIST_DEBOUNCE_MS,
            );
        }

        _saveState() {
            // Convert relative 't' to absolute epoch for storage
            const toAbs = (rel) => this._startEpoch + rel;
            const maxMs = this.settings.bufferMinutes * 60 * 1000;
            const nowRel = ts() - this._start;
            const cutoff = nowRel - maxMs;
            const prunedEvents = this._events.filter(
                (e) => e.t >= Math.max(0, cutoff),
            );

            const state = {
                version: 2,
                baseEpoch: this._startEpoch,
                settings: this.settings,
                events: prunedEvents.map((e) => {
                    const { t, ...rest } = e;
                    return { tAbs: Math.round(toAbs(t)), ...rest };
                }),
                takes: this._takes.map((tk) => ({
                    startAbs: Math.round(toAbs(tk.startMs)),
                    endAbs: tk.endMs != null ? Math.round(toAbs(tk.endMs)) : null,
                })),
                // Do not persist an in-flight take; it's safer to finalize on inactivity
            };
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            } catch (err) {
                // If too large, drop the oldest half of events and try once more
                try {
                    const trimmed = {
                        ...state,
                        events: state.events.slice(Math.floor(state.events.length / 2)),
                    };
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
                } catch {}
            }
        }

        _loadState() {
            let raw = null;
            try {
                raw = localStorage.getItem(STORAGE_KEY);
            } catch {}
            if (!raw) return;

            try {
                const state = JSON.parse(raw);
                if (!state || typeof state !== "object") return;

                const baseEpoch = Number.isFinite(state.baseEpoch)
                    ? state.baseEpoch
                    : Date.now();
                // Re-anchor start/startEpoch so that new events align with restored ones
                const nowPerf = ts();
                const nowEpoch = Date.now();
                this._startEpoch = baseEpoch;
                this._start = nowPerf - (nowEpoch - this._startEpoch);

                // Restore settings (keep constructor overrides)
                if (state.settings && typeof state.settings === "object") {
                    this.settings = { ...this.settings, ...state.settings };
                }

                // Restore events (to relative)
                if (Array.isArray(state.events)) {
                    this._events = state.events.map((e) => ({
                        ...e,
                        t: Math.max(0, (e.tAbs ?? 0) - this._startEpoch),
                    }));
                }

                // Restore takes
                if (Array.isArray(state.takes)) {
                    this._takes = state.takes
                        .map((tk) => ({
                            startMs: Math.max(0, (tk.startAbs ?? 0) - this._startEpoch),
                            endMs:
                                tk.endAbs != null
                                    ? Math.max(0, tk.endAbs - this._startEpoch)
                                    : null,
                        }))
                        .filter((tk) => tk.endMs != null); // ignore any incomplete ones
                }
            } catch {
                // ignore broken state
            }
        }

        _wipeState() {
            try {
                localStorage.removeItem(STORAGE_KEY);
            } catch {}
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
            const names =
                [...this._inputs.values()].map((i) => i.name).join(", ") || "none";
            this._status(`Inputs: ${names}`);
        }

        _onMIDIMessage(input, message) {
            const data = message.data;
            if (!data || data.length < 1) return;

            const status = data[0];
            const type = status & 0xf0;
            const ch = (status & 0x0f) + 1;
            const tNow = ts();
            const t = tNow - this._start;
            const inputId = input.id;
            const inputName = input.name || "";

            const sustainDown = (c) => this._sustain.get(c) === true;
            const setSustain = (c, val) => this._sustain.set(c, !!val);
            const pendKeySet = (c) => {
                if (!this._pendingRelease.has(c))
                    this._pendingRelease.set(c, new Set());
                return this._pendingRelease.get(c);
            };

            // Mark activity for auto-take idle tracking
            this._markActivity(t);

            if (type === 0x90) {
                const note = data[1];
                const vel = data[2] || 0;
                if (vel > 0) {
                    // Auto-start take on the first played note
                    if (!this._currentTake) this._startTake(t);
                    this._events.push({
                        t,
                        type: "noteon",
                        ch,
                        note,
                        vel,
                        inputId,
                        inputName,
                    });
                    this._active.set(`${ch}:${note}`, { tOn: t, vel, inputId });
                    this._schedulePersist();
                } else {
                    this._handleNoteOff(
                        t,
                        ch,
                        note,
                        inputId,
                        inputName,
                        sustainDown,
                        pendKeySet,
                    );
                }
                return;
            }

            if (type === 0x80) {
                this._handleNoteOff(
                    t,
                    ch,
                    data[1],
                    inputId,
                    inputName,
                    sustainDown,
                    pendKeySet,
                );
                return;
            }

            if (type === 0xb0) {
                const cc = data[1];
                const val = data[2] ?? 0;
                // Auto-start take on first meaningful CC (exclude sustain which already starts takes)
                if (!this._currentTake && cc !== 64) this._startTake(t);
                this._events.push({ t, type: "cc", ch, cc, val, inputId, inputName });
                this._schedulePersist();

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
                        keys.forEach((key) => {
                            const active = this._active.get(key);
                            if (active) {
                                this._events.push({
                                    t,
                                    type: "noteoff",
                                    ch,
                                    note: parseInt(key.split(":")[1], 10),
                                    inputId,
                                    inputName,
                                });
                                this._active.delete(key);
                            }
                        });
                        keys.clear();
                        this._schedulePersist();
                    }
                }
                return;
            }

            if (type === 0xe0) {
                if (!this._currentTake) this._startTake(t);
                const lsb = data[1] ?? 0;
                const msb = data[2] ?? 0;
                const value = ((msb << 7) | lsb) - 8192;
                this._events.push({
                    t,
                    type: "pitchbend",
                    ch,
                    value,
                    inputId,
                    inputName,
                });
                this._schedulePersist();
                return;
            }

            this._events.push({
                t,
                type: "raw",
                bytes: Array.from(data),
                ch,
                inputId,
                inputName,
            });
            this._schedulePersist();
        }

        _handleNoteOff(t, ch, note, inputId, inputName, sustainDown, pendKeySet) {
            const key = `${ch}:${note}`;
            const active = this._active.get(key);
            if (!active) {
                this._events.push({ t, type: "noteoff", ch, note, inputId, inputName });
                this._schedulePersist();
                return;
            }
            if (sustainDown(ch)) {
                pendKeySet(ch).add(key);
                this._events.push({
                    t,
                    type: "noteoff_deferred",
                    ch,
                    note,
                    inputId,
                    inputName,
                });
            } else {
                this._events.push({ t, type: "noteoff", ch, note, inputId, inputName });
                this._active.delete(key);
            }
            this._schedulePersist();
        }

        // --- Auto-takes ----------------------------------------------------------

        saveTake(index, opts = {}) {
            const take = this._takes?.[index];
            if (!take) {
                this._status(`No take #${index + 1}`);
                return;
            }
            const bpmToUse = Number.isFinite(opts.bpm)
                ? opts.bpm
                : parseFloat(this._bpmInput?.value) || this.settings.defaultBpm;
            return this._saveRange(take.startMs, take.endMs ?? ts() - this._start, {
                bpm: bpmToUse,
                label: `take-${index + 1}`,
                ...opts,
            });
        }

        _startTake(t) {
            if (this._currentTake) return;
            this._currentTake = { startMs: t, lastActivityMs: t };
            this._resetIdleTimer();
            this._renderTakesList();
            this._schedulePersist();
            this._status(`Take ${this._takes.length + 1} started`);
        }

        _endTake() {
            if (!this._currentTake) return;
            if (this._idleTimer) {
                clearTimeout(this._idleTimer);
                this._idleTimer = null;
            }
            this._takes.push({
                startMs: this._currentTake.startMs,
                endMs: this._currentTake.lastActivityMs,
            });
            this._currentTake = null;
            this._renderTakesList();
            this._schedulePersist();
            this._status(`Take ${this._takes.length} ended`);
        }

        _markActivity(t) {
            if (this._currentTake) {
                this._currentTake.lastActivityMs = t;
                this._resetIdleTimer();
            }
        }

        _resetIdleTimer() {
            if (this._idleTimer) clearTimeout(this._idleTimer);
            this._idleTimer = setTimeout(() => {
                this._endTake();
            }, this.settings.takeIdleSeconds * 1000);
        }

        // --- Takes list rendering ------------------------------------------------

        _renderTakesList() {
            if (!this._takesListEl) return;

            const rows = [];

            // Render completed takes
            for (let i = 0; i < this._takes.length; i++) {
                const take = this._takes[i];
                const startedClock = this._fmtClock(this._startEpoch + take.startMs);
                const length = take.endMs - take.startMs;
                const durationSeconds = Math.max(0, Math.round(length / 1000));

                rows.push(
                    `<div class="catchonika__take">
                        <div class="catchonika__take-meta">
                            <div class="catchonika__chip">
                                <span class="dot"></span>
                                Take ${i + 1}
                            </div>
                            <span class="catchonika__label u-ellipsis">Started: ${startedClock}</span>
                        </div>
                        <div class="catchonika__take-duration">
                            Duration: ${durationSeconds} seconds
                        </div>
                        <div class="catchonika__take-actions">
                            <button class="tonika-btn tonika-btn--primary" data-action="save-take" data-index="${i}" title="Save as MIDI">
                                Save
                            </button>
                        </div>
                    </div>`,
                );
            }

            // Render current take (if recording)
            if (this._currentTake) {
                const startedClock = this._fmtClock(this._startEpoch + this._currentTake.startMs);
                const length = this._currentTake.lastActivityMs - this._currentTake.startMs;
                const durationSeconds = Math.max(0, Math.round(length / 1000));

                rows.push(
                    `<div class="catchonika__take">
                        <div class="catchonika__take-meta">
                            <div class="catchonika__chip">
                                <span class="catchonika__rec-dot"></span>
                                Take ${this._takes.length + 1}
                            </div>
                            <span class="catchonika__label u-ellipsis">Started: ${startedClock}</span>
                        </div>
                        <div class="catchonika__take-duration">
                            Duration: ${durationSeconds} seconds
                        </div>
                        <div class="catchonika__take-actions">
                            <div class="catchonika__badge">Recording…</div>
                        </div>
                    </div>`,
                );
            }

            // Set the content
            if (rows.length === 0) {
                this._takesListEl.innerHTML = `
                    <div class="catchonika__take-empty tonika-text-muted">
                        No takes yet. Press sustain or just play to start a take.
                    </div>`;
            } else {
                this._takesListEl.innerHTML = `<div class="catchonika__take-list">${rows.join("")}</div>`;
            }
        }

        _fmtClock(epochMs) {
            try {
                return new Date(epochMs).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                });
            } catch {
                return "";
            }
        }

        _saveRange(startMs, endMs, { bpm, label } = {}) {
            const bpmToUse = Number.isFinite(bpm) ? bpm : this.settings.defaultBpm;
            const events = this._events
                .filter((e) => e.t >= startMs && e.t <= endMs)
                .sort((a, b) => a.t - b.t);

            const notesByTrack = self._reconstructNotes
                ? self._reconstructNotes(events, startMs, endMs)
                : this._reconstructNotes(events, startMs, endMs);
            const writer = this._buildMidi(notesByTrack, bpmToUse);

            const file = writer.buildFile();
            const blob = new Blob([file], { type: "audio/midi" });
            const url = URL.createObjectURL(blob);

            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const fname = `catchonika-${label}-${Math.round(bpmToUse)}bpm-${stamp}.mid`;

            const a = document.createElement("a");
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
                const endMs = Math.max(
                    windowStart,
                    Math.min(windowEnd, tOff ?? windowEnd),
                );
                if (endMs > startMs) notes.push({ ch, note, startMs, endMs, vel });
            };

            const trackKeyFor = (ch) =>
                this.settings.groupByChannel ? `ch-${ch}` : `main`;

            for (const e of events) {
                if (e.type === "cc" && e.cc === 64) {
                    const down = e.val >= 64;
                    const was = sustain.get(e.ch) === true;
                    sustain.set(e.ch, down);
                    if (was && !down) {
                        const keys = ensureSet(pending, e.ch);
                        keys.forEach((key) => {
                            const st = active.get(key);
                            if (st) {
                                pushNote(
                                    e.ch,
                                    parseInt(key.split(":")[1], 10),
                                    st.tOn,
                                    e.t,
                                    st.vel,
                                );
                                active.delete(key);
                            }
                        });
                        keys.clear();
                    }
                    continue;
                }
                if (e.type === "noteon") {
                    active.set(`${e.ch}:${e.note}`, { tOn: e.t, vel: e.vel });
                    continue;
                }
                if (e.type === "noteoff" || e.type === "noteoff_deferred") {
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
                const [chStr, noteStr] = key.split(":");
                pushNote(
                    parseInt(chStr, 10),
                    parseInt(noteStr, 10),
                    st.tOn,
                    windowEnd,
                    st.vel,
                );
            }

            const byTrack = new Map();
            for (const n of notes) {
                const k = trackKeyFor(n.ch);
                if (!byTrack.has(k)) byTrack.set(k, []);
                byTrack.get(k).push(n);
            }
            for (const arr of byTrack.values())
                arr.sort((a, b) => a.startMs - b.startMs);
            return byTrack;
        }

        _buildMidi(notesByTrack, bpm) {
            const MidiWriter = globalThis.MidiWriter ? globalThis.MidiWriter : null;
            if (!MidiWriter) {
                throw new Error("MidiWriterJS not found. Load it before Catchonika.");
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
                    const durTick = msToTicks(n.endMs - n.startMs, bpm, PPQ);
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
            const cutoff = ts() - this._start - maxMs;
            if (cutoff <= 0) return;
            this._events = this._events.filter((e) => e.t >= cutoff);
            this._schedulePersist();
        }

        clear() {
            this._events.length = 0;
            this._active.clear();
            this._sustain.clear();
            this._pendingRelease.clear();

            if (this._idleTimer) {
                clearTimeout(this._idleTimer);
                this._idleTimer = null;
            }
            this._currentTake = null;
            this._takes = [];
            this._renderTakesList();

            this._wipeState();
            this._status("Cleared buffer.");
        }

        // --- UI ------------------------------------------------------------------

        _renderUI() {
            const wantsFloating = this.settings.mode === "floating" || !this._mount;

            if (!this._mount) {
                const el = document.createElement("div");
                el.className = `tonika-module catchonika ${wantsFloating ? "catchonika--floating" : "catchonika--card"}`;
                el.innerHTML = this._uiHTML();
                document.body.appendChild(el);
                this._mount = el;
            } else {
                this._mount.classList.add("tonika-module", "catchonika");
                this._mount.classList.add(
                    this.settings.mode === "card"
                        ? "catchonika--card"
                        : "catchonika--floating",
                );
                this._mount.innerHTML = this._uiHTML();
            }

            this._statusEl = this._mount.querySelector(".catchonika__status");
            this._bpmInput = this._mount.querySelector(".catchonika__bpm");
            this._bpmInput.value = String(this.settings.defaultBpm);
            this._idleInput = this._mount.querySelector(".catchonika__idle");
            if (this._idleInput)
                this._idleInput.value = String(this.settings.takeIdleSeconds);
            this._takesListEl = this._mount.querySelector(".catchonika__takes");
            this._renderTakesList();
        }

        _teardownUI() {
            if (!this._mount) return;
            this._mount.innerHTML = "";
            if (this._mount.classList.contains("catchonika--floating")) {
                this._mount.remove();
            } else {
                this._mount.classList.remove(
                    "tonika-module",
                    "catchonika",
                    "catchonika--card",
                    "catchonika--floating",
                );
            }
            this._mount = null;
        }

        _uiHTML() {
            return `
                <div class="catchonika__header">
                    <div class="catchonika__controls">
                        <div class="catchonika__rec-dot" aria-label="recording" title="Catchonika is recording"></div>
                        <strong>Catchonika</strong>
                        <span class="tonika-text-muted">BPM</span>
                        <input class="tonika-input catchonika__bpm" type="number" min="30" max="300" step="1" value="${this.settings.defaultBpm}">
                        <span class="tonika-text-muted" title="Seconds of no MIDI activity to end a take">Idle s</span>
                        <input class="tonika-input catchonika__number" type="number" min="1" max="30" step="0.5" value="${this.settings.takeIdleSeconds}">
                    </div>
                    <button class="tonika-btn" data-action="clear" title="Clear buffer">Clear</button>
                </div>
                <div class="catchonika__takes"></div>
                <div class="catchonika__footer">
                    <div class="catchonika__status tonika-text-muted" aria-live="polite">Ready.</div>
                </div>
            `;
        }

        _attachUIHandlers() {
            if (!this._mount) return;
            this._mount.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-action]");
                if (!btn) return;
                const bpm =
                    parseFloat(this._bpmInput.value) || this.settings.defaultBpm;
                if (btn.dataset.action === "clear") this.clear();
                if (btn.dataset.action === "save-take") {
                    const idx = parseInt(btn.dataset.index, 10);
                    if (Number.isInteger(idx)) this.saveTake(idx, { bpm });
                }
            });

            this._mount.addEventListener("change", (e) => {
                if (e.target && e.target.classList.contains("catchonika__number")) {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v > 0) {
                        this.settings.takeIdleSeconds = v;
                        if (this._currentTake) this._resetIdleTimer();
                        this._schedulePersist();
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

