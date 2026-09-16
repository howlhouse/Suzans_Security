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

        // --- EVENT ARCHIVE ---
        // Events auto-archive AUTO_ARCHIVE_DAYS after their date, and admins can
        // also archive one manually at any time (intended for cancellations).
        // Archived events drop out of the guard-facing feed/calendar and the
        // active Events tab, and live on in a dedicated Archive tab instead.
        // Older events simply won't have `archived`/`cancelled` set at all,
        // which is falsy and treated the same as `false` everywhere below -
        // no migration needed for existing data.
        const AUTO_ARCHIVE_DAYS = 2;

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

        // Best-effort background sweep. Wrapped defensively end-to-end: nothing
        // in here should ever be able to break the rest of the app, so any
        // failure (a bad doc, an offline write, whatever) is just logged and
        // skipped rather than thrown.
        let _archiveSweepRunning = false;
        function runAutoArchiveSweep() {
            if (_archiveSweepRunning) return;
            _archiveSweepRunning = true;
            try {
                getDB('events').forEach(e => {
                    try {
                        if (e.archived) return;
                        if (daysSinceEvent(e) >= AUTO_ARCHIVE_DAYS) {
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
            el.style.background = preset.bg;
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
            const ann = getAnnouncement();
            document.getElementById('annText').value = ann.text || '';
            document.getElementById('annExpires').value = ann.expiresAt || '';
            document.getElementById('annEventLink').innerHTML = '<option value="">— No link —</option>' +
                getDB('events').filter(e => !e.archived).sort((a, b) => new Date(a.date) - new Date(b.date))
                    .map(e => `<option value="${e.id}" ${e.id === ann.eventId ? 'selected' : ''}>${e.title} (${e.date})</option>`).join('');
            window._annSelectedColor = ann.colorPreset || 'teal';
            document.getElementById('annColorPicker').innerHTML = ANNOUNCEMENT_PRESETS.map(p =>
                `<div class="color-swatch ${p.id === window._annSelectedColor ? 'selected' : ''}" style="background:${p.bg};" title="${p.label}" onclick="selectAnnColor('${p.id}')"></div>`
            ).join('');
            const toggleBtn = document.getElementById('annToggleBtn');
            toggleBtn.textContent = ann.enabled ? '🔴 Turn Off' : '🟢 Turn On';
            toggleBtn.className = 'btn btn-sm' + (ann.enabled ? ' btn-magenta' : '');
            document.getElementById('annStatusNote').textContent = ann.enabled
                ? ('Live now for everyone.' + (ann.expiresAt ? ' Auto-off at ' + new Date(ann.expiresAt).toLocaleString() + '.' : ' No expiration set - it stays on until you turn it off.'))
                : 'Currently off. Make your changes, hit Save, then Turn On when it\'s ready to show everyone.';
            document.getElementById('annPreviewBtn').textContent = window._annPreviewActive ? '🛑 Stop Preview' : '👁️ Preview';
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

        function archiveEvent(id) {
            const e = getDB('events').find(x => x.id === id);
            if (!e) return;
            if (!confirm(`Archive "${e.title}"?\n\nThis is meant for cancellations - it will move the event to the Archive tab, mark it CANCELLED there, and take it off the active feed/calendar immediately. You can restore it later from the Archive tab if needed.`)) return;
            delete window._eventDrafts[id]; // it's leaving the active list - drop any unsaved draft for it
            if (window._activeEventEditId === id) closeEventEditor(true);
            saveDoc('events', id, { ...e, archived: true, cancelled: true, archivedAt: Date.now(), archiveReason: 'manual' })
                .then(() => logAction('Archived (cancelled) shift posting: ' + e.title))
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
                            🗓️ ${e.date} · ${e.archiveReason === 'manual' ? '🚫 Cancelled' : '📦 Auto-archived'}${e.archivedAt ? ' · ' + new Date(e.archivedAt).toLocaleDateString() : ''}
                        </div>
                        <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
                            <button class="btn btn-sm btn-outline" onclick="restoreEvent('${e.id}')">↩️ Restore</button>
                            <button class="btn btn-sm btn-magenta" onclick="delEv('${e.id}')">Delete Permanently</button>
                        </div>
                    </div>
                </div>
            `).join('') || `<p style="color:var(--text-muted); text-align:center; padding:30px 10px;">No archived events yet. Events auto-archive ${AUTO_ARCHIVE_DAYS} days after their date, or archive one manually from the Events tab for a cancellation.</p>`;
        }

        let isReg = false;
        const currUser = () => window._currentUserProfile;

