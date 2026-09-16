        /* ADMIN SECURE */
        function promptAdminPin() {
            const u = currUser();
            if (!u || !u.isAdmin) { alert('The admin console is only available to admins.'); return; }
            if (!u.pin) {
                // First-time admin with no personal PIN set yet - let them
                // straight into the console this once, and point them at where
                // to set one so future visits are PIN-gated.
                switchView('adminConsoleView');
                switchAdmin('adminSettings');
                alert("You don't have an Admin PIN set yet. Set one below to secure the console for next time.");
                return;
            }
            const entered = prompt('Enter your Admin PIN:');
            if (entered === null) return;
            if (entered === u.pin) switchView('adminConsoleView');
            else alert('Incorrect PIN.');
        }
        function switchAdmin(t) {
            document.querySelectorAll('.segment-btn').forEach(el => el.classList.remove('active')); event.target.classList.add('active');
            document.querySelectorAll('.admin-pane').forEach(el => el.style.display = 'none'); document.getElementById(t).style.display = 'block';
            if (t !== 'adminSystem') clearAnnouncementPreview(); // leaving the tab always drops any unsaved preview
            if (t === 'adminEvents') renderAdminEv(); if (t === 'adminArchive') renderArchive(); if (t === 'adminChats') renderAdminChats(); if (t === 'adminTags') { renderAdminTags(); renderAdminRoles(); } if (t === 'adminLogs') renderLogs(); if (t === 'adminUsers') renderUsers(); if (t === 'adminContacts') renderContacts(); if (t === 'adminSystem') renderAdminSystem();
        }

        /* ADMIN EVENTS — staged draft + explicit Save button
           FIX for "date field glitches" AND "edits don't save / revert":
           Editing used to write to Firestore on every single keystroke/blur,
           and the admin list re-rendered on every incoming snapshot (including
           the echo of your own edit) — together those two things could yank a
           native date picker out from under you mid-interaction, and any single
           failed micro-write (permission hiccup, offline blip) silently dropped
           just that one field with no feedback.

           Now each event edits a local in-memory DRAFT copy only. Nothing
           reaches Firestore until you click "Save Changes" — which does exactly
           one write for the whole event and shows you a clear ✅ Saved / ❌ Failed
           result right on the button. A draft with unsaved changes is never
           overwritten by incoming live updates (and is never overwritten mid-
           focus either), so you can't lose in-progress edits, and you always
           know for certain whether something saved.

           The Events tab itself only ever shows compact, glanceable tiles
           (title/date/open slots) — a full stack of expanded editors got
           unwieldy fast once there were more than a few postings. Tapping a
           tile opens ONE event at a time in a dedicated editor modal, and
           closing that modal (closeEventEditor) confirms first if the draft
           is dirty, so an accidental tap-away can't silently discard edits. */
        window._activeEventEditId = null; // id of the event currently open in the editor modal, or null
        window._eventDrafts = {}; // id -> working copy being edited, not yet saved
        window._eventDraftStatus = {}; // id -> 'saving' | 'saved' | 'error:<msg>' (transient)

        // Stable (key-order-independent) comparison. Firestore's SDK does not
        // guarantee it returns object keys in the same order they were
        // written, so a plain JSON.stringify comparison could report a tile
        // as "dirty" forever even when its content is actually identical to
        // the server, silently freezing that tile out of all future updates.
        function stableStringify(obj) {
            if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
            if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
            return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
        }
        function isDraftDirty(id) {
            const draft = window._eventDrafts[id];
            const server = getDB('events').find(x => x.id === id);
            if (!draft || !server) return false;
            return stableStringify(draft) !== stableStringify(server);
        }

        // Opens the dedicated editor modal for one event, seeding its draft
        // from the latest server data.
        function openEventEditor(id) {
            const e = getDB('events').find(x => x.id === id);
            if (!e) return;
            window._activeEventEditId = id;
            window._eventDrafts[id] = JSON.parse(JSON.stringify(e));
            renderTile(id);
            document.getElementById('eventEditorModal').style.display = 'flex';
        }
        // Closes the editor modal. If the open draft has unsaved changes,
        // confirms first so a stray tap-away (or the ✕) can't silently
        // discard edits - pass force=true to skip that check (used when the
        // event itself was archived/deleted out from under the editor).
        function closeEventEditor(force) {
            const id = window._activeEventEditId;
            if (!force && id && isDraftDirty(id)) {
                if (!confirm('You have unsaved changes to this event. Discard them and close?')) return;
            }
            if (id) delete window._eventDrafts[id];
            window._activeEventEditId = null;
            document.getElementById('eventEditorModal').style.display = 'none';
        }

        // Builds/updates the editor modal's content from its current draft,
        // unconditionally - but only while that event's editor is actually
        // open, since edits only ever happen on window._activeEventEditId.
        // Meant to be called right after a deliberate user action (toggling a
        // tag, adding a timeline row, a successful save, etc.) where we WANT
        // the editor to visibly update immediately.
        function renderTile(id) {
            if (window._activeEventEditId !== id) return;
            const draft = window._eventDrafts[id];
            if (!draft) return;
            const body = document.getElementById('eventEditorBody');
            if (!body) return;
            body.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:14px;">
                    <h3 style="font-family:'Outfit'; font-size:1.25rem; color:var(--neon-teal); word-break:break-word;">Manage: ${draft.title}
                        ${draft.hidden ? '<span style="display:block; margin-top:6px; color:var(--text-muted); font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; border:1px solid var(--border-glass); border-radius:6px; padding:2px 6px;">Hidden from Feed</span>' : ''}
                    </h3>
                    <button class="btn btn-outline btn-sm" style="border-radius:50%; padding:4px 8px; flex-shrink:0;" onclick="closeEventEditor()">✕</button>
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
                    <button class="btn btn-sm btn-outline" onclick="toggleEventVisibility('${id}')" title="${draft.hidden ? 'Show this posting on the guard-facing Events feed and Calendar' : 'Hide this posting from the guard-facing Events feed and Calendar - use for tentative gigs until confirmed'}">${draft.hidden ? 'Show on Feed' : 'Hide from Feed'}</button>
                    <button class="btn btn-sm btn-outline" style="color:var(--danger-glow); border-color:var(--danger-glow);" onclick="archiveEvent('${id}')" title="For cancellations - moves this to the Archive tab">🚫 Archive / Cancel</button>
                    <button class="btn btn-sm btn-magenta" onclick="delEv('${id}')">Delete Tile</button>
                </div>
                <div id="drag_${id}">
                    ${(draft.layout || []).map(sec => genAdminSec(sec, draft)).join('')}
                </div>
                <div style="display:flex; align-items:center; gap:10px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border-glass);">
                    <button class="btn" onclick="saveEventDraft('${id}')">💾 Save Changes</button>
                    <button class="btn btn-outline btn-sm" onclick="discardEventDraft('${id}')">Discard</button>
                    <span id="saveStatus_${id}" style="font-size:0.8rem; font-weight:600;"></span>
                </div>
            `;
            initDragDrop(`drag_${id}`, id);
        }

        // The Events tab itself just lists compact, glanceable tiles - no
        // inputs or per-tile state live here, so it's safe to fully rebuild
        // on every refresh. Tapping a tile opens the single editor modal
        // above via openEventEditor().
        function renderAdminEv() {
            runAutoArchiveSweep();
            const listEl = document.getElementById('adminEventsList');
            const evs = getDB('events').filter(e => !e.archived).sort((a, b) => new Date(a.date) - new Date(b.date));

            listEl.innerHTML = evs.map(e => {
                const slots = eventOpenSlots(e);
                return `<div class="glass-card event-tile" id="tile_${e.id}" style="padding:13px 15px; display:flex; gap:12px; align-items:center;" onclick="openEventEditor('${e.id}')">
                    <div class="event-img-wrap" style="width:60px; height:60px; flex-shrink:0; border-radius:10px;">
                        <img src="${e.image}" class="event-img" style="height:100%; object-fit:cover;" onerror="this.src='https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=700'">
                    </div>
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:700; color:var(--neon-teal); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                            ${e.title}
                            ${e.hidden ? '<span style="color:var(--text-muted); font-size:0.65rem; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; border:1px solid var(--border-glass); border-radius:6px; padding:1px 6px; margin-left:6px; vertical-align:middle;">Hidden</span>' : ''}
                        </div>
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-top:3px;">🗓️ ${e.date}${e.startTime ? ' · ' + e.startTime : ''} · ${slots} open slot${slots === 1 ? '' : 's'}</div>
                    </div>
                    <span style="color:var(--text-muted); font-size:1.3rem; flex-shrink:0;">›</span>
                </div>`;
            }).join('') || `<p style="color:var(--text-muted); text-align:center; padding:30px 10px;">No shift postings yet. Tap "+ New Shift Posting" above to create one.</p>`;

            // Keep an open editor's roster/status in sync with live data -
            // never clobber it while the admin is mid-edit (a focused field,
            // or unsaved changes), and close it automatically if the event
            // it's editing was archived/deleted from elsewhere in the meantime.
            const activeId = window._activeEventEditId;
            if (activeId) {
                const live = evs.find(e => e.id === activeId);
                if (!live) {
                    closeEventEditor(true);
                } else {
                    syncRosterLive(activeId);
                    const body = document.getElementById('eventEditorBody');
                    if (!(body && body.contains(document.activeElement)) && !isDraftDirty(activeId)) {
                        window._eventDrafts[activeId] = JSON.parse(JSON.stringify(live));
                        renderTile(activeId);
                    }
                }
            }
        }

        function setTileStatus(id, text, color) {
            // Always re-query fresh - never hold onto an element reference
            // across an await/then, since a live update elsewhere can replace
            // that element in the DOM in the meantime, silently orphaning any
            // reference captured earlier (this was why "Saving..." used to
            // get stuck: the "✅ Saved" update was landing on an invisible,
            // detached copy of the status span).
            const el = document.getElementById('saveStatus_' + id);
            if (el) { el.style.color = color; el.innerText = text; }
        }

        function saveEventDraft(id) {
            const draft = window._eventDrafts[id];
            if (!draft) return;
            setTileStatus(id, 'Saving...', 'var(--text-muted)');
            const payload = cleanData(draft);
            withTimeout(db.collection('events').doc(id).set(payload), 15000, 'save to complete')
                // Don't trust Firestore's local optimistic echo as proof of
                // success - it can show a write as "done" in the UI even when
                // it's ultimately never accepted by the server, which was why
                // a "saved" event could vanish again on refresh. Explicitly
                // re-read from the server to confirm it really landed.
                .then(() => withTimeout(db.collection('events').doc(id).get({ source: 'server' }), 15000, 'save confirmation'))
                .then(snap => {
                    if (!snap.exists) throw new Error('Event not found on server after save.');
                    window._eventDrafts[id] = snap.data();
                    setTileStatus(id, '✅ Saved', 'var(--neon-saguaro)');
                    logAction('Updated shift posting: ' + draft.title);
                    renderTile(id); // safe now - draft matches confirmed server data
                })
                .catch(err => {
                    console.error(`Save failed [events/${id}]:`, err);
                    setTileStatus(id, '❌ Failed: ' + err.message, 'var(--danger-glow)');
                    alert('⚠️ Save failed: ' + err.message + '\n\nYour edits are still here in the form — fix the issue and click Save Changes again.');
                });
        }
        function discardEventDraft(id) {
            const server = getDB('events').find(x => x.id === id);
            if (!server) return;
            window._eventDrafts[id] = JSON.parse(JSON.stringify(server));
            renderTile(id);
        }

        function buildRosterRows(eventId, e) {
            return (e.guards || []).map((g, i) => {
                const posOptions = (e.positions && e.positions.length) ? e.positions.map(p => p.name) : LEGACY_POST_OPTIONS.filter(p => p !== 'Unassigned');
                const currentPos = (e.guardPosts && e.guardPosts[g]) || 'Unassigned';
                return `<tr style="border-top:1px solid rgba(255,255,255,0.06);">
                    <td style="padding:6px 4px;">${g}</td>
                    <td style="padding:6px 4px;">
                        <select class="input-field" style="margin:0; padding:6px;" onchange="draftReassignGuard('${eventId}','${jsStr(g)}',this.value)">
                            <option value="Unassigned" ${currentPos === 'Unassigned' ? 'selected' : ''}>Unassigned</option>
                            ${posOptions.map(p => `<option value="${p}" ${currentPos === p ? 'selected' : ''}>${p}</option>`).join('')}
                        </select>
                    </td>
                    <td style="padding:6px 4px;">
                        <input type="text" class="input-field" style="margin:0;" placeholder="Visible to them on event details" value="${((e.guardNotes && e.guardNotes[g]) || '').replace(/"/g, '&quot;')}" onchange="draftSetGuardNote('${eventId}','${jsStr(g)}',this.value)" data-1p-ignore>
                    </td>
                    <td style="padding:6px 4px;"><b style="color:var(--danger-glow);cursor:pointer;" onclick="draftRmGuard('${eventId}',${i})">✕</b></td>
                </tr>`;
            }).join('') || `<tr><td colspan="4" style="padding:10px 4px; color:var(--text-muted);">No one signed up yet.</td></tr>`;
        }

        // Who's signed up for a shift can change from actions OTHER people take
        // (a guard claiming/dropping a shift) at any moment, independent of
        // whatever the admin happens to be editing elsewhere on that same
        // event tile. Previously the whole tile froze from live updates the
        // instant it had any unsaved edit, which meant an admin editing, say,
        // the description wouldn't see a shift get dropped until they hit
        // Save or Discard. This keeps the roster table, add-user dropdown,
        // and per-position fill counts synced from the live server data at
        // all times, regardless of the tile's dirty state - while still never
        // touching a control the admin currently has focused.
        function syncRosterLive(id) {
            const draft = window._eventDrafts[id];
            const server = getDB('events').find(x => x.id === id);
            if (!draft || !server) return;

            draft.guards = JSON.parse(JSON.stringify(server.guards || []));
            draft.guardPosts = JSON.parse(JSON.stringify(server.guardPosts || {}));
            draft.guardNotes = JSON.parse(JSON.stringify(server.guardNotes || {}));

            const tbody = document.getElementById('rosterBody_' + id);
            if (tbody && !tbody.contains(document.activeElement)) {
                tbody.innerHTML = buildRosterRows(id, draft);
            }

            const addSelect = document.getElementById('au_' + id);
            if (addSelect && document.activeElement !== addSelect) {
                const currentVal = addSelect.value;
                const options = getDB('users').filter(u => !(draft.guards || []).includes(u.name));
                addSelect.innerHTML = `<option value="">-- Add existing user --</option>` + options.map(u => `<option value="${u.name.replace(/"/g, '&quot;')}">${u.name}</option>`).join('');
                if (options.some(u => u.name === currentVal)) addSelect.value = currentVal;
            }

            (draft.positions || []).forEach((p, i) => {
                const span = document.getElementById(`posfill_${id}_${i}`);
                if (span) span.innerText = `(${positionFilled(draft, p.name)} filled)`;
            });
        }

        function genAdminSec(sec, e) {
            const linkedPromoterIds = getEventPromoterIds(e);
            const promoterPicker = getDB('promoters').length
                ? `<div class="tags-container" style="margin:6px 0 4px;">${getDB('promoters').map(p => `<span class="neon-tag ${linkedPromoterIds.includes(p.id) ? 'tag-active' : 'tag-inactive'}" style="cursor:pointer;" onclick="draftTogglePromoter('${e.id}','${p.id}')">${linkedPromoterIds.includes(p.id) ? '✓ ' : ''}${p.name}</span>`).join('')}</div>`
                : `<p style="color:var(--text-muted); font-size:0.8rem; margin:6px 0;">No promoter contacts yet — add some under Command Center → Contacts.</p>`;
            if (sec === 'img') return `<div class="draggable-section" draggable="true" data-id="img"><label style="font-size:0.75rem; color:var(--neon-teal); font-family:'Outfit',sans-serif; font-weight:600;">IMG URL & TITLE</label><input class="input-field" value="${e.image}" onchange="draftSet('${e.id}','image',this.value)" data-1p-ignore><input class="input-field" value="${e.title}" onchange="draftSet('${e.id}','title',this.value)" data-1p-ignore></div>`;
            if (sec === 'info') return `<div class="draggable-section" draggable="true" data-id="info"><label style="font-size:0.75rem; color:var(--neon-teal); font-family:'Outfit',sans-serif; font-weight:600;">DATE, TIME, TICKETS, CLIENT & DESC</label><input type="date" class="input-field" value="${e.date}" onchange="draftSet('${e.id}','date',this.value)" data-1p-ignore><div style="display:flex; gap:8px;"><input type="time" class="input-field" style="flex:1;" value="${e.startTime || ''}" onchange="draftSet('${e.id}','startTime',this.value)" data-1p-ignore><input type="time" class="input-field" style="flex:1;" value="${e.endTime || ''}" onchange="draftSet('${e.id}','endTime',this.value)" data-1p-ignore></div><input type="text" class="input-field" placeholder="Ticket URL (Optional)" value="${e.ticketLink || ''}" onchange="draftSet('${e.id}','ticketLink',this.value)" data-1p-ignore><label style="font-size:0.75rem; color:var(--text-muted); font-family:'Outfit',sans-serif; font-weight:600; display:block; margin-top:4px;">Client(s) / Promoter(s) <span style="color:var(--text-muted); font-weight:400; text-transform:none;">(optional, pick as many as apply)</span></label>${promoterPicker}<label style="font-size:0.75rem; color:var(--text-muted); font-family:'Outfit',sans-serif; font-weight:600; display:block; margin-top:8px;">Event Notes:</label><textarea class="input-field" onchange="draftSet('${e.id}','desc',this.value)" data-1p-ignore>${e.desc}</textarea><label style="display:flex; align-items:center; gap:8px; margin:12px 0 2px; cursor:pointer;"><input type="checkbox" ${e.communityOnly ? 'checked' : ''} style="width:auto; margin:0;" onchange="draftSet('${e.id}','communityOnly', this.checked)"><span style="font-size:0.82rem;">📋 Community Listing Only <span style="color:var(--text-muted); font-weight:400;">(not a contracted event)</span></span></label></div>`;
            if (sec === 'tags') return `<div class="draggable-section" draggable="true" data-id="tags"><label style="font-size:0.75rem; color:var(--neon-teal); font-family:'Outfit',sans-serif; font-weight:600;">TAGS</label><div class="tags-container" style="margin-top:8px;">${getTagCatalog().map(t => `<span class="neon-tag ${(e.tags || []).includes(t) ? 'tag-active' : 'tag-inactive'}" style="cursor:pointer;" onclick="draftToggleTag('${e.id}','${t}')">${(e.tags || []).includes(t) ? '✓ ' : ''}${t}</span>`).join('') || '<span style="color:var(--text-muted); font-size:0.8rem;">No tags in the catalog yet.</span>'}</div><p style="font-size:0.72rem; color:var(--text-muted); margin-top:6px;">Need a new tag option? Add or remove them under Command Center → Tags &amp; Roles.</p></div>`;
            if (sec === 'logistics') return `<div class="draggable-section" draggable="true" data-id="logistics">
                <label style="font-size:0.75rem; color:var(--neon-teal); font-family:'Outfit',sans-serif; font-weight:600;">ADDRESS &amp; TIMELINE</label>
                <input class="input-field" placeholder="Venue address (e.g. 123 Main St, Phoenix, AZ)" value="${e.address || ''}" onchange="draftSet('${e.id}','address',this.value)" data-1p-ignore>
                <div id="tl_${e.id}" style="margin-top:6px;">
                    ${(e.timeline || []).map((t, i) => `
                    <div style="display:flex; gap:6px; margin-bottom:6px; align-items:center;">
                        <input type="time" class="input-field" style="margin:0; width:120px;" value="${t.time || ''}" onchange="draftUpdTimeline('${e.id}',${i},'time',this.value)" data-1p-ignore>
                        <input type="text" class="input-field" style="margin:0; flex:1;" placeholder="What happens at this time" value="${(t.label || '').replace(/"/g, '&quot;')}" onchange="draftUpdTimeline('${e.id}',${i},'label',this.value)" data-1p-ignore>
                        <button class="btn btn-sm btn-magenta" onclick="draftRmTimeline('${e.id}',${i})">×</button>
                    </div>`).join('')}
                </div>
                <button class="btn btn-sm btn-outline" onclick="draftAddTimeline('${e.id}')">+ Add Timeline Item</button>
            </div>`;
            if (sec === 'roster') return `<div class="draggable-section" draggable="true" data-id="roster">
                <label style="font-size:0.75rem; color:var(--neon-teal); font-family:'Outfit',sans-serif; font-weight:600;">POSITION TYPES</label>
                <p style="font-size:0.75rem; color:var(--text-muted); margin:2px 0 8px;">Define how many of each position you need. Leave empty to use simple Open Slots below instead.</p>
                <div id="postypes_${e.id}">
                    ${(e.positions || []).map((p, i) => `
                    <div style="margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.05);">
                        <div style="display:flex; gap:6px; align-items:center;">
                            <input type="text" class="input-field" style="margin:0; flex:1;" placeholder="Position name (e.g. Door)" value="${(p.name || '').replace(/"/g, '&quot;')}" onchange="draftUpdPosition('${e.id}',${i},'name',this.value)" data-1p-ignore>
                            <input type="number" min="0" class="input-field" style="margin:0; width:70px;" value="${p.slots || 0}" onchange="draftUpdPosition('${e.id}',${i},'slots',parseInt(this.value)||0)" data-1p-ignore>
                            <span id="posfill_${e.id}_${i}" style="font-size:0.75rem; color:var(--text-muted); white-space:nowrap;">(${positionFilled(e, p.name)} filled)</span>
                            <button class="btn btn-sm btn-magenta" onclick="draftRmPosition('${e.id}',${i})">×</button>
                        </div>
                        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-top:6px;">
                            <span style="font-size:0.68rem; color:var(--text-muted); margin-right:2px;">Restrict to ranks:</span>
                            ${getRoleCatalog().map(r => `<span class="neon-tag ${(p.allowedRoles || []).includes(r) ? 'tag-active' : 'tag-inactive'}" style="cursor:pointer; font-size:0.68rem; padding:3px 8px;" onclick="draftTogglePositionRole('${e.id}',${i},'${jsStr(r)}')">${(p.allowedRoles || []).includes(r) ? '✓ ' : ''}${r}</span>`).join('') || '<span style="color:var(--text-muted); font-size:0.7rem;">No ranks in the catalog - add some under Command Center → Tags &amp; Roles.</span>'}
                            <span style="font-size:0.65rem; color:${(p.allowedRoles || []).length ? 'var(--neon-pink)' : 'var(--text-muted)'}; display:block; width:100%; margin-top:3px;">${(p.allowedRoles || []).length ? 'Only guards holding one of the checked ranks can see or claim this position. Everyone else just sees it as filled/open.' : 'Open to guards of any rank.'}</span>
                        </div>
                    </div>`).join('')}
                </div>
                <button class="btn btn-sm btn-outline" onclick="draftAddPosition('${e.id}')">+ Add Position Type</button>

                <div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border-glass); font-size:0.8rem;">
                    Open Slots (legacy/simple mode - ignored once a position type exists above):
                    <input type="number" class="input-field" style="width:70px; display:inline-block; padding:4px;" value="${e.openSlots || 0}" onchange="draftSet('${e.id}','openSlots',parseInt(this.value)||0);" data-1p-ignore>
                </div>

                <label style="font-size:0.75rem; color:var(--neon-teal); font-family:'Outfit',sans-serif; font-weight:600; display:block; margin-top:14px;">SIGNED-UP TEAM <span style="color:var(--neon-saguaro); font-weight:400; text-transform:none;">(updates live)</span></label>
                <div style="overflow-x:auto; margin-top:6px;">
                    <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
                        <thead><tr style="text-align:left; color:var(--text-muted);"><th style="padding:4px;">Name</th><th style="padding:4px;">Position</th><th style="padding:4px;">Note to them</th><th></th></tr></thead>
                        <tbody id="rosterBody_${e.id}">${buildRosterRows(e.id, e)}</tbody>
                    </table>
                </div>

                <div style="display:flex; gap:5px; margin-top:12px; flex-wrap:wrap;">
                    <select id="au_${e.id}" class="input-field" style="margin:0; flex:1; min-width:150px;">
                        <option value="">-- Add existing user --</option>
                        ${getDB('users').filter(u => !(e.guards || []).includes(u.name)).map(u => `<option value="${u.name.replace(/"/g, '&quot;')}">${u.name}</option>`).join('')}
                    </select>
                    <button class="btn btn-sm" onclick="draftAddExistingGuard('${e.id}')">Add</button>
                </div>
                <div style="display:flex; gap:5px; margin-top:8px;">
                    <input id="mg_${e.id}" class="input-field" placeholder="Or add a manual name (not a system user)" style="margin:0;" data-1p-ignore>
                    <button class="btn btn-sm btn-outline" onclick="draftAddGuard('${e.id}')">Add</button>
                </div>
            </div>`;
            return '';
        }
        function initDragDrop(cid, eid) {
            const cont = document.getElementById(cid);
            if (!cont) return;
            cont.querySelectorAll('.draggable-section').forEach(dr => {
                dr.addEventListener('dragstart', () => dr.classList.add('dragging'));
                dr.addEventListener('dragend', () => { dr.classList.remove('dragging'); draftSet(eid, 'layout', [...cont.children].map(c => c.dataset.id)); });
            });
            cont.addEventListener('dragover', e => {
                e.preventDefault(); const drg = cont.querySelector('.dragging');
                if (!drg) return;
                const aft = [...cont.querySelectorAll('.draggable-section:not(.dragging)')].find(c => e.clientY <= c.getBoundingClientRect().top + c.offsetHeight / 2);
                aft ? cont.insertBefore(drg, aft) : cont.appendChild(drg);
            });
        }

        // --- Draft mutators: these touch ONLY the in-memory draft, never Firestore ---
        function getDraft(id) { return window._eventDrafts[id]; }
        function markDirty(id) { setTileStatus(id, '● Unsaved changes', 'var(--neon-pink)'); }
        function draftSet(id, f, v) { const d = getDraft(id); if (!d) return; d[f] = v; markDirty(id); }
        function draftToggleTag(id, t) {
            const d = getDraft(id); if (!d) return;
            d.tags = d.tags || [];
            d.tags.includes(t) ? d.tags = d.tags.filter(x => x !== t) : d.tags.push(t);
            renderTile(id); markDirty(id);
        }
        function draftTogglePromoter(id, promoterId) {
            const d = getDraft(id); if (!d) return;
            d.promoterIds = getEventPromoterIds(d);
            d.promoterIds = d.promoterIds.includes(promoterId) ? d.promoterIds.filter(x => x !== promoterId) : [...d.promoterIds, promoterId];
            delete d.promoterId; // fully migrated to the array field once edited here
            renderTile(id); markDirty(id);
        }
        function draftAddGuard(id) {
            const d = getDraft(id), input = document.getElementById('mg_' + id), v = input ? input.value.trim() : '';
            if (!d || !v) return;
            d.guards = d.guards || [];
            if (d.guards.includes(v)) { alert(v + ' is already on this shift.'); return; }
            d.guards.push(v);
            d.guardPosts = d.guardPosts || {}; d.guardPosts[v] = 'Unassigned';
            if (!(d.positions && d.positions.length) && d.openSlots > 0) d.openSlots--;
            renderTile(id); markDirty(id);
        }
        function draftAddExistingGuard(id) {
            const d = getDraft(id), sel = document.getElementById('au_' + id), v = sel ? sel.value : '';
            if (!d || !v) return;
            d.guards = d.guards || [];
            if (d.guards.includes(v)) { alert(v + ' is already on this shift.'); return; }
            d.guards.push(v);
            d.guardPosts = d.guardPosts || {}; d.guardPosts[v] = 'Unassigned';
            if (!(d.positions && d.positions.length) && d.openSlots > 0) d.openSlots--;
            renderTile(id); markDirty(id);
        }
        function draftRmGuard(id, i) {
            const d = getDraft(id); if (!d) return;
            const g = d.guards[i]; d.guards.splice(i, 1);
            if (d.guardPosts) delete d.guardPosts[g];
            if (d.guardNotes) delete d.guardNotes[g];
            if (!(d.positions && d.positions.length)) d.openSlots++;
            renderTile(id); markDirty(id);
        }
        function draftReassignGuard(id, guardName, newPosition) {
            const d = getDraft(id); if (!d) return;
            d.guardPosts = d.guardPosts || {};
            d.guardPosts[guardName] = newPosition;
            markDirty(id);
        }
        function draftSetGuardNote(id, guardName, noteText) {
            const d = getDraft(id); if (!d) return;
            d.guardNotes = d.guardNotes || {};
            d.guardNotes[guardName] = noteText;
            markDirty(id);
        }
        function draftAddPosition(id) {
            const d = getDraft(id); if (!d) return;
            d.positions = d.positions || [];
            d.positions.push({ name: 'New Position', slots: 1 });
            renderTile(id); markDirty(id);
        }
        function draftUpdPosition(id, i, field, value) {
            const d = getDraft(id); if (!d || !d.positions || !d.positions[i]) return;
            d.positions[i][field] = value;
            markDirty(id);
        }
        function draftRmPosition(id, i) {
            const d = getDraft(id); if (!d || !d.positions) return;
            d.positions.splice(i, 1);
            renderTile(id); markDirty(id);
        }
        function draftTogglePositionRole(id, i, role) {
            const d = getDraft(id); if (!d || !d.positions || !d.positions[i]) return;
            const p = d.positions[i];
            p.allowedRoles = p.allowedRoles || [];
            p.allowedRoles.includes(role) ? p.allowedRoles = p.allowedRoles.filter(r => r !== role) : p.allowedRoles.push(role);
            renderTile(id); markDirty(id);
        }
        function draftAddTimeline(id) { const d = getDraft(id); if (!d) return; d.timeline = d.timeline || []; d.timeline.push({ time: '18:00', label: 'New item' }); renderTile(id); markDirty(id); }
        function draftUpdTimeline(id, i, f, v) { const d = getDraft(id); if (!d || !d.timeline || !d.timeline[i]) return; d.timeline[i][f] = v; markDirty(id); }
        function draftRmTimeline(id, i) { const d = getDraft(id); if (!d) return; d.timeline.splice(i, 1); renderTile(id); markDirty(id); }

        function openNewEventModal() {
            document.getElementById('neTitle').value = '';
            document.getElementById('neDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('neStartTime').value = '';
            document.getElementById('neEndTime').value = '';
            document.getElementById('neAddress').value = '';
            document.getElementById('neImage').value = '';
            document.getElementById('neDesc').value = '';
            document.getElementById('neSlots').value = 0;
            document.getElementById('neTicket').value = '';
            document.getElementById('newEventErr').style.display = 'none';
            document.getElementById('newEventModal').style.display = 'flex';
        }
        function createNewEvent() {
            const title = document.getElementById('neTitle').value.trim();
            const date = document.getElementById('neDate').value;
            const errEl = document.getElementById('newEventErr');
            const showErr = msg => { errEl.innerText = msg; errEl.style.display = 'block'; };

            if (!title) { showErr('Event title is required.'); return; }
            if (!date) { showErr('Event date is required.'); return; }
            errEl.style.display = 'none';

            const newEv = {
                id: 'e' + Date.now(), title, date,
                tags: [],
                desc: document.getElementById('neDesc').value.trim(),
                address: document.getElementById('neAddress').value.trim(),
                startTime: document.getElementById('neStartTime').value,
                endTime: document.getElementById('neEndTime').value,
                timeline: [],
                openSlots: parseInt(document.getElementById('neSlots').value, 10) || 0,
                guards: [], guardPosts: {}, guardNotes: {}, positions: [], promoterIds: [], communityOnly: false,
                image: document.getElementById('neImage').value.trim() || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=700',
                layout: ['img', 'info', 'tags', 'logistics', 'roster'],
                ticketLink: document.getElementById('neTicket').value.trim(),
                archived: false, cancelled: false, archivedAt: null, archiveReason: null,
                hidden: false
            };

            const btn = document.getElementById('neCreateBtn');
            btn.disabled = true;
            btn.innerText = 'Creating...';
            saveDoc('events', newEv.id, newEv).then(() => {
                logAction('Created shift posting: ' + title);
                closeModal('newEventModal');
                // Newly created events land in ss_state via the live listener; give it a beat,
                // then scroll the admin straight to the new tile so it's not lost among
                // whatever else is already in the list.
                setTimeout(() => {
                    renderAdminEv();
                    const tile = document.getElementById('tile_' + newEv.id);
                    if (tile) tile.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 300);
            }).catch(err => {
                showErr('Failed to create event: ' + err.message);
            }).finally(() => {
                btn.disabled = false;
                btn.innerText = 'Create Shift Posting';
            });
        }
        function delEv(id) {
            if (confirm('Delete this shift posting permanently? This cannot be undone.')) {
                delete window._eventDrafts[id];
                if (window._activeEventEditId === id) closeEventEditor(true);
                deleteDoc('events', id);
            }
        }

