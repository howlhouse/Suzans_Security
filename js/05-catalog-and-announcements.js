        // --- 5. CORE LOGIC ---
        const DEFAULT_TAGS = ['SFW', 'NSFW', '18+', 'Bar', 'Club', 'Dungeon', 'Warehouse', 'Residential', 'Commercial', 'Kink', 'Sober', 'WatchDog', 'Themed'];
        function tagToId(name) { return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 't' + Date.now(); }
        function getTagCatalog() { return getDB('tags').map(t => t.name).sort((a, b) => a.localeCompare(b)); }

        // Roles/ranks catalog - same pattern as tags above, but used to gate
        // who is allowed to see/claim specific posted positions.
        const DEFAULT_ROLES = ['Commander', 'Sergeant', 'Lieutenant', 'Private'];
        function roleToId(name) { return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'r' + Date.now(); }
        function getRoleCatalog() { return getDB('roles').map(r => r.name).sort((a, b) => a.localeCompare(b)); }
        const LEGACY_POST_OPTIONS = ['Unassigned', 'Person/Bag Check', 'ID Check', 'Ticket', 'Float', 'Play Guard', 'Dancefloor', 'Bar', 'Parking Lot', 'Other'];

        // Position-based slot tracking. Events created before this feature
        // won't have `positions` defined, so everything here falls back to
        // the old flat `openSlots` counter to stay backward-compatible.
        // Events can carry multiple promoter/client contacts. Older events (and
        // any code path that hasn't been touched yet) may still only have the
        // legacy single `promoterId` field, so this is the one place that
        // reconciles both shapes into an array everything else can rely on.
        function getEventPromoterIds(e) {
            if (Array.isArray(e.promoterIds)) return e.promoterIds;
            return e.promoterId ? [e.promoterId] : [];
        }
        function positionFilled(e, posName) { return (e.guards || []).filter(g => (e.guardPosts || {})[g] === posName).length; }
        function eventOpenSlots(e) {
            if (e.positions && e.positions.length) {
                return e.positions.reduce((sum, p) => sum + Math.max(0, (p.slots || 0) - positionFilled(e, p.name)), 0);
            }
            return e.openSlots || 0;
        }

        // --- EVENT ARCHIVE ("retire") ---
        // Events auto-retire a configurable number of hours after they END
        // (Command Center > System > Auto-Retire Events, stored in
        // settings/autoArchive), and admins can also retire one manually at
        // any time - either as a cancellation or just to tidy it away.
        // Archived events drop out of the guard-facing feed/calendar and the
        // active Events tab, and live on in a dedicated Archive tab instead.
        // Older events simply won't have `archived`/`cancelled` set at all,
        // which is falsy and treated the same as `false` everywhere below -
        // no migration needed for existing data.
        // archiveReason: 'auto' (timed sweep) | 'manual' (cancelled) | 'retired' (manual, not a cancellation)
        const DEFAULT_AUTO_ARCHIVE_HOURS = 24;
        const MAX_AUTO_ARCHIVE_HOURS = 24 * 365;
        function getAutoArchiveHours() {
            const s = getDB('settings').find(x => x.id === 'autoArchive') || {};
            const h = Number(s.hours);
            return Number.isFinite(h) && h >= 0 ? Math.min(h, MAX_AUTO_ARCHIVE_HOURS) : DEFAULT_AUTO_ARCHIVE_HOURS;
        }

        // Compares calendar dates only (ignores time of day) so this behaves
        // predictably regardless of what timezone/hour the sweep happens to
        // run in. Malformed/missing dates never auto-archive (returns -Infinity)
        // rather than risk silently archiving something unexpected.
        function daysSinceEvent(e) {
            const eventDate = new Date(e.date + 'T00:00:00');
            if (isNaN(eventDate.getTime())) return -Infinity;
            const now = new Date();
            const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            return Math.round((startOfToday - eventDate) / 86400000);
        }

        // When the event is over, in ms: its end time on its date (rolling to
        // the next day for an overnight shift), or the end of that date when no
        // end time is set. NaN for a malformed date, which never auto-retires.
        function eventEndMs(e) {
            const day = new Date(e.date + 'T00:00:00');
            if (isNaN(day.getTime())) return NaN;
            const t = /^(\d{1,2}):(\d{2})/.exec(e.endTime || '');
            if (!t) return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
            const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), +t[1], +t[2]);
            const s = /^(\d{1,2}):(\d{2})/.exec(e.startTime || '');
            if (s && (+t[1] * 60 + +t[2]) <= (+s[1] * 60 + +s[2])) end.setDate(end.getDate() + 1);
            return end.getTime();
        }
        function isPastAutoArchive(e, hours) {
            const end = eventEndMs(e);
            return !isNaN(end) && Date.now() >= end + hours * 3600000;
        }

        // Best-effort background sweep. Wrapped defensively end-to-end: nothing
        // in here should ever be able to break the rest of the app, so any
        // failure (a bad doc, an offline write, whatever) is just logged and
        // skipped rather than thrown.
        // Waits for the events listener's first server snapshot (see
        // attachRealtimeListeners): writing before then made the listener's
        // first snapshot a one-document cache view, and the real data arriving
        // right after looked like every other event had just been posted.
        let _archiveSweepRunning = false;
        function runAutoArchiveSweep() {
            if (_archiveSweepRunning || !window._eventsServerSynced) return;
            _archiveSweepRunning = true;
            try {
                const hours = getAutoArchiveHours();
                getDB('events').forEach(e => {
                    try {
                        if (e.archived) return;
                        if (isPastAutoArchive(e, hours)) {
                            saveDoc('events', e.id, { ...e, archived: true, archivedAt: Date.now(), archiveReason: 'auto' })
                                .then(() => logAction('Auto-archived shift posting: ' + e.title))
                                .catch(err => console.error('Auto-archive failed for', e.id, err));
                        }
                    } catch (err) { console.error('Auto-archive check failed for an event:', err); }
                });
            } catch (err) {
                console.error('Auto-archive sweep failed:', err);
            } finally {
                _archiveSweepRunning = false;
            }
        }

        // Command Center > System > Auto-Retire Events
        function renderAutoArchiveControls() {
            const input = document.getElementById('autoArchiveHours');
            if (!input) return;
            const hours = getAutoArchiveHours();
            input.value = hours;
            document.getElementById('autoArchiveNote').textContent =
                `Currently retiring events ${hours} hour${hours === 1 ? '' : 's'} after they end.`;
        }
        function saveAutoArchiveHours() {
            const raw = document.getElementById('autoArchiveHours').value.trim();
            const hours = Number(raw);
            if (raw === '' || !Number.isInteger(hours) || hours < 0 || hours > MAX_AUTO_ARCHIVE_HOURS) {
                alert(`Enter a whole number of hours between 0 and ${MAX_AUTO_ARCHIVE_HOURS}.`);
                return;
            }
            const due = getDB('events').filter(e => !e.archived && isPastAutoArchive(e, hours));
            if (due.length && !confirm(`With ${hours} hour${hours === 1 ? '' : 's'}, ${due.length} event${due.length === 1 ? ' is' : 's are'} already past the cutoff and will be retired right away:\n\n${due.map(e => '• ' + e.title).join('\n')}\n\nContinue?`)) return;
            const next = { id: 'autoArchive', hours, updatedAt: Date.now(), updatedBy: (currUser() || {}).name || '' };
            saveDoc('settings', 'autoArchive', next).then(() => {
                logAction(`Set auto-retire to ${hours} hour${hours === 1 ? '' : 's'} after the event`);
                renderAutoArchiveControls();
                runAutoArchiveSweep();
            }).catch(() => renderAutoArchiveControls());
        }

        /* APP THEME
           A single system setting (settings/theme) picks the look of the whole app
           for everyone; it's applied as <html data-theme="...">, which the theme
           blocks at the bottom of styles.css key off. "default" is the original
           look and has no overrides. The saved choice is cached in localStorage so
           the next load paints in the right theme before any data arrives (see the
           small script in index.html's <head>). An admin's pick on the System tab is
           only a local preview (window._themeDraft) until they press Apply. */
        const APP_THEMES = {
            default: { label: 'Neon Desert', icon: '🌵', blurb: 'The original look: teal and pink neon on black.', swatch: ['#08080c', '#00f5d4', '#ff2a85', '#00ff87'] },
            halloween: { label: 'Halloween', icon: '🎃', blurb: 'Pumpkin orange, witchy purple and slime green, with spooky icons, bats and cobwebs in the background.', swatch: ['#0b0612', '#ff8a1f', '#b266ff', '#9dff2e'], font: 'Creepster' },
            christmas: { label: 'Christmas', icon: '🎄', blurb: 'Evergreen, candy red and gold, with falling snow, twinkling lights and festive icons in the background.', swatch: ['#06100b', '#3ddc84', '#ff4b5c', '#ffd54a'], font: 'Mountains+of+Christmas:wght@700' },
            thanksgiving: { label: 'Thanksgiving', icon: '🦃', blurb: 'Harvest gold, cranberry and sage on warm brown, with drifting autumn leaves, a leaf garland and harvest icons.', swatch: ['#0e0804', '#f5b83d', '#e4506a', '#a6c957'], font: 'Lobster' },
            treasuretrail: { label: 'Treasure Trail', icon: '🗺️', blurb: 'The Nov 21 party flyer: desert-rock orange, stamp sky blue and asparagus green on ink black, with a topographic map, a dashed trail and travel icons.', swatch: ['#120d08', '#f08a1c', '#2aa8ff', '#b5c926'], font: 'Rubik+Dirt' }
        };
        window._themeDraft = null;
        window._themeSchedDirty = false;
        // settings/theme = { theme, startsAt, endsAt } (epoch ms, 0/absent = no limit). The configured theme is only
        // *live* inside that window; before it starts and after it ends everyone sees the default look.
        function getThemeDoc() { return getDB('settings').find(x => x.id === 'theme') || {}; }
        function getConfiguredTheme() { const s = getThemeDoc(); return APP_THEMES[s.theme] ? s.theme : 'default'; }
        function themeWindowState(s, now) {
            if (s.startsAt && now < s.startsAt) return 'scheduled';
            if (s.endsAt && now >= s.endsAt) return 'ended';
            return 'live';
        }
        // The queue: slots { id, theme, startsAt, endsAt } (all required, no overlaps) that override the main theme while their window is open.
        function getThemeQueue() {
            return (getThemeDoc().queue || []).filter(q => q && APP_THEMES[q.theme] && q.theme !== 'default' && q.startsAt && q.endsAt)
                .sort((a, b) => a.startsAt - b.startsAt);
        }
        function activeQueueSlot(now) { return getThemeQueue().find(q => now >= q.startsAt && now < q.endsAt) || null; }
        // The theme everyone actually sees right now: an open queue slot wins, else the main theme if its window is open, else the default.
        function getSavedTheme() {
            const slot = activeQueueSlot(Date.now());
            if (slot) return slot.theme;
            const s = getThemeDoc(), name = getConfiguredTheme();
            return name !== 'default' && themeWindowState(s, Date.now()) === 'live' ? name : 'default';
        }
        function msToLocalInput(ms) { return ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''; }
        function localInputToMs(v) { const t = v ? new Date(v).getTime() : 0; return isNaN(t) ? 0 : t; }
        function fmtThemeTime(ms) { return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
        // Wake up exactly when the window opens or closes (devices left open would otherwise only notice on the next data refresh).
        let _themeTimer = null;
        function scheduleThemeBoundary() {
            clearTimeout(_themeTimer);
            const s = getThemeDoc(), now = Date.now();
            const next = [s.startsAt, s.endsAt, ...getThemeQueue().flatMap(q => [q.startsAt, q.endsAt])].filter(t => t && t > now).sort((a, b) => a - b)[0];
            if (!next) return;
            _themeTimer = setTimeout(() => { syncTheme(); renderThemeControls(); }, Math.min(next - now + 500, 2147483000));
        }
        document.addEventListener('visibilitychange', () => { if (!document.hidden && window._settingsReady) { syncTheme(); renderThemeControls(); } });
        function applyTheme(name) {
            if (!APP_THEMES[name]) name = 'default';
            if (document.documentElement.getAttribute('data-theme') !== name) document.documentElement.setAttribute('data-theme', name);
            // Each theme may load one web font (APP_THEMES[x].font = a Google Fonts family spec).
            // Keep this and the early <head> script in index.html in step.
            const spec = APP_THEMES[name].font;
            const url = spec ? 'https://fonts.googleapis.com/css2?family=' + spec + '&display=swap' : '';
            let link = document.getElementById('themeFontLink');
            if (url) {
                if (!link) {
                    link = document.createElement('link');
                    link.id = 'themeFontLink'; link.rel = 'stylesheet';
                    document.head.appendChild(link);
                }
                if (link.getAttribute('href') !== url) link.setAttribute('href', url);
            } else if (link) link.remove();
        }
        // Called from every data refresh: show the saved theme (or the admin's preview) and cache the saved one.
        // Does nothing until the settings collection has actually loaded, so a slow load can't flip people to default.
        function syncTheme() {
            if (!window._settingsReady) return;
            const s = getThemeDoc();
            try {
                // The configured theme plus its window, so the <head> script can work out the right look before first paint.
                localStorage.setItem('ss_theme', getConfiguredTheme());
                localStorage.setItem('ss_theme_win', (s.startsAt || 0) + ',' + (s.endsAt || 0));
                localStorage.setItem('ss_theme_q', JSON.stringify(getThemeQueue().map(q => [q.theme, q.startsAt, q.endsAt])));
            } catch (err) { /* storage blocked */ }
            applyTheme(window._themeDraft || getSavedTheme());
            scheduleThemeBoundary();
        }
        function renderThemeControls() {
            const box = document.getElementById('themeOptions');
            if (!box) return;
            const doc = getThemeDoc(), configured = getConfiguredTheme(), sel = window._themeDraft || configured;
            const state = configured === 'default' ? 'live' : themeWindowState(doc, Date.now()), live = getSavedTheme(), slot = activeQueueSlot(Date.now());
            const badge = { live: 'Live', scheduled: 'Scheduled', ended: 'Ended' };
            box.innerHTML = Object.keys(APP_THEMES).map(id => {
                const t = APP_THEMES[id];
                const b = id === live ? 'Live' : id === configured && id !== 'default' && state !== 'live' ? badge[state] : '';
                return `<button type="button" class="theme-option ${id === sel ? 'selected' : ''}" onclick="selectThemeOption('${id}')">
                    <span class="theme-swatches">${t.swatch.map(c => `<i style="background:${c}"></i>`).join('')}</span>
                    <span class="theme-option-text"><span><strong>${t.icon} ${t.label}</strong>${b ? `<em>${b}</em>` : ''}</span><small>${t.blurb}</small></span>
                </button>`;
            }).join('');
            // Schedule: only meaningful for a non-default theme. Fields mirror the saved schedule until the admin edits them.
            const schedBox = document.getElementById('themeSchedule');
            schedBox.style.display = sel === 'default' ? 'none' : 'block';
            if (!window._themeSchedDirty) {
                document.getElementById('themeStart').value = sel === configured ? msToLocalInput(doc.startsAt) : '';
                document.getElementById('themeEnd').value = sel === configured ? msToLocalInput(doc.endsAt) : '';
            }
            const previewing = sel !== configured;
            document.getElementById('themeApplyBtn').disabled = !previewing && !window._themeSchedDirty;
            document.getElementById('themeRevertBtn').style.display = previewing || window._themeSchedDirty ? 'inline-block' : 'none';
            let note;
            if (previewing) note = `Previewing ${APP_THEMES[sel].label} on your screen only. Apply it to switch the whole team over.`;
            else if (window._themeSchedDirty) note = 'Schedule changed - apply it to save for everyone.';
            else if (configured === 'default') note = `${APP_THEMES.default.label} is live for everyone.`;
            else {
                const range = (doc.startsAt ? ' from ' + fmtThemeTime(doc.startsAt) : '') + (doc.endsAt ? ' until ' + fmtThemeTime(doc.endsAt) : '');
                if (state === 'live') note = `${APP_THEMES[configured].label} is live for everyone${doc.endsAt ? ', then returns to ' + APP_THEMES.default.label + ' at ' + fmtThemeTime(doc.endsAt) : ' (no end set)'}.`;
                else if (state === 'scheduled') note = `${APP_THEMES[configured].label} is scheduled${range}. Until then everyone sees ${APP_THEMES.default.label}.`;
                else note = `${APP_THEMES[configured].label} ended ${fmtThemeTime(doc.endsAt)}; everyone is back on ${APP_THEMES.default.label}.`;
            }
            if (slot && !previewing && !window._themeSchedDirty) note = `${APP_THEMES[slot.theme].label} is live from the queue until ${fmtThemeTime(slot.endsAt)}. Main setting: ${note}`;
            document.getElementById('themeNote').textContent = note;
            renderThemeQueue();
        }

        // ----- Theme queue UI (System > Theme Queue) -----
        function renderThemeQueue() {
            const list = document.getElementById('themeQueueList');
            if (!list) return;
            const now = Date.now(), q = getThemeQueue();
            list.innerHTML = q.length ? q.map(s => {
                const st = now >= s.endsAt ? 'Ended' : now >= s.startsAt ? 'Live' : 'Upcoming', t = APP_THEMES[s.theme];
                return `<div class="theme-queue-item ${st === 'Ended' ? 'ended' : ''}">
                    <span class="theme-swatches" style="width:30px">${t.swatch.map(col => `<i style="background:${col};height:12px;border-radius:4px"></i>`).join('')}</span>
                    <span class="theme-option-text"><span><strong>${t.icon} ${t.label}</strong><em>${st}</em></span><small>${fmtThemeTime(s.startsAt)} &rarr; ${fmtThemeTime(s.endsAt)}</small></span>
                    <button type="button" class="btn btn-outline btn-sm" onclick="previewQueuedTheme('${jsStr(s.theme)}')" title="Preview on your screen only">👁</button>
                    <button type="button" class="btn btn-outline btn-sm" onclick="removeQueuedTheme('${jsStr(s.id)}')" title="Remove from queue">✕</button>
                </div>`;
            }).join('') : '<p style="color:var(--text-muted); font-size:0.8rem; margin-bottom:10px;">Nothing queued yet.</p>';
            // Theme choice for the next slot: tappable chips (a native dropdown can come up blank on some devices with the dark styling).
            const chips = document.getElementById('themeQueueTheme');
            if (chips) {
                const ids = Object.keys(APP_THEMES).filter(id => id !== 'default');
                if (!ids.includes(window._queuePick)) window._queuePick = ids[0];
                chips.innerHTML = ids.map(id => `<button type="button" class="theme-chip ${id === window._queuePick ? 'selected' : ''}" onclick="pickQueueTheme('${id}')">${APP_THEMES[id].icon} ${APP_THEMES[id].label}</button>`).join('');
            }
        }
        function pickQueueTheme(id) { if (!APP_THEMES[id] || id === 'default') return; window._queuePick = id; renderThemeQueue(); }
        function previewQueuedTheme(theme) { window._themeDraft = theme === getConfiguredTheme() ? null : theme; window._themeSchedDirty = false; syncTheme(); renderThemeControls(); }
        function saveThemeQueue(queue, logText) {
            const doc = getThemeDoc();
            return saveDoc('settings', 'theme', { ...doc, id: 'theme', queue, updatedAt: Date.now(), updatedBy: (currUser() || {}).name || '' }).then(() => {
                logAction(logText); syncTheme(); renderThemeControls();
            }).catch(() => renderThemeControls());
        }
        function addQueuedTheme() {
            const theme = window._queuePick;
            const startsAt = localInputToMs(document.getElementById('themeQueueStart').value);
            const endsAt = localInputToMs(document.getElementById('themeQueueEnd').value);
            if (!APP_THEMES[theme] || theme === 'default') return;
            if (!startsAt || !endsAt) return alert('Pick both a start and an end time for the queued theme.');
            if (endsAt <= startsAt) return alert('The end time has to be after the start time.');
            if (endsAt <= Date.now()) return alert('That window is already over - pick later times.');
            const clash = getThemeQueue().find(s => startsAt < s.endsAt && endsAt > s.startsAt);
            if (clash) return alert(`That overlaps ${APP_THEMES[clash.theme].label} (${fmtThemeTime(clash.startsAt)} to ${fmtThemeTime(clash.endsAt)}). Adjust the times or remove that one first.`);
            const slot = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), theme, startsAt, endsAt };
            saveThemeQueue([...getThemeQueue(), slot], `Queued the ${APP_THEMES[theme].label} theme from ${new Date(startsAt).toLocaleString()} to ${new Date(endsAt).toLocaleString()}`).then(() => {
                document.getElementById('themeQueueStart').value = ''; document.getElementById('themeQueueEnd').value = '';
            });
        }
        function removeQueuedTheme(id) {
            const slot = getThemeQueue().find(s => s.id === id);
            if (!slot || !confirm(`Remove ${APP_THEMES[slot.theme].label} (${fmtThemeTime(slot.startsAt)}) from the queue?`)) return;
            saveThemeQueue(getThemeQueue().filter(s => s.id !== id), `Removed the ${APP_THEMES[slot.theme].label} theme from the queue`);
        }
        function themeScheduleEdited() { window._themeSchedDirty = true; renderThemeControls(); }
        function clearThemeSchedule() {
            document.getElementById('themeStart').value = '';
            document.getElementById('themeEnd').value = '';
            themeScheduleEdited();
        }
        function selectThemeOption(id) {
            if (!APP_THEMES[id]) return;
            window._themeDraft = id === getConfiguredTheme() ? null : id;
            window._themeSchedDirty = false;
            syncTheme();
            renderThemeControls();
        }
        function clearThemePreview() {
            if (!window._themeDraft && !window._themeSchedDirty) return;
            window._themeDraft = null;
            window._themeSchedDirty = false;
            syncTheme();
        }
        function saveTheme() {
            const theme = window._themeDraft || getConfiguredTheme();
            if (!APP_THEMES[theme]) return;
            const startsAt = theme === 'default' ? 0 : localInputToMs(document.getElementById('themeStart').value);
            const endsAt = theme === 'default' ? 0 : localInputToMs(document.getElementById('themeEnd').value);
            if (endsAt && endsAt <= Date.now()) return alert('The end time is already in the past - pick a later end time (or clear it).');
            if (startsAt && endsAt && endsAt <= startsAt) return alert('The end time has to be after the start time.');
            saveDoc('settings', 'theme', { id: 'theme', theme, startsAt, endsAt, queue: getThemeDoc().queue || [], updatedAt: Date.now(), updatedBy: (currUser() || {}).name || '' }).then(() => {
                window._themeDraft = null;
                window._themeSchedDirty = false;
                logAction(`Set the app theme to ${APP_THEMES[theme].label} for everyone` + (startsAt ? ', from ' + new Date(startsAt).toLocaleString() : '') + (endsAt ? ', until ' + new Date(endsAt).toLocaleString() : ''));
                syncTheme();
                renderThemeControls();
            }).catch(() => renderThemeControls());
        }

        /* SYSTEM ANNOUNCEMENT BANNER
           A single doc (announcement/main) drives a banner shown above every
           view for every signed-in user. Admins edit it from Command Center >
           System - text, a color preset, an optional link to an event, and an
           optional auto-off date/time. Preview is local-only: it never touches
           Firestore, it just swaps the same on-screen banner to the admin's
           unsaved draft until they hit Save/Turn On/Stop Preview or leave the
           tab. */
        const ANNOUNCEMENT_PRESETS = [
            { id: 'teal', label: 'Teal', bg: 'linear-gradient(135deg, #00f5d4, #00c4a7)', color: '#08080c' },
            { id: 'saguaro', label: 'Saguaro Green', bg: 'linear-gradient(135deg, #00ff87, #00b35d)', color: '#08080c' },
            { id: 'amber', label: 'Amber', bg: 'linear-gradient(135deg, #ffb347, #d4a017)', color: '#08080c' },
            { id: 'pink', label: 'Pink', bg: 'linear-gradient(135deg, #ff2a85, #d81159)', color: '#fff' },
            { id: 'purple', label: 'Purple', bg: 'linear-gradient(135deg, #7928ca, #4a00e0)', color: '#fff' },
            { id: 'danger', label: 'Red Alert', bg: 'linear-gradient(135deg, #ff3366, #a3002b)', color: '#fff' },
            // Animated styles: the look lives in the .ann-fx-<fx> CSS class (styles.css).
            { id: 'rainbow', fx: 'rainbow', label: '🌈 Rainbow Flow', color: '#fff' },
            { id: 'twinkle', fx: 'twinkle', label: '✨ Twinkle', color: '#fff' },
            { id: 'pulse', fx: 'pulse', label: '💗 Pulse Glow', color: '#fff' },
            { id: 'siren', fx: 'siren', label: '🚨 Siren Sweep', color: '#fff' },
            { id: 'gold', fx: 'gold', label: '🏆 Gold Shimmer', color: '#2a1d00' },
        ];
        function defaultAnnouncement() { return { id: 'main', enabled: false, text: '', colorPreset: 'teal', eventId: '', expiresAt: '' }; }
        function getAnnouncement() { return getDB('announcement')[0] || defaultAnnouncement(); }

        // Renders the ACTUAL live banner (or hides it) for the currently
        // signed-in user, unless a preview is active - preview owns the
        // banner element until it's stopped or the admin leaves the tab.
        function renderAnnouncementBanner() {
            if (window._annPreviewActive) return;
            const ann = getAnnouncement();
            const expired = ann.expiresAt && Date.now() > new Date(ann.expiresAt).getTime();
            if (ann.enabled && ann.text && !expired) renderAnnouncementBannerEl(ann, false);
            else hideAnnouncementBannerEl();
        }
        function renderAnnouncementBannerEl(ann, isPreview) {
            const preset = ANNOUNCEMENT_PRESETS.find(p => p.id === ann.colorPreset) || ANNOUNCEMENT_PRESETS[0];
            const el = document.getElementById('siteAnnouncementBanner');
            el.className = 'site-announcement-banner' + (preset.fx ? ' ann-fx ann-fx-' + preset.fx : '');
            el.style.background = preset.fx ? '' : preset.bg;
            el.style.color = preset.color;
            el.style.display = 'flex';
            document.getElementById('siteAnnouncementText').innerHTML = (isPreview ? '🔍 PREVIEW (not visible to others yet) — ' : '') + (ann.text || '');
            const linkBtn = document.getElementById('siteAnnouncementLinkBtn');
            const evt = ann.eventId ? getDB('events').find(e => e.id === ann.eventId) : null;
            if (evt) {
                linkBtn.style.display = 'inline-block';
                linkBtn.textContent = 'View Event →';
                linkBtn.onclick = () => openEventDetail(evt.id);
            } else {
                linkBtn.style.display = 'none';
                linkBtn.onclick = null;
            }
        }
        function hideAnnouncementBannerEl() { document.getElementById('siteAnnouncementBanner').style.display = 'none'; }

        function renderAdminSystem() {
            try { renderPushForm(); } catch (err) { console.error('Push form render failed:', err); } // first, so nothing below can stop it
            try { renderThemeControls(); } catch (err) { console.error('Theme controls render failed:', err); }
            try { renderAutoArchiveControls(); } catch (err) { console.error('Auto-retire controls render failed:', err); }
            const ann = getAnnouncement();
            document.getElementById('annText').value = ann.text || '';
            document.getElementById('annExpires').value = ann.expiresAt || '';
            document.getElementById('annEventLink').innerHTML = '<option value="">— No link —</option>' +
                getDB('events').filter(e => !e.archived).sort((a, b) => new Date(a.date) - new Date(b.date))
                    .map(e => `<option value="${e.id}" ${e.id === ann.eventId ? 'selected' : ''}>${e.title} (${e.date})</option>`).join('');
            window._annSelectedColor = ann.colorPreset || 'teal';
            const swatch = p => `<div class="color-swatch ${p.fx ? 'ann-fx ann-fx-' + p.fx : ''} ${p.id === window._annSelectedColor ? 'selected' : ''}" style="${p.fx ? '' : 'background:' + p.bg + ';'}" title="${p.label}" onclick="selectAnnColor('${p.id}')"></div>`;
            document.getElementById('annColorPicker').innerHTML = ANNOUNCEMENT_PRESETS.filter(p => !p.fx).map(swatch).join('') +
                '<div style="flex-basis:100%; font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; margin-top:4px;">Animated &mdash; hover/tap to see the name</div>' +
                ANNOUNCEMENT_PRESETS.filter(p => p.fx).map(swatch).join('');
            const toggleBtn = document.getElementById('annToggleBtn');
            toggleBtn.textContent = ann.enabled ? '🔴 Turn Off' : '🟢 Turn On';
            toggleBtn.className = 'btn btn-sm' + (ann.enabled ? ' btn-magenta' : '');
            document.getElementById('annStatusNote').textContent = ann.enabled
                ? ('Live now for everyone.' + (ann.expiresAt ? ' Auto-off at ' + new Date(ann.expiresAt).toLocaleString() + '.' : ' No expiration set - it stays on until you turn it off.'))
                : 'Currently off. Make your changes, hit Save, then Turn On when it\'s ready to show everyone.';
            document.getElementById('annPreviewBtn').textContent = window._annPreviewActive ? '🛑 Stop Preview' : '👁️ Preview';
        }
        // --- ADMIN PUSH NOTIFICATIONS (Command Center > System) ---
        function renderPushForm() {
            const sel = document.getElementById('pushEventLink');
            const keep = sel.value; // re-rendered on live data updates - don't lose the admin's pick
            sel.innerHTML = '<option value="">— No event —</option>' +
                getDB('events').filter(e => !e.archived).sort((a, b) => new Date(a.date) - new Date(b.date))
                    .map(e => `<option value="${e.id}">${escapeHtml(e.title)} (${e.date})</option>`).join('');
            sel.value = keep;
            renderPushList();
        }
        function renderPushList() {
            const now = Date.now();
            const pushes = [...getDB('pushes')].sort((a, b) => (b.sendAt || 0) - (a.sendAt || 0));
            const rows = pushes.map(p => {
                const ev = p.eventId && getDB('events').find(e => e.id === p.eventId);
                const sent = p.sendAt <= now;
                const status = p.cancelled ? '🚫 Cancelled' : (sent ? '✅ Sent' : '⏳ Scheduled');
                return `<div style="background:rgba(12,12,18,0.7); border:1px solid var(--border-glass); border-radius:12px; padding:10px 12px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
                        <div style="min-width:0;">
                            <div style="font-weight:700; font-size:0.9rem;">${escapeHtml(p.title)}</div>
                            <div style="font-size:0.78rem; color:var(--text-muted);">${status} · ${new Date(p.sendAt).toLocaleString()}${ev ? ' · 📌 ' + escapeHtml(ev.title) : ''}</div>
                            ${p.body ? `<div style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">${escapeHtml(p.body)}</div>` : ''}
                        </div>
                        <div style="display:flex; gap:6px; flex-shrink:0;">
                            ${(!sent && !p.cancelled) ? `<button class="btn btn-outline btn-sm" onclick="cancelPush('${p.id}')">Cancel</button>` : ''}
                            <button class="btn btn-outline btn-sm" onclick="deletePush('${p.id}')">🗑️</button>
                        </div>
                    </div>
                </div>`;
            }).join('');
            document.getElementById('pushList').innerHTML = rows || '<p style="color:var(--text-muted); font-size:0.8rem;">No push notifications yet.</p>';
        }
        function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
        function schedulePush() {
            const title = document.getElementById('pushTitle').value.trim();
            const body = document.getElementById('pushBody').value.trim();
            const eventId = document.getElementById('pushEventLink').value || '';
            const when = document.getElementById('pushWhen').value;
            const errEl = document.getElementById('pushErr');
            const showErr = m => { errEl.textContent = m; errEl.style.display = 'block'; };
            if (!title) { showErr('A title is required.'); return; }
            let sendAt = Date.now();
            if (when) {
                sendAt = new Date(when).getTime();
                if (isNaN(sendAt)) { showErr('That date/time is not valid.'); return; }
                if (sendAt < Date.now() - 60 * 1000) { showErr('That time is in the past. Pick a future time, or leave it blank to send now.'); return; }
            }
            errEl.style.display = 'none';
            const push = { id: 'push' + Date.now(), title, body, eventId, sendAt, createdAt: Date.now(), createdBy: currUser()?.name || '', cancelled: false };
            saveDoc('pushes', push.id, push).then(() => {
                logAction(`${when ? 'Scheduled' : 'Sent'} push notification: ${title}`);
                document.getElementById('pushTitle').value = '';
                document.getElementById('pushBody').value = '';
                document.getElementById('pushWhen').value = '';
                document.getElementById('pushEventLink').value = '';
            }).catch(() => {});
        }
        function cancelPush(id) {
            const p = getDB('pushes').find(x => x.id === id);
            if (!p || !confirm('Cancel this scheduled notification?')) return;
            saveDoc('pushes', id, { ...p, cancelled: true }).then(() => logAction('Cancelled push notification: ' + p.title)).catch(() => {});
        }
        function deletePush(id) {
            const p = getDB('pushes').find(x => x.id === id);
            if (!p || !confirm('Remove this notification from the list?')) return;
            deleteDoc('pushes', id).then(() => logAction('Deleted push notification: ' + p.title)).catch(() => {});
        }
        function selectAnnColor(id) {
            window._annSelectedColor = id;
            document.querySelectorAll('#annColorPicker .color-swatch').forEach(el => el.classList.remove('selected'));
            if (window.event && window.event.target) window.event.target.classList.add('selected');
            updateAnnouncementPreview();
        }
        function readAnnDraftFromForm() {
            return {
                text: document.getElementById('annText').value.trim(),
                colorPreset: window._annSelectedColor || 'teal',
                eventId: document.getElementById('annEventLink').value || '',
                expiresAt: document.getElementById('annExpires').value || '',
            };
        }
        function saveAnnouncement() {
            const draft = { ...getAnnouncement(), ...readAnnDraftFromForm() };
            saveDoc('announcement', 'main', draft).then(() => {
                logAction('Updated announcement banner');
                renderAdminSystem();
            });
        }
        function toggleAnnouncementLive() {
            const existing = getAnnouncement();
            const draft = { ...existing, ...readAnnDraftFromForm(), enabled: !existing.enabled };
            if (draft.enabled && !draft.text) { alert('Add some banner text before turning it on.'); return; }
            saveDoc('announcement', 'main', draft).then(() => {
                logAction(draft.enabled ? 'Turned ON the announcement banner' : 'Turned OFF the announcement banner');
                clearAnnouncementPreview();
                renderAdminSystem();
            });
        }
        // Preview shows the CURRENT unsaved form values on the real banner
        // element, purely client-side - nothing here ever reaches Firestore.
        function toggleAnnouncementPreview() {
            window._annPreviewActive = !window._annPreviewActive;
            if (window._annPreviewActive) updateAnnouncementPreview();
            else renderAnnouncementBanner();
            document.getElementById('annPreviewBtn').textContent = window._annPreviewActive ? '🛑 Stop Preview' : '👁️ Preview';
        }
        function updateAnnouncementPreview() {
            if (!window._annPreviewActive) return;
            renderAnnouncementBannerEl({ ...readAnnDraftFromForm() }, true);
        }
        function clearAnnouncementPreview() {
            if (!window._annPreviewActive) return;
            window._annPreviewActive = false;
            const btn = document.getElementById('annPreviewBtn');
            if (btn) btn.textContent = '👁️ Preview';
            renderAnnouncementBanner();
        }

        // Best-effort background sweep (same shape as runAutoArchiveSweep):
        // once the expiration time has passed, flip `enabled` off server-side
        // so it's really off for everyone, not just hidden on clients that
        // happen to still be open and rendering.
        let _annExpirySweepRunning = false;
        function runAnnouncementExpirySweep() {
            if (_annExpirySweepRunning) return;
            _annExpirySweepRunning = true;
            try {
                const ann = getAnnouncement();
                if (ann.enabled && ann.expiresAt && Date.now() > new Date(ann.expiresAt).getTime()) {
                    saveDoc('announcement', 'main', { ...ann, enabled: false })
                        .then(() => logAction('Announcement banner auto-expired'))
                        .catch(err => console.error('Announcement expiry sweep failed:', err));
                }
            } catch (err) {
                console.error('Announcement expiry sweep failed:', err);
            } finally {
                _annExpirySweepRunning = false;
            }
        }

        // Small, self-contained decorative snippet - see the .cancelled-stripe
        // CSS note for why this is safe to splice into any tile image markup.
        function cancelledStripeHTML() {
            try { return '<div class="cancelled-stripe">CANCELLED</div>'; }
            catch (err) { return ''; } // never let a display flourish break a render
        }

        // "Just retire" checkbox next to the Archive / Cancel button in the event
        // editor. Lives on window (not the draft) so it survives the editor
        // re-rendering without ever being saved onto the event itself.
        window._retireOnly = false;
        function setRetireOnly(on, id) {
            window._retireOnly = !!on;
            const btn = document.getElementById('archiveBtn_' + id);
            if (btn) btn.textContent = window._retireOnly ? '📦 Retire' : '🚫 Archive / Cancel';
        }
        function archiveEvent(id) {
            const e = getDB('events').find(x => x.id === id);
            if (!e) return;
            const retireOnly = !!window._retireOnly;
            const msg = retireOnly
                ? `Retire "${e.title}"?\n\nIt will move to the Archive tab and come off the active feed/calendar immediately, but it will NOT be marked as cancelled. You can restore it later from the Archive tab if needed.`
                : `Archive "${e.title}"?\n\nThis is meant for cancellations - it will move the event to the Archive tab, mark it CANCELLED there, and take it off the active feed/calendar immediately. You can restore it later from the Archive tab if needed.\n\n(To retire it without marking it cancelled, tick "Just retire" first.)`;
            if (!confirm(msg)) return;
            delete window._eventDrafts[id]; // it's leaving the active list - drop any unsaved draft for it
            if (window._activeEventEditId === id) closeEventEditor(true);
            saveDoc('events', id, { ...e, archived: true, cancelled: !retireOnly, archivedAt: Date.now(), archiveReason: retireOnly ? 'retired' : 'manual' })
                .then(() => logAction((retireOnly ? 'Retired shift posting: ' : 'Archived (cancelled) shift posting: ') + e.title))
                .catch(err => alert('Could not archive event: ' + err.message));
        }
        // Hides a posting from the guard-facing Events feed and Calendar tab
        // without archiving it - for tentative gigs that aren't confirmed
        // yet. Unlike the draft fields edited via "Save Changes", this saves
        // immediately (same pattern as archiveEvent) since it's a one-tap
        // status flip, not something an admin drafts and reviews.
        function toggleEventVisibility(id) {
            const e = getDB('events').find(x => x.id === id);
            if (!e) return;
            const hidden = !e.hidden;
            saveDoc('events', id, { ...e, hidden }).then(() => {
                logAction(`${hidden ? 'Hid' : 'Unhid'} shift posting from feed: ${e.title}`);
                // Reflect it right away even if this tile has other unsaved
                // edits pending (renderAdminEv skips dirty tiles on its own).
                if (window._eventDrafts[id]) window._eventDrafts[id].hidden = hidden;
                renderTile(id);
            }).catch(err => alert('Could not update visibility: ' + err.message));
        }
        function restoreEvent(id) {
            const e = getDB('events').find(x => x.id === id);
            if (!e) return;
            if (!confirm(`Restore "${e.title}" to the active Events list?`)) return;
            saveDoc('events', id, { ...e, archived: false, cancelled: false, archivedAt: null, archiveReason: null })
                .then(() => logAction('Restored shift posting from archive: ' + e.title))
                .catch(err => alert('Could not restore event: ' + err.message));
        }
        function renderArchive() {
            runAutoArchiveSweep();
            const listEl = document.getElementById('adminArchiveList');
            if (!listEl) return;
            const autoHours = getAutoArchiveHours();
            const note = document.getElementById('archiveAutoNote');
            if (note) note.textContent = `Events auto-retire here ${autoHours} hour${autoHours === 1 ? '' : 's'} after they end (change this under System). You can also retire one manually from its editor in the Events tab - tick "Just retire" to skip marking it cancelled. Archived events no longer show up in the guard-facing feed or calendar.`;
            const evs = getDB('events').filter(e => e.archived).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
            listEl.innerHTML = evs.map(e => `
                <div class="glass-card" style="padding:15px; display:flex; gap:14px; align-items:flex-start;">
                    <div class="event-img-wrap" style="width:110px; flex-shrink:0; border-radius:12px;">
                        <img src="${e.image}" class="event-img" onerror="this.src='https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=700'">
                        ${e.cancelled ? cancelledStripeHTML() : ''}
                    </div>
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:700; color:var(--neon-teal);">${e.title}</div>
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">
                            🗓️ ${e.date} · ${e.archiveReason === 'manual' || (e.cancelled && e.archiveReason !== 'auto') ? '🚫 Cancelled' : e.archiveReason === 'retired' ? '📦 Retired' : '📦 Auto-archived'}${e.archivedAt ? ' · ' + new Date(e.archivedAt).toLocaleDateString() : ''}
                        </div>
                        <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
                            <button class="btn btn-sm btn-outline" onclick="restoreEvent('${e.id}')">↩️ Restore</button>
                            <button class="btn btn-sm btn-magenta" onclick="delEv('${e.id}')">Delete Permanently</button>
                        </div>
                    </div>
                </div>
            `).join('') || `<p style="color:var(--text-muted); text-align:center; padding:30px 10px;">No archived events yet. Events auto-retire ${autoHours} hour${autoHours === 1 ? '' : 's'} after they end, or you can retire one manually from its editor in the Events tab.</p>`;
        }

        let isReg = false;
        const currUser = () => window._currentUserProfile;

