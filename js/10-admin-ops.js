        /* ADMIN CHAT */
        function renderAdminChats() {
            const ch = getDB('channels'), msgs = getDB('chats').sort((a, b) => b.id.localeCompare(a.id));
            document.getElementById('adminChanList').innerHTML = ch.map(c => `<div class="glass-card" style="display:flex;justify-content:space-between;padding:10px;margin-bottom:8px;"><span># ${c}</span><div><button class="btn btn-sm btn-magenta" onclick="delChan('${c}')">Delete Channel</button> <button class="btn btn-sm btn-outline" onclick="clrChan('${c}')">Clear History</button></div></div>`).join('');
            document.getElementById('adminMsgList').innerHTML = msgs.map(m => `<div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.05);padding:8px;font-size:0.85rem;"><span style="color:var(--neon-teal);">[#${m.channel}] ${m.user}: ${m.text}</span><button class="btn btn-sm btn-outline" style="color:var(--danger-glow); border:none;" onclick="delMsg('${m.id}')">Delete Message</button></div>`).join('');
            document.getElementById('adminAttachList').innerHTML = msgs.filter(m => m.file).map(m => `<div style="margin-bottom:6px;"><a href="${m.file}" style="color:var(--neon-teal); font-size:0.85rem; font-weight:600;">📎 Attachment in #${m.channel}</a></div>`).join('');
        }
        function addChannel() { let v = document.getElementById('newChanInput').value.toLowerCase().replace(/\s+/g, '-'); if (v) saveDoc('channels', v, { name: v }); }
        function delChan(c) { if (confirm('Delete channel #' + c + ' and all its history?')) { deleteDoc('channels', c); clrChan(c); } }
        function clrChan(c) { db.collection('chats').where('channel', '==', c).get().then(s => { let b = db.batch(); s.forEach(d => b.delete(d.ref)); return b.commit(); }).catch(err => alert('Clear failed: ' + err.message)); }
        function delMsg(id) { deleteDoc('chats', id); }

        /* TAG CATALOG - available options for every event's tag picker */
        function renderAdminTags() {
            const tags = getDB('tags').slice().sort((a, b) => a.name.localeCompare(b.name));
            document.getElementById('adminTagsList').innerHTML = tags.map(t => `
                <span class="neon-tag tag-active">${t.name} <b style="color:var(--danger-glow);cursor:pointer;margin-left:4px;" onclick="delCatalogTag('${t.id}','${jsStr(t.name)}')">×</b></span>
            `).join('') || '<span style="color:var(--text-muted); font-size:0.85rem;">No tags yet - add one above.</span>';
        }
        function addCatalogTag() {
            const input = document.getElementById('newTagInput');
            const name = input.value.trim();
            if (!name) return;
            const id = tagToId(name);
            if (getDB('tags').some(t => t.id === id)) { alert('That tag already exists.'); return; }
            saveDoc('tags', id, { id, name }).then(() => {
                logAction('Added tag to catalog: ' + name);
                input.value = '';
            });
        }
        function delCatalogTag(id, name) {
            if (confirm(`Remove "${name}" from the tag catalog? It will no longer be selectable on events, but any event that already has it keeps it until edited.`)) {
                deleteDoc('tags', id).then(() => logAction('Removed tag from catalog: ' + name));
            }
        }

        /* ROLE / RANK MANAGER - shares the adminTags pane with the tag catalog above */
        function renderAdminRoles() {
            const roles = getDB('roles').slice().sort((a, b) => a.name.localeCompare(b.name));
            document.getElementById('adminRolesList').innerHTML = roles.map(r => `
                <span class="neon-tag tag-active">${r.name} <b style="color:var(--neon-teal);cursor:pointer;margin-left:6px;" title="Rename" onclick="editCatalogRole('${r.id}','${jsStr(r.name)}')">✎</b><b style="color:var(--danger-glow);cursor:pointer;margin-left:4px;" title="Delete" onclick="delCatalogRole('${r.id}','${jsStr(r.name)}')">×</b></span>
            `).join('') || '<span style="color:var(--text-muted); font-size:0.85rem;">No ranks yet - add one above.</span>';
        }
        function addCatalogRole() {
            const input = document.getElementById('newRoleInput');
            const name = input.value.trim();
            if (!name) return;
            const id = roleToId(name);
            if (getDB('roles').some(r => r.id === id)) { alert('That rank already exists.'); return; }
            saveDoc('roles', id, { id, name }).then(() => {
                logAction('Added rank to catalog: ' + name);
                input.value = '';
            });
        }
        function editCatalogRole(id, oldName) {
            const newName = prompt('Rename rank:', oldName);
            if (newName === null) return;
            const trimmed = newName.trim();
            if (!trimmed || trimmed === oldName) return;
            saveDoc('roles', id, { id, name: trimmed }).then(() => {
                logAction(`Renamed rank "${oldName}" to "${trimmed}"`);
                alert(`Renamed. Note: this won't automatically update "${oldName}" already saved on users or on position rank restrictions - re-select the new name on those individually if needed.`);
            });
        }
        function delCatalogRole(id, name) {
            if (confirm(`Remove "${name}" from the rank catalog? Users and position restrictions that already reference it keep the name until edited.`)) {
                deleteDoc('roles', id).then(() => logAction('Removed rank from catalog: ' + name));
            }
        }

        /* LOGS, USERS, CONTACTS */
        // --- ACTIVITY LOGS & ADOPTION DASHBOARD ---
        // Logs are fetched on demand (never held in ss_state - see js/03). The date range
        // is a server-side range query on the log document id (which starts with the
        // timestamp); user/type/search filters then run in the browser on what was fetched.
        const ACT_FETCH_CAP = 3000; // max log docs read per load (each doc read counts toward Firestore's daily quota)
        const ACT_PAGE = 150;
        const LEGACY_LOGS_BEFORE_TS = 1791504426000; // when activity tracking shipped; older logs have no `ts` field
        let actData = { logs: [], presence: {}, capped: false, loadedAt: 0, shown: ACT_PAGE, rangeDays: 7 };
        const ACT_GROUPS = {
            sessions: ['session_start', 'session_resume', 'login', 'logout', 'push_open', 'terms_accepted'],
            nav: ['view', 'tutorial_started', 'tutorial_completed', 'tutorial_skipped'],
            shifts: ['event_view', 'open_shifts_shown', 'shift_ack', 'shift_claim', 'shift_drop'],
            chat: ['chat_send', 'feedback_submitted'],
            admin: ['action', 'register']
        };
        const ACT_TYPE_LABELS = {
            session_start: ['📱', 'Opened', 'var(--neon-teal)'], session_resume: ['🔄', 'Returned', 'var(--neon-teal)'],
            login: ['🔑', 'Signed in', 'var(--neon-teal)'], logout: ['🚪', 'Signed out', 'var(--text-muted)'],
            push_open: ['🔔', 'From notification', 'var(--neon-teal)'], view: ['👀', 'Viewed', 'var(--text-secondary)'],
            event_view: ['📅', 'Shift viewed', '#7fd4ff'], open_shifts_shown: ['📣', 'Open shifts shown', '#ffb020'],
            shift_ack: ['👍', 'Read open shifts', 'var(--neon-saguaro)'], shift_claim: ['✅', 'Claimed', 'var(--neon-saguaro)'],
            shift_drop: ['❌', 'Dropped', 'var(--danger-glow)'], chat_send: ['💬', 'Chat', 'var(--text-secondary)'],
            register: ['🆕', 'Registered', 'var(--neon-pink)'], feedback_submitted: ['💬', 'Feedback', '#7fd4ff'], tutorial_started: ['🧭', 'Tutorial', 'var(--text-secondary)'], tutorial_completed: ['🎓', 'Tutorial done', 'var(--neon-saguaro)'], tutorial_skipped: ['⏭️', 'Tutorial skipped', 'var(--text-muted)'], terms_accepted: ['📜', 'Accepted terms', 'var(--neon-saguaro)'], action: ['⚙️', 'Action', 'var(--text-secondary)']
        };
        const ACT_SESSION_TYPES = ['session_start', 'session_resume'];

        // Old logs (before this feature) have no ts/type/uid; their id is "l<timestamp>".
        function normalizeLog(l) {
            const ts = l.ts || Number(String(l.id || '').slice(1, 14)) || 0;
            return { ...l, ts, type: l.type || 'action', day: l.day || (ts ? dayKey(new Date(ts)) : '') };
        }
        function actUserKey(l) { return l.uid || ('name:' + (l.user || '')); }
        function actWhen(ts) { return ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
        function actAgo(ts) {
            if (!ts) return 'Never';
            const m = Math.floor((Date.now() - ts) / 60000);
            if (m < 2) return 'Just now';
            if (m < 60) return m + ' min ago';
            const h = Math.floor(m / 60);
            if (h < 24) return h + ' hr ago';
            const d = Math.floor(h / 24);
            return d + (d === 1 ? ' day ago' : ' days ago');
        }

        let actLoading = false;
        async function loadActivityLogs() {
            if (actLoading) return;
            actLoading = true;
            const status = document.getElementById('actStatus');
            const rangeDays = Number(document.getElementById('actRange').value) || 7;
            const now = Date.now(), start = now - rangeDays * 86400000;
            status.textContent = 'Loading…';
            try {
                // New-format logs: sorted/ranged on the `ts` field (Firestore indexes single fields
                // automatically, so no custom index is needed). Logs written before activity
                // tracking existed have no `ts`, so they're fetched separately by document id
                // (ascending order, also index-free) and only if the range reaches that far back.
                const idPath = firebase.firestore.FieldPath.documentId();
                const queries = [
                    db.collection('logs').where('ts', '>=', start).where('ts', '<=', now).orderBy('ts', 'desc').limit(ACT_FETCH_CAP).get({ source: 'server' }),
                    db.collection('presence').get({ source: 'server' })
                ];
                if (start < LEGACY_LOGS_BEFORE_TS) {
                    queries.push(db.collection('logs').where(idPath, '>=', 'l' + start).where(idPath, '<=', 'l' + Math.min(now, LEGACY_LOGS_BEFORE_TS) + '\uf8ff').orderBy(idPath).limit(500).get({ source: 'server' }));
                }
                const [logSnap, presSnap, legacySnap] = await Promise.all(queries);
                const presence = {};
                presSnap.docs.forEach(d => { presence[d.id] = d.data(); });
                const legacy = legacySnap ? legacySnap.docs.map(d => d.data()).filter(l => !l.ts) : [];
                const all = logSnap.docs.map(d => d.data()).concat(legacy).map(normalizeLog).sort((a, b) => b.ts - a.ts);
                actData = { logs: all, presence, capped: logSnap.size >= ACT_FETCH_CAP, loadedAt: now, shown: ACT_PAGE, rangeDays };
                actData.statusBase = `Loaded ${actData.logs.length.toLocaleString()} events from the last ${rangeDays === 1 ? '24 hours' : rangeDays + ' days'}.` +
                    (actData.capped ? ` Showing only the newest ${ACT_FETCH_CAP.toLocaleString()} - choose a shorter range to see everything.` : '') +
                    ' Each load reads these from Firestore, so refresh when you need it rather than constantly.';
                status.textContent = actData.statusBase + devHiddenNote();
                renderLogs(true);
            } catch (err) {
                console.error('Activity load failed:', err);
                actData.loadedAt = Date.now(); // stop the realtime refresh from retrying in a loop; the Refresh button still works
                status.innerHTML = `<span style="color:var(--danger-glow);">Couldn't load activity (${escapeHtml(err.message)}). If this says "permission", publish the latest firestore.rules.</span>`;
            } finally { actLoading = false; }
        }

        // Developer accounts (the DEV checkbox) are left out of the adoption numbers, staff table,
        // overview and history by default - their testing isn't "team usage". The "Include
        // developers" checkbox brings them back, e.g. to debug your own activity.
        let actIncludeDevs = false;
        function devSets() {
            const ids = new Set(), names = new Set();
            getDB('users').forEach(u => { if (u.isDev) { ids.add(u.id); names.add(u.name); } });
            return { ids, names };
        }
        function isDevLog(l, sets) { return sets.ids.has(l.uid) || (!l.uid && sets.names.has(l.user)); }
        function logVisible(l, sets) { return actIncludeDevs || !isDevLog(l, sets || devSets()); }
        function toggleIncludeDevs(on) {
            actIncludeDevs = !!on;
            document.querySelectorAll('.act-include-devs').forEach(c => { c.checked = actIncludeDevs; });
            if (actData.statusBase) document.getElementById('actStatus').textContent = actData.statusBase + devHiddenNote();
            renderLogs(true);
            renderOverviewBodyIfShown();
        }

        function devHiddenNote() { const n = devSets().ids.size; return n && !actIncludeDevs ? ` ${n} developer account${n === 1 ? ' is' : 's are'} hidden.` : ''; }

        function computeActivityStats() {
            const users = getDB('users').filter(u => actIncludeDevs || !u.isDev);
            const byKey = {};
            const nameToUid = {};
            users.forEach(u => { byKey[u.id] = { u, opens: 0, days: new Set(), claims: 0, drops: 0, acks: 0, lastTs: 0 }; nameToUid[u.name] = u.id; });
            const dau = {}; // day -> Set(userKey)
            const shownDays = new Set(), ackDays = new Set();
            let totalOpens = 0, totalClaims = 0, totalDrops = 0;
            actData.logs.forEach(l => {
                if (l.env === 'dev' && !actIncludeDevs) return; // developer testing doesn't count toward adoption numbers
                const key = (l.uid && byKey[l.uid]) ? l.uid : nameToUid[l.user];
                if (!key) return; // removed account / "System"
                const r = byKey[key];
                r.lastTs = Math.max(r.lastTs, l.ts);
                if (l.day) { r.days.add(l.day); (dau[l.day] = dau[l.day] || new Set()).add(key); }
                if (ACT_SESSION_TYPES.includes(l.type)) { r.opens++; totalOpens++; }
                if (l.type === 'shift_claim') { r.claims++; totalClaims++; }
                if (l.type === 'shift_drop') { r.drops++; totalDrops++; }
                if (l.type === 'shift_ack') { r.acks++; ackDays.add(key + '|' + l.day); }
                if (l.type === 'open_shifts_shown') shownDays.add(key + '|' + l.day);
            });
            const rows = users.map(u => {
                const r = byKey[u.id], pr = actData.presence[u.id] || {};
                return { u, ...r, days: r.days.size, lastSeen: Math.max(pr.lastSeen || 0, r.lastTs), pres: pr };
            });
            return { rows, dau, totalOpens, totalClaims, totalDrops, shownDays, ackDays };
        }

        // Bar chart of distinct active staff per day (last 30 days of the range at most).
        function buildDauBars(dau, rangeDays) {
            const days = Math.min(rangeDays, 30), bars = [];
            for (let i = days - 1; i >= 0; i--) {
                const d = new Date(Date.now() - i * 86400000), k = dayKey(d);
                bars.push({ k, n: dau[k] ? dau[k].size : 0, label: d.toLocaleDateString([], { month: 'short', day: 'numeric' }) });
            }
            const max = Math.max(1, ...bars.map(b => b.n));
            return `<div style="display:flex; align-items:flex-end; gap:${days > 14 ? 3 : 8}px; height:90px;">` +
                bars.map(b => `<div title="${escapeHtml(b.label)}: ${b.n} active" style="flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; height:100%;"><div style="font-size:0.65rem; color:var(--text-muted);">${b.n || ''}</div><div style="width:100%; max-width:34px; height:${Math.max(2, Math.round(b.n / max * 62))}px; background:${b.n ? 'linear-gradient(180deg, var(--neon-teal), var(--neon-saguaro))' : 'rgba(255,255,255,0.08)'}; border-radius:4px 4px 0 0;"></div></div>`).join('') + '</div>' +
                `<div style="display:flex; justify-content:space-between; font-size:0.65rem; color:var(--text-muted); margin-top:4px;"><span>${escapeHtml(bars[0].label)}</span><span>${escapeHtml(bars[bars.length - 1].label)}</span></div>`;
        }

        function renderActivityDashboard() {
            const { rows, dau, totalOpens, totalClaims, totalDrops, shownDays, ackDays } = computeActivityStats();
            const staff = rows.length;
            const active = rows.filter(r => r.opens > 0 || r.days > 0).length;
            const pct = n => staff ? Math.round(n / staff * 100) : 0;
            const installed = rows.filter(r => r.pres.installed).length;
            const notif = rows.filter(r => r.pres.pushOn || r.pres.notif === 'granted').length;
            const ackedShown = [...shownDays].filter(k => ackDays.has(k)).length;
            const ackRate = shownDays.size ? Math.round(ackedShown / shownDays.size * 100) + '%' : '—';
            const card = (big, label, sub) => `<div class="glass-card" style="padding:14px; margin:0;"><div style="font-family:'Outfit'; font-size:1.5rem; font-weight:800; color:var(--neon-teal);">${big}</div><div style="font-size:0.78rem; font-weight:600;">${label}</div><div style="font-size:0.7rem; color:var(--text-muted);">${sub}</div></div>`;
            document.getElementById('actSummary').innerHTML =
                card(`${active}<span style="font-size:0.9rem; color:var(--text-muted);"> / ${staff}</span>`, 'Active staff', `${pct(active)}% used the app`) +
                card(totalOpens.toLocaleString(), 'App opens', active ? `~${(totalOpens / active).toFixed(1)} per active person` : 'in this range') +
                card(totalClaims.toLocaleString(), 'Shifts claimed', `${totalDrops} dropped`) +
                card(ackRate, 'Read the open-shifts popup', `${ackedShown} of ${shownDays.size} popups shown were acknowledged`) +
                card(`${installed}<span style="font-size:0.9rem; color:var(--text-muted);"> / ${staff}</span>`, 'Installed to home screen', `${pct(installed)}% (as of last open)`) +
                card(`${notif}<span style="font-size:0.9rem; color:var(--text-muted);"> / ${staff}</span>`, 'Notifications on', `${pct(notif)}% (as of last open)`);

            document.getElementById('actDau').innerHTML = buildDauBars(dau, actData.rangeDays);

            rows.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
            document.getElementById('actUsersBody').innerHTML = rows.map(r => {
                const stale = !r.lastSeen ? 'var(--danger-glow)' : (Date.now() - r.lastSeen > 7 * 86400000 ? '#ffb020' : 'var(--neon-saguaro)');
                const dev = r.pres.platform ? `${r.pres.installed ? '📲 App' : '🌐 Browser'} · ${escapeHtml(r.pres.platform)}${(r.pres.pushOn || r.pres.notif === 'granted') ? ' · 🔔' : ''}` : '<span style="color:var(--text-muted);">—</span>';
                const tv = r.u.termsVersion;
                const terms = !tv ? '<span style="color:var(--danger-glow);">Not yet</span>'
                    : (tv === TERMS_VERSION ? `<span style="color:var(--neon-saguaro);">✓ ${r.u.termsAcceptedAt ? new Date(r.u.termsAcceptedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : 'Current'}</span>` : '<span style="color:#ffb020;">Older version</span>');
                return `<tr style="cursor:pointer;" onclick="filterLogsByUser('${escapeHtml(jsStr(r.u.id))}')">
                    <td><strong>${escapeHtml(r.u.name)}</strong>${r.u.isAdmin ? ' <span style="color:var(--text-muted); font-size:0.7rem;">admin</span>' : ''}<div style="font-size:0.7rem; color:var(--text-muted);">${escapeHtml(r.u.role || '')}</div></td>
                    <td style="color:${stale}; font-weight:600; white-space:nowrap;">${actAgo(r.lastSeen)}</td>
                    <td>${r.opens}</td><td>${r.days}</td><td>${r.claims}${r.drops ? ` <span style="color:var(--text-muted);">(−${r.drops})</span>` : ''}</td><td>${r.acks}</td>
                    <td style="font-size:0.78rem; white-space:nowrap;">${terms}</td>
                    <td style="font-size:0.78rem; white-space:nowrap;">${dev}</td></tr>`;
            }).join('') || '<tr><td colspan="8" style="color:var(--text-muted);">No staff yet.</td></tr>';
        }

        function filteredActivityLogs() {
            const uSel = document.getElementById('actUserFilter').value;
            const tSel = document.getElementById('actTypeFilter').value;
            const q = document.getElementById('actSearch').value.trim().toLowerCase();
            const nameOf = id => (getDB('users').find(u => u.id === id) || {}).name;
            const sets = devSets();
            return actData.logs.filter(l => {
                if (!logVisible(l, sets)) return false;
                if (uSel && !(l.uid === uSel || (!l.uid && l.user === nameOf(uSel)))) return false;
                if (tSel && !ACT_GROUPS[tSel].includes(l.type)) return false;
                if (q && !((l.user || '') + ' ' + (l.action || '') + ' ' + l.type).toLowerCase().includes(q)) return false;
                return true;
            });
        }

        // Re-renders from the data already fetched - never refetches (this also runs on
        // every realtime update elsewhere in the app, via refreshGlobalUI).
        function renderLogs(resetPaging) {
            const sel = document.getElementById('actUserFilter');
            if (!sel) return;
            if (resetPaging === true) actData.shown = ACT_PAGE;
            const prev = sel.value;
            sel.innerHTML = '<option value="">All staff</option>' + getDB('users').filter(u => actIncludeDevs || !u.isDev).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('');
            sel.value = prev;
            if (!actData.loadedAt) { loadActivityLogs(); return; }
            renderActivityDashboard();
            const list = filteredActivityLogs();
            document.getElementById('logsBody').innerHTML = list.slice(0, actData.shown).map(l => {
                const t = ACT_TYPE_LABELS[l.type] || ACT_TYPE_LABELS.action;
                return `<tr><td style="color:var(--text-muted); white-space:nowrap; font-size:0.78rem;">${actWhen(l.ts)}</td><td style="color:var(--neon-teal); font-weight:600;">${escapeHtml(l.user)}</td><td><span style="color:${t[2]}; font-size:0.72rem; font-weight:700; white-space:nowrap;">${t[0]} ${t[1]}</span>${l.env === 'dev' ? ' <span style="color:#ffb020; font-size:0.65rem; font-weight:800;">DEV</span>' : ''} <span style="font-size:0.85rem;">${escapeHtml(l.action)}</span></td></tr>`;
            }).join('') || '<tr><td colspan="3" style="color:var(--text-muted);">Nothing matches.</td></tr>';
            const more = document.getElementById('actMoreBtn');
            more.style.display = list.length > actData.shown ? 'inline-block' : 'none';
            more.textContent = `Show more (${list.length - actData.shown} left)`;
        }
        function showMoreLogs() { actData.shown += ACT_PAGE; renderLogs(); }
        function filterLogsByUser(id) {
            document.getElementById('actUserFilter').value = id;
            renderLogs(true);
            document.getElementById('logsBody').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        function exportActivityCsv() {
            const list = filteredActivityLogs();
            if (!list.length) { alert('Nothing to export - load some activity first.'); return; }
            // Leading apostrophe stops spreadsheet apps from running a cell that starts with = + - @ as a formula.
            const cell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
            const lines = [['Time', 'User', 'User ID', 'Type', 'Activity', 'Details', 'Session'].map(cell).join(',')].concat(
                list.map(l => [new Date(l.ts).toISOString(), l.user, l.uid || '', l.type, l.action, l.meta ? JSON.stringify(l.meta) : '', l.sid || ''].map(cell).join(',')));
            const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
            const a = document.createElement('a');
            a.href = url; a.download = `suzans-security-activity-${dayKey(new Date())}.csv`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        // Team-wide open-shifts popup controls at the top of the Users tab.
        function renderOpenShiftsControls() {
            const st = getOpenShiftsSettings();
            const btn = document.getElementById('osToggleBtn'), sel = document.getElementById('osFrequency');
            if (!btn || !sel) return;
            btn.textContent = st.enabled ? '🔴 Turn Off' : '🟢 Turn On';
            btn.className = 'btn btn-sm' + (st.enabled ? ' btn-magenta' : '');
            sel.value = st.frequency;
            sel.disabled = !st.enabled;
            document.getElementById('osStatus').textContent = st.enabled
                ? `On for the whole team - shown ${OPEN_SHIFTS_FREQUENCIES[st.frequency].label.toLowerCase()}, until each person acknowledges it.`
                : 'Off for the whole team - nobody sees the popup.';
        }
        function saveOpenShiftsSettings(patch, logText) {
            const next = { id: 'openShifts', ...getOpenShiftsSettings(), ...patch, updatedAt: Date.now(), updatedBy: (currUser() || {}).name || '' };
            return saveDoc('settings', 'openShifts', next).then(() => logAction(logText)).catch(() => renderOpenShiftsControls());
        }
        function toggleOpenShiftsPopup() {
            const turnOn = !getOpenShiftsSettings().enabled;
            saveOpenShiftsSettings({ enabled: turnOn }, turnOn ? 'Turned ON the open-shifts popup for everyone' : 'Turned OFF the open-shifts popup for everyone');
        }
        function saveOpenShiftsFrequency() {
            const freq = document.getElementById('osFrequency').value;
            saveOpenShiftsSettings({ frequency: freq }, 'Set the open-shifts popup to ' + OPEN_SHIFTS_FREQUENCIES[freq].label.toLowerCase());
        }

        function renderUsers() {
            const me = currUser();
            renderOpenShiftsControls();
            document.getElementById('usersBody').innerHTML = getDB('users').map(u => `<tr>
                <td><strong>${u.name}</strong>${u.isDev ? ' <span class="neon-tag" style="background:rgba(255,176,32,0.15); color:#ffb020; border:1px solid rgba(255,176,32,0.4); padding:1px 7px; font-size:0.62rem;">DEV</span>' : ''}</td>
                <td style="font-size:0.8rem;">${u.email}<br>${u.phone || ''}</td>
                <td style="font-size:0.8rem; color:var(--neon-teal); font-weight:600;">${u.role || '<span style="color:var(--text-muted); font-weight:400;">—</span>'}</td>
                <td style="white-space:nowrap;">
                    <button class="btn btn-sm ${u.isAdmin ? 'btn-magenta' : 'btn-outline'}" onclick="togAdmin('${u.id}')">${u.isAdmin ? 'Admin' : 'Guard'}</button>
                    <button class="btn btn-sm btn-outline" onclick="openUserModal('${u.id}')">Edit</button>
                    <button class="btn btn-sm btn-outline" style="color:var(--danger-glow);" onclick="delUser('${u.id}')" ${me && me.id === u.id ? 'disabled title="Cannot delete your own active session"' : ''}>Delete</button>
                </td>
            </tr>`).join('');
        }
        function togAdmin(id) {
            let usr = getDB('users').find(x => x.id === id);
            if (!usr) return;
            if (!usr.isAdmin) {
                // No PIN prompt here anymore - granting admin access just
                // flips the flag. They'll be walked through setting their
                // own personal PIN the first time they actually open the
                // admin console (see promptAdminPin's no-PIN-yet branch).
                usr.isAdmin = true;
            } else {
                usr.isAdmin = false;
            }
            saveDoc('users', usr.id, usr);
        }
        function adminSendPasswordReset(email, name) {
            auth.sendPasswordResetEmail(email).then(() => {
                alert(`Password reset email sent to ${name} (${email}).`);
                logAction('Sent password reset email to: ' + name);
            }).catch(err => alert('Could not send reset email: ' + friendlyAuthError(err)));
        }
        function delUser(id) {
            const me = currUser();
            if (me && me.id === id) { alert("You can't delete the account you're currently signed in as. Sign in as another admin first."); return; }
            const u = getDB('users').find(x => x.id === id);
            if (!u) return;
            if (confirm(`Remove ${u.name}'s access and profile from this app? This cannot be undone.\n\nNote: this removes their app access immediately, but due to Firebase security restrictions it can't delete their underlying login credential from here. If you need to fully block that email/password combo from ever signing in again, also remove them under Firebase Console → Authentication → Users.`)) {
                deleteDoc('users', id);
            }
        }

        // --- Admin console: add / edit user profiles directly ---
        let editingUserId = null; // null while the modal is open in "create new user" mode
        function openUserModal(id) {
            editingUserId = id || null;
            const u = id ? getDB('users').find(x => x.id === id) : null;
            document.getElementById('umErr').style.display = 'none';
            document.getElementById('umTitle').innerText = id ? 'Edit User' : 'Add New User';
            document.getElementById('umName').value = u ? u.name : '';
            document.getElementById('umEmail').value = u ? u.email : '';
            document.getElementById('umEmail').disabled = !!id; // can't change another user's login email client-side
            document.getElementById('umEmailLockedNote').style.display = id ? 'block' : 'none';
            document.getElementById('umPhone').value = u ? (u.phone || '') : '';
            document.getElementById('umRole').innerHTML = '<option value="">-- No rank assigned --</option>' + getRoleCatalog().map(r => `<option value="${r}">${r}</option>`).join('');
            // New users default to Private - only override for an existing
            // user being edited, whose actual rank (or lack of one) we show as-is.
            document.getElementById('umRole').value = u ? (u.role || '') : 'Private';
            document.getElementById('umIsDev').checked = u ? !!u.isDev : false;
            document.getElementById('umShowOpenShifts').checked = u ? !u.openShiftsPopupOff : true;
            document.getElementById('umIsAdmin').checked = u ? !!u.isAdmin : false;
            document.getElementById('umPinWrap').style.display = (u && u.isAdmin) ? 'block' : 'none';
            document.getElementById('umPin').value = '';
            // Password field only makes sense when creating a brand new account.
            // Firebase's client SDK has no way to set another existing user's
            // password directly - only a reset email (see the button below).
            document.getElementById('umPasswordWrap').style.display = id ? 'none' : 'block';
            document.getElementById('umPassword').value = '';
            document.getElementById('umResetWrap').style.display = id ? 'block' : 'none';
            document.getElementById('umDeleteBtn').style.display = id ? 'inline-block' : 'none';
            document.getElementById('userModal').style.display = 'flex';
        }
        function sendResetFromModal() {
            const email = document.getElementById('umEmail').value.trim();
            const name = document.getElementById('umName').value.trim() || email;
            if (!email) return;
            adminSendPasswordReset(email, name);
        }
        async function saveUserModal() {
            const name = document.getElementById('umName').value.trim();
            const email = document.getElementById('umEmail').value.trim();
            const phone = document.getElementById('umPhone').value.trim();
            const role = document.getElementById('umRole').value;
            const pw = document.getElementById('umPassword').value;
            const isAdmin = document.getElementById('umIsAdmin').checked;
            const openShiftsPopupOff = !document.getElementById('umShowOpenShifts').checked;
            const isDev = document.getElementById('umIsDev').checked;
            const pinInput = document.getElementById('umPin').value.trim();
            const errEl = document.getElementById('umErr');
            const showErr = msg => { errEl.innerText = msg; errEl.style.display = 'block'; };
            errEl.style.display = 'none';

            if (!name || !email) { showErr('Name and email are required.'); return; }
            if (pinInput && pinInput.length < 4) { showErr('Admin PIN must be at least 4 characters.'); return; }
            const users = getDB('users');

            if (editingUserId) {
                // Editing only ever touches the Firestore profile fields - email
                // is locked in the UI, and password changes go through the reset
                // email flow instead (see openUserModal).
                const existing = users.find(x => x.id === editingUserId);
                if (!existing) return;
                // PIN is optional here - if granting admin access with no PIN
                // entered, they'll be prompted to set their own the first time
                // they open the admin console (see promptAdminPin).
                const pin = isAdmin ? (pinInput || existing.pin) : existing.pin;
                const updated = { ...existing, name, phone, role, isAdmin, isDev, pin, openShiftsPopupOff };
                saveDoc('users', editingUserId, updated).then(() => {
                    logAction('Updated user profile: ' + name);
                    const me = currUser();
                    if (me && me.id === editingUserId) {
                        window._currentUserProfile = updated;
                        document.getElementById('userGreeting').innerText = updated.name;
                    }
                    closeModal('userModal');
                });
            } else {
                const dupe = users.find(x => x.email.toLowerCase() === email.toLowerCase());
                if (dupe) { showErr('Another account already uses that email.'); return; }
                if (!pw || pw.length < 6) { showErr('Please set an initial password of at least 6 characters.'); return; }
                try {
                    // Created via a SECONDARY Firebase app instance so this doesn't
                    // sign the admin out of their own session (see getSecondaryAuth).
                    const secAuth = getSecondaryAuth();
                    const cred = await secAuth.createUserWithEmailAndPassword(email, pw);
                    const newUid = cred.user.uid;
                    await secAuth.signOut();
                    const nu = { id: newUid, uid: newUid, name, email, phone, role, isAdmin, isDev, openShiftsPopupOff, pin: isAdmin ? pinInput : undefined };
                    await saveDoc('users', newUid, nu);
                    logAction('Admin created new user: ' + name);
                    notifySystemAdminOfNewUser(nu);
                    closeModal('userModal');
                } catch (err) {
                    console.error('Create user failed:', err);
                    showErr(friendlyAuthError(err));
                }
            }
        }
        function deleteUserFromModal() {
            if (!editingUserId) return;
            const me = currUser();
            if (me && me.id === editingUserId) { alert("You can't delete the account you're currently signed in as. Sign in as another admin first."); return; }
            const u = getDB('users').find(x => x.id === editingUserId);
            if (confirm(`Remove ${u ? u.name : 'this user'}'s access and profile from this app? This cannot be undone.\n\nNote: this removes app access immediately but can't delete their underlying login credential from here - see Firebase Console → Authentication → Users for that.`)) {
                deleteDoc('users', editingUserId);
                closeModal('userModal');
            }
        }

        // --- DASHBOARD (DEV site, developers only) ---
        // Feedback triage + the same Activity & Logs panel the admin console has. The Logs panel
        // is one set of DOM ids, so the Dashboard borrows it (moves it in) and
        // restoreLogsPanel() puts it back where the admin console expects it.
        let dashFeedback = [], dashFbUnsub = null, dashFbDirty = false, dashTab = 'overview';
        let logsPanelHome = null;
        const FEEDBACK_ORDER = ['new', 'reviewing', 'planned', 'done', 'declined'];

        function restoreLogsPanel() {
            const panel = document.getElementById('adminLogs');
            if (!panel || !logsPanelHome || panel.parentNode === logsPanelHome.parent) return;
            logsPanelHome.parent.insertBefore(panel, logsPanelHome.next);
        }
        function renderDashboard() {
            const panel = document.getElementById('adminLogs');
            if (panel && !logsPanelHome) logsPanelHome = { parent: panel.parentNode, next: panel.nextSibling };
            document.getElementById('dashFbType').innerHTML = '<option value="">All types</option>' + Object.keys(FEEDBACK_TYPES).map(k => `<option value="${k}">${FEEDBACK_TYPES[k]}</option>`).join('');
            startFeedbackListener();
            switchDashTab(dashTab);
        }
        function stopDashboard() {
            if (dashFbUnsub) { dashFbUnsub(); dashFbUnsub = null; }
            restoreLogsPanel();
        }
        function switchDashTab(tab) {
            dashTab = tab;
            document.getElementById('dashTabOverviewBtn').classList.toggle('active', tab === 'overview');
            document.getElementById('dashOverviewPane').style.display = tab === 'overview' ? 'block' : 'none';
            document.getElementById('dashTabFeedbackBtn').classList.toggle('active', tab === 'feedback');
            document.getElementById('dashTabActivityBtn').classList.toggle('active', tab === 'activity');
            document.getElementById('dashFeedbackPane').style.display = tab === 'feedback' ? 'block' : 'none';
            document.getElementById('dashActivityPane').style.display = tab === 'activity' ? 'block' : 'none';
            if (tab === 'activity') {
                const panel = document.getElementById('adminLogs');
                if (panel.parentNode !== document.getElementById('dashActivityHost')) document.getElementById('dashActivityHost').appendChild(panel);
                panel.style.display = 'block';
                if (actData.loadedAt && Date.now() - actData.loadedAt > 300000) loadActivityLogs(); else renderLogs();
            } else if (tab === 'overview') { renderOverview(); } else { renderFeedbackPanel(); }
        }
        function renderDashboardActivityIfShown() {
            if (dashTab === 'activity' && document.getElementById('adminLogs').parentNode === document.getElementById('dashActivityHost')) renderLogs();
            if (dashTab === 'overview') renderOverviewBody();
        }

        function startFeedbackListener() {
            if (dashFbUnsub) return;
            dashFbUnsub = db.collection('feedback').orderBy('ts', 'desc').limit(300).onSnapshot(snap => {
                dashFeedback = snap.docs.map(d => d.data());
                updateFeedbackBadge();
                if (dashTab === 'overview') renderOverviewBody();
                const ae = document.activeElement;
                if (ae && document.getElementById('dashFeedbackList').contains(ae) && /TEXTAREA|INPUT|SELECT/.test(ae.tagName)) { dashFbDirty = true; return; } // don't wipe what they're typing
                renderFeedbackPanel();
            }, err => {
                console.error('Feedback listener failed:', err);
                dashFbUnsub = null;
                document.getElementById('dashFeedbackList').innerHTML = `<p style="color:var(--danger-glow); font-size:0.85rem;">Couldn't load feedback (${escapeHtml(err.message)}). If this says "permission", publish the latest firestore.rules.</p>`;
            });
        }
        function updateFeedbackBadge() {
            const n = dashFeedback.filter(f => (f.status || 'new') === 'new').length;
            const b = document.getElementById('dashFeedbackBadge');
            b.textContent = n; b.style.display = n ? 'flex' : 'none';
            document.getElementById('dashFeedbackCount').textContent = n ? '(' + n + ' new)' : '';
        }
        let dashFbStatus = 'open'; // open = new + reviewing + planned
        function setFeedbackStatusFilter(k) { dashFbStatus = k; renderFeedbackPanel(); }

        function renderFeedbackPanel() {
            const list = document.getElementById('dashFeedbackList');
            if (!list) return;
            dashFbDirty = false;
            const counts = { all: dashFeedback.length, open: 0 };
            FEEDBACK_ORDER.forEach(k => counts[k] = 0);
            dashFeedback.forEach(f => { const k = FEEDBACK_STATUSES[f.status] ? f.status : 'new'; counts[k]++; if (['new', 'reviewing', 'planned'].includes(k)) counts.open++; });
            const chip = (k, label, color) => `<button class="btn btn-sm ${dashFbStatus === k ? '' : 'btn-outline'}" style="${dashFbStatus === k ? '' : 'color:' + color + ';'}" onclick="setFeedbackStatusFilter('${k}')">${label} ${counts[k]}</button>`;
            document.getElementById('dashFeedbackChips').innerHTML = chip('open', 'Open', 'var(--text-primary)') +
                FEEDBACK_ORDER.map(k => chip(k, FEEDBACK_STATUSES[k][0], FEEDBACK_STATUSES[k][1])).join('') + chip('all', 'All', 'var(--text-muted)');
            const type = document.getElementById('dashFbType').value;
            const q = document.getElementById('dashFbSearch').value.trim().toLowerCase();
            const rows = dashFeedback.filter(f => {
                const k = FEEDBACK_STATUSES[f.status] ? f.status : 'new';
                if (dashFbStatus === 'open' ? !['new', 'reviewing', 'planned'].includes(k) : (dashFbStatus !== 'all' && k !== dashFbStatus)) return false;
                if (type && f.type !== type) return false;
                if (q && !((f.message || '') + ' ' + (f.user || '') + ' ' + (f.reply || '')).toLowerCase().includes(q)) return false;
                return true;
            });
            list.innerHTML = rows.map(f => {
                const k = FEEDBACK_STATUSES[f.status] ? f.status : 'new', st = FEEDBACK_STATUSES[k];
                const notes = (f.notes || []).map(n => `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:3px;">📝 <strong>${escapeHtml(n.by || '')}</strong> ${new Date(n.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${escapeHtml(n.text)}</div>`).join('');
                const id = escapeHtml(jsStr(f.id));
                return `<div class="glass-card" style="padding:14px; margin-bottom:12px; border-left:3px solid ${st[1]};">
                    <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center;">
                        <div style="font-size:0.78rem; color:var(--text-muted);">${escapeHtml(FEEDBACK_TYPES[f.type] || f.type || '')} &middot; <strong style="color:var(--neon-teal);">${escapeHtml(f.user || 'Unknown')}</strong>${f.role ? ' (' + escapeHtml(f.role) + ')' : ''} &middot; ${new Date(f.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
                        <select class="input-field" style="width:auto; margin:0; padding:4px 8px; font-size:0.78rem; color:${st[1]};" onchange="setFeedbackStatus('${id}', this.value)">${FEEDBACK_ORDER.map(o => `<option value="${o}" ${o === k ? 'selected' : ''}>${FEEDBACK_STATUSES[o][0]}</option>`).join('')}</select>
                    </div>
                    <div style="font-size:0.9rem; line-height:1.55; margin:8px 0; white-space:pre-wrap;">${escapeHtml(f.message || '')}</div>
                    <div style="font-size:0.7rem; color:var(--text-muted); margin-bottom:8px;">${f.view ? '📍 ' + escapeHtml(f.view) + ' &middot; ' : ''}${escapeHtml(f.platform || '')}${f.installed ? ' (installed app)' : ''}${f.env === 'dev' ? ' &middot; <span style="color:#ffb020;">from DEV</span>' : ''}</div>
                    <textarea id="fbReply_${escapeHtml(f.id)}" class="input-field" rows="2" placeholder="Reply the user will see…" style="margin-bottom:6px;">${escapeHtml(f.reply || '')}</textarea>
                    <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px;">
                        <button class="btn btn-sm" onclick="saveFeedbackReply('${id}')">💬 Save reply</button>
                        <button class="btn btn-outline btn-sm" style="color:var(--danger-glow);" onclick="deleteFeedback('${id}')">Delete</button>
                    </div>
                    <input type="text" id="fbNote_${escapeHtml(f.id)}" class="input-field" style="margin:0 0 4px; font-size:0.8rem;" placeholder="Add an internal note (only developers see this) and press Enter" onkeydown="if(event.key==='Enter') addFeedbackNote('${id}')" data-1p-ignore>
                    ${notes}
                </div>`;
            }).join('') || '<p style="color:var(--text-muted); font-size:0.85rem;">No feedback matches.</p>';
        }
        function feedbackWrite(id, patch, logText) {
            const me = currUser() || {};
            return withTimeout(db.collection('feedback').doc(id).set({ ...patch, updatedAt: Date.now(), updatedBy: me.name || '' }, { merge: true }), 15000, 'updating feedback')
                .then(() => { if (logText) logAction(logText); })
                .catch(err => { alert('⚠️ Could not update feedback: ' + err.message); throw err; });
        }
        function setFeedbackStatus(id, status) { feedbackWrite(id, { status }, 'Set feedback status to ' + (FEEDBACK_STATUSES[status] || [status])[0]).catch(() => renderFeedbackPanel()); }
        function saveFeedbackReply(id) {
            const reply = document.getElementById('fbReply_' + id).value.trim();
            feedbackWrite(id, { reply }, 'Replied to feedback').then(() => alert('Reply saved. The user will see it in their feedback list.')).catch(() => {});
        }
        function addFeedbackNote(id) {
            const input = document.getElementById('fbNote_' + id), text = input.value.trim();
            if (!text) return;
            const note = { ts: Date.now(), by: (currUser() || {}).name || '', text: text.slice(0, 500) };
            feedbackWrite(id, { notes: firebase.firestore.FieldValue.arrayUnion(note) }).then(() => { input.value = ''; }).catch(() => {});
        }
        function deleteFeedback(id) {
            if (!confirm('Delete this feedback permanently?')) return;
            withTimeout(db.collection('feedback').doc(id).delete(), 15000, 'deleting feedback').then(() => logAction('Deleted a feedback item')).catch(err => alert('⚠️ Could not delete: ' + err.message));
        }

        // --- DASHBOARD OVERVIEW (front page of the Dashboard) ---
        // Built from data already in memory (users, events, feedback) plus the activity logs the
        // Logs panel loads (cached 5 minutes; Refresh reloads). Developer testing (env=dev) is
        // left out of the numbers, same as the Logs tab.
        function setOverviewRange(days) {
            document.getElementById('actRange').value = String(days);
            refreshOverview();
        }
        function refreshOverview() {
            document.getElementById('ovStatus').textContent = 'Loading…';
            loadActivityLogs().then(() => renderOverviewBody());
        }
        function renderOverview() {
            if (!actData.loadedAt || Date.now() - actData.loadedAt > 300000) refreshOverview();
            else renderOverviewBody();
        }
        function ovCard(title, body, extra) {
            return `<div class="glass-card" style="padding:14px; margin:0; ${extra || ''}"><h4 style="color:var(--neon-teal); font-family:'Outfit'; font-size:0.9rem; margin-bottom:8px;">${title}</h4>${body}</div>`;
        }
        function ovTile(big, label, sub, color) {
            return `<div class="glass-card" style="padding:14px; margin:0;"><div style="font-family:'Outfit'; font-size:1.55rem; font-weight:800; color:${color || 'var(--neon-teal)'};">${big}</div><div style="font-size:0.78rem; font-weight:600;">${label}</div><div style="font-size:0.7rem; color:var(--text-muted);">${sub}</div></div>`;
        }
        function ovBars(rows, color) {
            if (!rows.length) return '<p style="font-size:0.78rem; color:var(--text-muted);">Nothing yet.</p>';
            const max = Math.max(...rows.map(r => r[1]));
            return rows.map(r => `<div style="margin-bottom:6px;"><div style="display:flex; justify-content:space-between; font-size:0.78rem;"><span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:8px;">${escapeHtml(r[0])}</span><span style="color:var(--text-muted);">${r[1]}</span></div><div style="height:6px; border-radius:3px; background:rgba(255,255,255,0.08);"><div style="height:100%; width:${Math.max(4, Math.round(r[1] / max * 100))}%; border-radius:3px; background:${color || 'var(--neon-teal)'};"></div></div></div>`).join('');
        }
        function ovTop(map, n) { return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n); }

        function renderOverviewBodyIfShown() { if (dashTab === 'overview' && document.getElementById('dashboardView').style.display !== 'none') renderOverviewBody(); }
        function renderOverviewBody() {
            const el = document.getElementById('dashOverviewBody');
            if (!el) return;
            const days = actData.rangeDays || 7;
            document.getElementById('ovRange7').className = 'btn btn-sm' + (days === 7 ? '' : ' btn-outline');
            document.getElementById('ovRange30').className = 'btn btn-sm' + (days === 30 ? '' : ' btn-outline');
            document.getElementById('ovStatus').textContent = actData.loadedAt ? `Updated ${actAgo(actData.loadedAt)} · ${actData.logs.length.toLocaleString()} log events read` : '';

            const { rows, dau, totalOpens } = computeActivityStats();
            const staff = rows.length;
            const sets = devSets();
            const shown = actData.logs.filter(l => logVisible(l, sets));
            const real = actIncludeDevs ? shown : shown.filter(l => l.env !== 'dev');
            const today = dayKey(new Date());
            const opensToday = real.filter(l => ACT_SESSION_TYPES.includes(l.type) && l.day === today).length;
            const active = rows.filter(r => r.opens > 0 || r.days > 0).length;
            const pct = (n, d) => d ? Math.round(n / d * 100) : 0;

            // shifts
            const upcoming = getDB('events').filter(e => !e.archived && !e.hidden && !e.cancelled && daysSinceEvent(e) <= 0);
            let openSlots = 0, filled = 0;
            upcoming.forEach(e => { const o = eventOpenSlots(e), f = (e.guards || []).length; openSlots += o; filled += f; });
            const fillPct = pct(filled, filled + openSlots);

            // feedback
            const fb = dashFeedback;
            const fbNew = fb.filter(f => (f.status || 'new') === 'new').length;
            const fbOpen = fb.filter(f => ['new', 'reviewing', 'planned'].includes(f.status || 'new')).length;

            const installed = rows.filter(r => r.pres.installed).length;
            const notif = rows.filter(r => r.pres.pushOn || r.pres.notif === 'granted').length;
            const termsOk = rows.filter(r => r.u.termsVersion === TERMS_VERSION).length;

            const tiles = ovTile(`${active}<span style="font-size:0.9rem; color:var(--text-muted);"> / ${staff}</span>`, 'Active staff', `${pct(active, staff)}% in the last ${days} days`) +
                ovTile(opensToday, 'Opens today', `${totalOpens.toLocaleString()} in ${days} days`) +
                ovTile(fbOpen, 'Open feedback', `${fbNew} new`, fbNew ? '#7fd4ff' : 'var(--neon-teal)') +
                ovTile(upcoming.length, 'Upcoming shifts', `${openSlots} open positions · ${fillPct}% filled`, openSlots ? '#ffb020' : 'var(--neon-saguaro)') +
                ovTile(`${installed}<span style="font-size:0.9rem; color:var(--text-muted);"> / ${staff}</span>`, 'Installed to home screen', `${pct(installed, staff)}% of staff`) +
                ovTile(`${notif}<span style="font-size:0.9rem; color:var(--text-muted);"> / ${staff}</span>`, 'Notifications on', `${pct(notif, staff)}% of staff`) +
                ovTile(`${rows.filter(r => r.u.tutorialDone).length}<span style="font-size:0.9rem; color:var(--text-muted);"> / ${staff}</span>`, 'Finished the tutorial', 'completed or skipped') +
                ovTile(`${termsOk}<span style="font-size:0.9rem; color:var(--text-muted);"> / ${staff}</span>`, 'On current Terms', `${staff - termsOk} still to accept`, termsOk === staff ? 'var(--neon-saguaro)' : '#ffb020');

            // screens + shifts viewed
            const screens = {}, shifts = {};
            real.forEach(l => {
                if (l.type === 'view') { const n = (l.meta && l.meta.view) || String(l.action).replace(/^Viewed /, ''); screens[n] = (screens[n] || 0) + 1; }
                if (l.type === 'event_view') { const n = String(l.action).replace(/^Viewed shift: /, ''); shifts[n] = (shifts[n] || 0) + 1; }
            });

            // needs attention
            const attn = rows.map(r => {
                const why = [];
                if (r.u.isDev) { /* developers often only use DEV, which isn't counted */ }
                else if (!r.lastSeen) why.push('never opened the app');
                else if (Date.now() - r.lastSeen > 7 * 86400000) why.push('not seen for ' + actAgo(r.lastSeen).replace(' ago', ''));
                if (r.u.termsVersion !== TERMS_VERSION) why.push('terms not accepted');
                return why.length ? { name: r.u.name, why: why.join(', ') } : null;
            }).filter(Boolean);

            // feed + latest feedback
            const feed = shown.slice(0, 12).map(l => {
                const t = ACT_TYPE_LABELS[l.type] || ACT_TYPE_LABELS.action;
                return `<div style="display:flex; gap:8px; font-size:0.78rem; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);"><span style="color:var(--text-muted); white-space:nowrap;">${actAgo(l.ts)}</span><span style="min-width:0;"><strong style="color:var(--neon-teal);">${escapeHtml(l.user)}</strong> <span style="color:${t[2]};">${t[0]}</span> ${escapeHtml(l.action)}${l.env === 'dev' ? ' <span style="color:#ffb020; font-weight:800;">DEV</span>' : ''}</span></div>`;
            }).join('') || '<p style="font-size:0.78rem; color:var(--text-muted);">No activity in this range.</p>';
            const latestFb = fb.filter(f => ['new', 'reviewing', 'planned'].includes(f.status || 'new')).slice(0, 5).map(f => {
                const st = FEEDBACK_STATUSES[f.status] || FEEDBACK_STATUSES.new;
                return `<div style="padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:0.8rem; cursor:pointer;" onclick="switchDashTab('feedback')"><div style="display:flex; justify-content:space-between; gap:8px;"><span style="color:var(--text-muted);">${escapeHtml(FEEDBACK_TYPES[f.type] || '')} · ${escapeHtml(f.user || '')}</span><span style="color:${st[1]}; font-weight:700;">${st[0]}</span></div><div>${escapeHtml(String(f.message || '').slice(0, 110))}${String(f.message || '').length > 110 ? '…' : ''}</div></div>`;
            }).join('') || '<p style="font-size:0.78rem; color:var(--text-muted);">No open feedback. 🎉</p>';

            const data = [['Staff', staff], ['Shift postings', getDB('events').length], ['Chat messages', getDB('chats').length], ['Promoters', getDB('promoters').length], ['Ban list entries', getDB('banlist').length], ['Feedback items', fb.length]]
                .map(d => `<div style="display:flex; justify-content:space-between; font-size:0.8rem; padding:3px 0;"><span style="color:var(--text-muted);">${d[0]}</span><strong>${d[1].toLocaleString()}</strong></div>`).join('');

            el.innerHTML = `<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-bottom:14px;">${tiles}</div>
                <div class="glass-card" style="padding:14px;"><h4 style="color:var(--neon-teal); font-family:'Outfit'; font-size:0.9rem; margin-bottom:4px;">Daily active staff</h4><p style="font-size:0.72rem; color:var(--text-muted); margin-bottom:10px;">Developer testing is not counted</p>${buildDauBars(dau, days)}</div>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px; margin-bottom:12px;">
                    ${ovCard('Latest open feedback', latestFb)}
                    ${ovCard('Live activity', feed)}
                    ${ovCard('Most visited screens', ovBars(ovTop(screens, 6)))}
                    ${ovCard('Most viewed shifts', ovBars(ovTop(shifts, 6), '#7fd4ff'))}
                    ${ovCard('Needs attention' + (attn.length ? ' (' + attn.length + ')' : ''), attn.length ? attn.slice(0, 10).map(a => `<div style="font-size:0.8rem; padding:3px 0;"><strong>${escapeHtml(a.name)}</strong> <span style="color:#ffb020;">${escapeHtml(a.why)}</span></div>`).join('') + (attn.length > 10 ? `<div style="font-size:0.72rem; color:var(--text-muted); margin-top:4px;">+${attn.length - 10} more in Activity &amp; Logs</div>` : '') : '<p style="font-size:0.8rem; color:var(--neon-saguaro);">Everyone is active and up to date. ✅</p>')}
                    ${ovCard('Data & environment', data + `<div style="margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.08); font-size:0.75rem; color:var(--text-muted);">Version: <strong style="color:#ffb020;">${IS_DEV_SITE ? 'DEV' : 'PROD'}</strong> · Terms ${escapeHtml(TERMS_LAST_UPDATED)}</div>`)}
                </div>`;
        }
