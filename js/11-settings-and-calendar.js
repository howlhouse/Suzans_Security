        /* SETTINGS - every signed-in user manages their own profile here */
        function renderSettings() {
            const u = currUser();
            if (!u) return;
            document.getElementById('setName').value = u.name || '';
            document.getElementById('setNickname').value = u.nickname || '';
            document.getElementById('setPhone').value = u.phone || '';
            document.getElementById('setEmail').value = u.email || '';
            document.getElementById('setPreferredContact').value = u.preferredContact || 'email';
            document.getElementById('setNotifShifts').checked = !u.notifPrefs || u.notifPrefs.shifts !== false;
            document.getElementById('setNotifChat').checked = !u.notifPrefs || u.notifPrefs.chat !== false;
            document.getElementById('setNotifReminder90').checked = !u.notifPrefs || u.notifPrefs.reminder90 !== false;
            renderMyShifts();
            try { renderPushDeviceStatus(); } catch (err) { console.error(err); }
        }
        // "14:30" -> "2:30 PM". Falsy/malformed input passes through unchanged.
        // --- ADD TO CALENDAR ---
        // Two options, since there's no single method that reliably lands an
        // event in every device's default calendar app from a plain web page:
        //   - Google Calendar: a prefilled "render" URL - opens the Google
        //     Calendar app on Android (or the web UI on desktop) with the
        //     event ready to save. Best for Android, since that's almost
        //     always the default calendar there.
        //   - Apple / Outlook: a standard .ics file, which is what iOS/macOS
        //     Calendar and Outlook understand natively.
        function icsEscape(str) {
            return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
        }
        function icsDateStamp(d) {
            // Compact UTC form required for DTSTAMP/UID: YYYYMMDDTHHMMSSZ
            return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        }
        // Shared start/end computation for both calendar options, so the two
        // never disagree about when the shift actually is. Times are kept as
        // floating local time (no timezone conversion) so they show up at the
        // same wall-clock time regardless of the device's own timezone.
        function eventCalendarRange(e) {
            const dateDigits = (e.date || '').replace(/-/g, '');
            if (!/^\d{8}$/.test(dateDigits)) return null;

            // Mirrors shiftTimeLabel(): prefer the explicit Start/End Time
            // fields, falling back to the earliest day-of timeline entry for
            // older events that predate those fields.
            let startTime = e.startTime;
            const endTimeRaw = e.endTime;
            if (!startTime) {
                const timeline = [...(e.timeline || [])].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
                startTime = timeline[0]?.time || '';
            }

            if (!startTime) {
                // Still nothing to go on - fall back to an all-day event.
                const endDate = new Date(e.date + 'T00:00:00');
                endDate.setDate(endDate.getDate() + 1);
                const endDigits = endDate.toISOString().slice(0, 10).replace(/-/g, '');
                return { allDay: true, start: dateDigits, end: endDigits };
            }

            const startDigits = startTime.replace(':', '') + '00';
            let endDigits;
            if (endTimeRaw) {
                endDigits = endTimeRaw.replace(':', '') + '00';
            } else {
                // No end time specified - default to a 4-hour shift.
                const [h, m] = startTime.split(':').map(Number);
                const end = new Date(2000, 0, 1, h, m);
                end.setHours(end.getHours() + 4);
                endDigits = String(end.getHours()).padStart(2, '0') + String(end.getMinutes()).padStart(2, '0') + '00';
            }
            return { allDay: false, start: `${dateDigits}T${startDigits}`, end: `${dateDigits}T${endDigits}` };
        }
        function eventCalendarDetails(e) {
            const descParts = [e.desc || ''];
            if (e.ticketLink) descParts.push('Tickets/Portal: ' + e.ticketLink);
            return descParts.join('\n\n');
        }
        function addToGoogleCalendar(id) {
            const e = getDB('events').find(x => x.id === id);
            if (!e) return;
            const range = eventCalendarRange(e);
            if (!range) { alert('This event has no valid date to add to a calendar.'); return; }
            const params = new URLSearchParams({
                action: 'TEMPLATE',
                text: e.title || 'Event',
                dates: `${range.start}/${range.end}`,
                details: eventCalendarDetails(e)
            });
            if (e.address) params.set('location', e.address);
            window.open(`https://calendar.google.com/calendar/render?${params.toString()}`, '_blank');
        }
        function addToAppleOutlookCalendar(id) {
            const e = getDB('events').find(x => x.id === id);
            if (!e) return;
            const range = eventCalendarRange(e);
            if (!range) { alert('This event has no valid date to add to a calendar.'); return; }

            const dtLines = range.allDay
                ? `DTSTART;VALUE=DATE:${range.start}\r\nDTEND;VALUE=DATE:${range.end}`
                : `DTSTART:${range.start}\r\nDTEND:${range.end}`;
            const ics = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//Suzans Security//Event Calendar//EN',
                'CALSCALE:GREGORIAN',
                'BEGIN:VEVENT',
                `UID:${e.id}@suzans-security`,
                `DTSTAMP:${icsDateStamp(new Date())}`,
                dtLines,
                `SUMMARY:${icsEscape(e.title)}`,
                `DESCRIPTION:${icsEscape(eventCalendarDetails(e))}`,
                e.address ? `LOCATION:${icsEscape(e.address)}` : '',
                'END:VEVENT',
                'END:VCALENDAR'
            ].filter(Boolean).join('\r\n');

            // iOS Safari (including installed home-screen PWAs) throws
            // "Safari cannot download this file" for a Blob URL triggered via
            // a synthetic <a download> click - it has no download manager to
            // hand the file to. Navigating straight to a text/calendar data:
            // URI instead makes Safari recognize the MIME type and open its
            // native "Add Event" sheet directly, no download involved.
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
            const dataUri = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
            if (isIOS) {
                window.location.href = dataUri;
            } else {
                const a = document.createElement('a');
                a.href = dataUri;
                a.download = `${(e.title || 'event').replace(/[^\w\-]+/g, '_')}.ics`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
        }
        function to12Hour(t) {
            if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return t;
            let [h, m] = t.split(':').map(Number);
            const ampm = h >= 12 ? 'PM' : 'AM';
            h = h % 12 || 12;
            return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
        }
        // Prefers the event's explicit Start/End Time; falls back to the
        // earliest day-of timeline entry for older events that predate that
        // field, then finally 'TBD'.
        function shiftTimeLabel(e) {
            if (e.startTime) return to12Hour(e.startTime) + (e.endTime ? ' – ' + to12Hour(e.endTime) : '');
            const timeline = [...(e.timeline || [])].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
            return timeline[0]?.time ? to12Hour(timeline[0].time) : 'TBD';
        }
        // Total length of the shift from its Start/End Time, as a label like
        // "8 hrs" or "7.5 hrs". An end at or before the start means the shift runs
        // past midnight, so it wraps to the next day. Returns null when either
        // time is missing (older events), rather than guessing.
        function shiftHoursLabel(e) {
            const parse = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
            const start = parse(e.startTime), end = parse(e.endTime);
            if (start === null || end === null) return null;
            let mins = end - start;
            if (mins <= 0) mins += 24 * 60;
            const hrs = Math.round(mins / 60 * 100) / 100;
            return `${hrs} ${hrs === 1 ? 'hr' : 'hrs'}`;
        }
        function myUpcomingShifts() {
            const u = currUser();
            const today = new Date().toISOString().slice(0, 10);
            return getDB('events')
                .filter(e => !e.archived && e.date >= today && (e.guards || []).includes(u?.name))
                .sort((a, b) => new Date(a.date) - new Date(b.date));
        }
        function renderMyShifts() {
            const mine = myUpcomingShifts();
            document.getElementById('mySettingsShiftsBody').innerHTML = mine.length ? mine.map(e =>
                `<tr><td>${e.date}</td><td>${shiftTimeLabel(e)}</td><td>${e.title}</td></tr>`
            ).join('') : '<tr><td colspan="3" style="color:var(--text-muted);">No upcoming shifts.</td></tr>';
        }
        // Full-detail card view for the "My Shifts & Notes" screen: event info,
        // a directions link straight to the venue, and any personal note
        // Command left for that shift.
        function renderMyShiftsView() {
            const u = currUser();
            const mine = myUpcomingShifts();
            const list = document.getElementById('myShiftsList');
            if (!mine.length) {
                list.innerHTML = '<div class="glass-card" style="padding:28px; text-align:center; color:var(--text-muted);">No upcoming shifts. Claim one from the Events tab!</div>';
                return;
            }
            list.innerHTML = mine.map(e => {
                const myPost = (e.guardPosts && e.guardPosts[u?.name]) || 'Unassigned';
                const myNote = u && e.guardNotes && e.guardNotes[u.name];
                const mapsUrl = e.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.address)}` : null;
                return `
                <div class="glass-card" style="padding:20px; cursor:pointer;" onclick="if(event.target.tagName !== 'A' && event.target.tagName !== 'BUTTON') openEventDetail('${e.id}')">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
                        <div>
                            <h3 style="font-family:'Outfit'; font-size:1.2rem; font-weight:700; margin-bottom:4px;">${e.title}</h3>
                            <p style="font-size:0.85rem; color:var(--text-muted);">🗓️ ${e.date} &nbsp;•&nbsp; ⏰ ${shiftTimeLabel(e)}${shiftHoursLabel(e) ? ` &nbsp;•&nbsp; ⏱️ ${shiftHoursLabel(e)}` : ''}</p>
                        </div>
                        <span class="neon-tag tag-active" style="white-space:nowrap;">${myPost}</span>
                    </div>
                    ${e.address ? `<p style="font-size:0.85rem; color:var(--text-secondary); margin-top:10px;">📍 ${e.address}</p>` : ''}
                    ${myNote ? `
                    <div style="background:rgba(255,42,133,0.1); border:1px solid rgba(255,42,133,0.4); border-radius:12px; padding:12px; margin-top:12px;">
                        <h4 style="color:var(--neon-pink); font-size:0.72rem; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">📝 Note for you from Command</h4>
                        <p style="font-size:0.85rem; color:var(--text-primary);">${myNote}</p>
                    </div>` : ''}
                    <div style="display:flex; gap:8px; margin-top:14px;">
                        ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="text-decoration:none; flex:1; text-align:center;">🧭 Directions</a>` : ''}
                        <button class="btn btn-sm" style="flex:1;" onclick="event.stopPropagation(); openEventDetail('${e.id}')">View Shift</button>
                    </div>
                </div>`;
            }).join('');
        }
        function saveMyProfile() {
            const u = currUser();
            if (!u) return;
            const nickname = document.getElementById('setNickname').value.trim();
            const phone = document.getElementById('setPhone').value.trim();
            const preferredContact = document.getElementById('setPreferredContact').value;
            const notifPrefs = {
                shifts: document.getElementById('setNotifShifts').checked,
                chat: document.getElementById('setNotifChat').checked,
                reminder90: document.getElementById('setNotifReminder90').checked
            };
            const updated = { ...u, nickname, phone, preferredContact, notifPrefs };
            saveDoc('users', u.id, updated).then(() => {
                window._currentUserProfile = updated;
                alert('Settings saved.');
                logAction('Updated own profile settings');
                // Reminder prefs may have just changed (e.g. re-enabled) - re-check
                // right away instead of waiting for the next realtime refresh.
                try { scheduleShiftReminders(); } catch (err) { console.error('Reminder scheduling failed:', err); }
            });
        }
        function changeMyPassword() {
            const u = currUser();
            if (!u || !u.email) return;
            if (!confirm(`Send a password reset link to ${u.email}?`)) return;
            auth.sendPasswordResetEmail(u.email).then(() => {
                alert(`Password reset email sent to ${u.email}. Check your inbox (and spam folder).`);
                logAction('Requested own password reset');
            }).catch(err => alert('Could not send reset email: ' + friendlyAuthError(err)));
        }
        async function deleteMyAccount() {
            const u = currUser();
            if (!u) return;
            if (!confirm("This will permanently delete your profile and remove your access to Suzan's Security. This cannot be undone. Continue?")) return;
            if (!confirm('Are you absolutely sure? This is your final confirmation.')) return;
            window._selfDeleting = true; // tells validateSession() to stand down - we're handling sign-out ourselves
            try {
                logAction('Self-deleted account: ' + u.name);
                await purgeUserLicenses(u.id);
                await deleteDoc('users', u.id);
                try {
                    // Only works without re-authentication if the sign-in is recent;
                    // if it fails, the profile is still gone and access is already
                    // revoked - an admin can clean up the leftover login credential
                    // from Firebase Console → Authentication → Users.
                    await auth.currentUser.delete();
                } catch (authErr) {
                    console.warn('Could not remove login credential (may require a recent sign-in):', authErr);
                }
                window._currentUserProfile = null;
                alert('Your profile has been deleted.');
                await auth.signOut();
                location.reload();
            } catch (err) {
                window._selfDeleting = false;
                alert('Could not delete your profile: ' + err.message);
            }
        }


        // Read-only directory available to every signed-in user (via the user
        // menu, not the admin-only Command Center → Contacts pane). Shows each
        // promoter's full details - including the optional Instagram/website/
        // venue links, which intentionally never show up on the event detail
        // page itself - plus every event they're linked to as a promoter.
        function renderContactsDirectory() {
            const promoters = [...getDB('promoters')].sort((a, b) => a.name.localeCompare(b.name));
            const el = document.getElementById('contactsDirectoryList');
            if (!promoters.length) { el.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem;">No promoter contacts have been added yet.</p>`; return; }
            el.innerHTML = promoters.map(p => {
                const events = getDB('events')
                    .filter(e => getEventPromoterIds(e).includes(p.id) && !e.hidden)
                    .sort((a, b) => new Date(b.date) - new Date(a.date));
                const linkRow = [
                    p.instagram ? `<a href="${p.instagram}" target="_blank" class="btn btn-outline btn-sm" style="text-decoration:none;">📸 Instagram</a>` : '',
                    p.website ? `<a href="${p.website}" target="_blank" class="btn btn-outline btn-sm" style="text-decoration:none;">🌐 Website</a>` : '',
                    p.venueLink ? `<a href="${p.venueLink}" target="_blank" class="btn btn-outline btn-sm" style="text-decoration:none;">📍 Venue</a>` : ''
                ].filter(Boolean).join('');
                return `<div class="glass-card" style="padding:16px;">
                    <h4 style="color:var(--neon-teal); font-family:'Outfit'; font-size:1.15rem;">${p.name}</h4>
                    <p style="font-size:0.85rem; color:var(--text-muted); margin-top:4px;">${p.phone ? '📞 ' + p.phone : ''}${p.phone && p.email ? ' • ' : ''}${p.email ? '✉️ ' + p.email : ''}</p>
                    ${(p.tags || []).length ? `<div class="tags-container" style="margin-top:8px;">${p.tags.map(t => `<span class="neon-tag tag-active">${t}</span>`).join('')}</div>` : ''}
                    ${linkRow ? `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;">${linkRow}</div>` : ''}
                    <div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border-glass);">
                        <h5 style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Events (${events.length})</h5>
                        ${events.length ? events.map(e => `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.05); cursor:pointer;" onclick="openEventDetail('${e.id}')">
                            <span style="font-size:0.88rem;">${e.title}${e.archived ? ' <span style="color:var(--text-muted); font-weight:400;">(past)</span>' : ''}</span>
                            <span style="font-size:0.78rem; color:var(--neon-teal); white-space:nowrap;">🗓️ ${e.date}</span>
                        </div>`).join('') : `<p style="color:var(--text-muted); font-size:0.8rem;">No events linked to this contact yet.</p>`}
                    </div>
                </div>`;
            }).join('');
        }

        function renderContacts() { document.getElementById('promoterList').innerHTML = getDB('promoters').map(p => `<div class="glass-card" style="padding:16px;"><div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;"><div style="cursor:pointer; flex:1;" onclick="openP('${p.id}')"><h4 style="color:var(--neon-teal); font-family:'Outfit'; font-size:1.15rem;">${p.name}</h4><div class="tags-container" style="margin-top:8px;">${(p.tags || []).map(t => `<span class="neon-tag tag-active">${t}</span>`).join('')}</div></div><button class="btn btn-sm btn-outline" style="color:var(--danger-glow); flex-shrink:0;" onclick="delPromoter('${p.id}')">Delete</button></div></div>`).join(''); }
        function addPromoter() { const id = 'p' + Date.now(); const name = prompt('Name:'); if (!name) return; saveDoc('promoters', id, { id, name, phone: prompt('Phone:') || '', email: prompt('Email:') || '', instagram: '', website: '', venueLink: '', tags: [], notes: [] }); }
        function openP(id) { selP = id; let p = getDB('promoters').find(x => x.id === id); document.getElementById('pName').value = p.name || ''; document.getElementById('pPhone').value = p.phone || ''; document.getElementById('pEmail').value = p.email || ''; document.getElementById('pInstagram').value = p.instagram || ''; document.getElementById('pWebsite').value = p.website || ''; document.getElementById('pVenueLink').value = p.venueLink || ''; document.getElementById('pTags').innerHTML = (p.tags || []).map((t, i) => `<span class="neon-tag tag-active">${t} <b style="color:var(--danger-glow);cursor:pointer;margin-left:4px;" onclick="rmPTag(${i})">×</b></span>`).join(''); document.getElementById('pNotes').innerHTML = (p.notes || []).map(n => `<div style="border-bottom:1px solid rgba(255,255,255,0.06); padding:8px 0;"><span style="color:var(--neon-teal); font-size:0.75rem; font-weight:600;">${n.date}</span><p style="font-size:0.85rem;">${n.text}</p></div>`).join(''); document.getElementById('promoterModal').style.display = 'flex'; }
        function updatePromoterField(field, value) {
            const pr = getDB('promoters').find(x => x.id === selP);
            if (!pr) return;
            if (field === 'name' && !value.trim()) { alert('Contact name is required.'); document.getElementById('pName').value = pr.name; return; }
            pr[field] = value.trim();
            saveDoc('promoters', pr.id, pr).catch(err => alert('Could not save contact: ' + err.message));
        }
        function addPTag() { let pr = getDB('promoters').find(x => x.id === selP), v = document.getElementById('pTagIn').value; if (v) { pr.tags = pr.tags || []; pr.tags.push(v); saveDoc('promoters', pr.id, pr); document.getElementById('pTagIn').value = ''; } }
        function rmPTag(i) { let pr = getDB('promoters').find(x => x.id === selP); pr.tags.splice(i, 1); saveDoc('promoters', pr.id, pr); }
        function addPNote() { let pr = getDB('promoters').find(x => x.id === selP), v = document.getElementById('pNoteIn').value; if (v) { pr.notes = pr.notes || []; pr.notes.unshift({ date: new Date().toLocaleDateString(), text: v }); saveDoc('promoters', pr.id, pr); document.getElementById('pNoteIn').value = ''; } }
        function delPromoter(id) { if (confirm('Delete this contact permanently? This cannot be undone.')) deleteDoc('promoters', id); }
        function delPromoterFromModal() { if (selP && confirm('Delete this contact permanently? This cannot be undone.')) { deleteDoc('promoters', selP); closeModal('promoterModal'); } }


        // --- LICENSES & CERTIFICATES ---
        // There's no file storage on this project, so uploads live in Firestore as
        // data URLs (photos are shrunk in the browser first to fit the 1 MB doc
        // limit). Each upload is two docs sharing one id:
        //   licenses/{id}      - small metadata (who, type, expiry, file name)
        //   licenseFiles/{id}  - the actual image/PDF data
        // Keeping them apart lets the admin roster live-update without downloading
        // every staffer's image; a file is only fetched when someone taps View.
        // Neither collection is in allCollections / ss_state on purpose, and
        // firestore.rules limits both to the owner plus admins.
        const LICENSE_TYPES = { title4: 'Title IV License', guardcard: 'Unarmed Guard Card' };
        const LICENSE_MAX_DATA_CHARS = 900000;     // data-URL length that still fits a Firestore doc
        const LICENSE_MAX_PDF_BYTES = 650 * 1024;  // base64 adds ~33%
        let adminLicenses = [];
        let adminLicUnsub = null;
        let myLicenses = [];
        let licenseViewUrl = null;

        function licenseLabel(l) { return l.type === 'other' ? (l.label || 'Other certificate') : (LICENSE_TYPES[l.type] || 'License'); }
        function licenseStatus(l) {
            if (!l.expires) return { text: 'On file', color: 'var(--neon-saguaro)' };
            const end = new Date(l.expires + 'T23:59:59');
            if (isNaN(end)) return { text: 'On file', color: 'var(--neon-saguaro)' };
            const days = Math.ceil((end - new Date()) / 86400000);
            const when = new Date(l.expires + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            if (days < 0) return { text: 'Expired ' + when, color: 'var(--danger-glow)' };
            if (days <= 60) return { text: 'Expires ' + when, color: '#ffb020' };
            return { text: 'Valid to ' + when, color: 'var(--neon-saguaro)' };
        }

        async function renderMyLicenses() {
            const u = currUser();
            const el = document.getElementById('myLicensesList');
            if (!u || !el) return;
            try {
                const snap = await db.collection('licenses').where('uid', '==', u.id).get();
                myLicenses = snap.docs.map(d => d.data());
            } catch (err) {
                console.error('Could not load licenses:', err);
                el.innerHTML = `<p style="color:var(--danger-glow); font-size:0.85rem;">Couldn't load your licenses (${escapeHtml(err.message)}).</p>`;
                return;
            }
            const order = { title4: 0, guardcard: 1, other: 2 };
            const list = [...myLicenses].sort((a, b) => (order[a.type] - order[b.type]) || String(a.label || '').localeCompare(String(b.label || '')));
            const missing = Object.keys(LICENSE_TYPES).filter(t => !list.some(l => l.type === t));
            el.innerHTML = list.map(l => {
                const st = licenseStatus(l);
                return `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
                    <div style="min-width:0;">
                        <div style="font-weight:600; font-size:0.9rem;">${escapeHtml(licenseLabel(l))}</div>
                        <div style="font-size:0.78rem; color:${st.color};">${escapeHtml(st.text)}</div>
                    </div>
                    <div style="display:flex; gap:6px; flex-shrink:0;">
                        <button class="btn btn-outline btn-sm" onclick="viewLicense('${escapeHtml(jsStr(l.id))}')">View</button>
                        <button class="btn btn-outline btn-sm" style="color:var(--danger-glow);" onclick="deleteMyLicense('${escapeHtml(jsStr(l.id))}')">Delete</button>
                    </div>
                </div>`;
            }).join('') + missing.map(t => `<div style="padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.06); font-size:0.85rem;"><span style="font-weight:600;">${LICENSE_TYPES[t]}</span> <span style="color:var(--text-muted);">&mdash; not uploaded yet</span></div>`).join('');
        }

        // Photos: scale down + re-encode as JPEG until it fits. PDFs: must already be small.
        function loadImageFromFile(file) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(file);
                const img = new Image();
                img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
                img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image couldn't be read. Try a JPG or PNG photo, or a PDF.")); };
                img.src = url;
            });
        }
        async function prepareLicenseFile(file) {
            if (file.type === 'application/pdf') {
                if (file.size > LICENSE_MAX_PDF_BYTES) throw new Error('That PDF is too large (limit about 650 KB). Take a clear photo of the certificate instead, or upload a smaller PDF.');
                const data = await new Promise((resolve, reject) => {
                    const r = new FileReader();
                    r.onload = () => resolve(r.result);
                    r.onerror = () => reject(new Error('Could not read that PDF.'));
                    r.readAsDataURL(file);
                });
                return { dataUrl: data, mime: 'application/pdf' };
            }
            if (!file.type.startsWith('image/')) throw new Error('Please choose a photo (JPG/PNG) or a PDF.');
            const img = await loadImageFromFile(file);
            let dim = 1800, quality = 0.85;
            for (let i = 0; i < 8; i++) {
                const scale = Math.min(1, dim / Math.max(img.naturalWidth, img.naturalHeight));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const out = canvas.toDataURL('image/jpeg', quality);
                if (out.length <= LICENSE_MAX_DATA_CHARS) return { dataUrl: out, mime: 'image/jpeg' };
                dim = Math.round(dim * 0.8); quality = Math.max(0.5, quality - 0.07);
            }
            throw new Error('Could not shrink that photo enough. Try a smaller image.');
        }

        async function uploadMyLicense() {
            const u = currUser();
            if (!u) return;
            const type = document.getElementById('licType').value;
            const label = document.getElementById('licLabel').value.trim();
            const expires = document.getElementById('licExpires').value;
            const file = document.getElementById('licFile').files[0];
            if (type === 'other' && !label) { alert('Please enter what this certificate is.'); return; }
            if (!file) { alert('Choose a photo or PDF first.'); return; }
            const btn = document.getElementById('licUploadBtn');
            btn.disabled = true; btn.textContent = 'Uploading…';
            try {
                let prepared;
                try { prepared = await prepareLicenseFile(file); }
                catch (err) { alert(err.message); return; }
                const id = type === 'other' ? `${u.id}_other_${Date.now()}` : `${u.id}_${type}`;
                // File first, metadata second: a listed license never points at a missing file.
                await saveDoc('licenseFiles', id, { id, uid: u.id, mime: prepared.mime, data: prepared.dataUrl });
                await saveDoc('licenses', id, { id, uid: u.id, userName: u.name || '', type, label: type === 'other' ? label : '', expires: expires || '', fileName: file.name, mime: prepared.mime, uploadedAt: new Date().toISOString() });
                logAction('Uploaded license: ' + licenseLabel({ type, label }));
                document.getElementById('licFile').value = '';
                document.getElementById('licExpires').value = '';
                document.getElementById('licLabel').value = '';
                alert('Uploaded. Managers can now see it.');
                renderMyLicenses();
            } catch (err) {
                console.error('License upload failed:', err); // saveDoc already alerted
            } finally {
                btn.disabled = false; btn.textContent = '⬆️ Upload';
            }
        }

        async function deleteMyLicense(id) {
            const l = myLicenses.find(x => x.id === id);
            if (!l || !confirm(`Remove your ${licenseLabel(l)} from the app?`)) return;
            try {
                await deleteDoc('licenses', id);
                await deleteDoc('licenseFiles', id);
                logAction('Removed license: ' + licenseLabel(l));
            } catch (err) { /* deleteDoc already alerted */ }
            renderMyLicenses();
        }

        // Opens the stored file for the owner or an admin.
        async function viewLicense(id) {
            const l = myLicenses.find(x => x.id === id) || adminLicenses.find(x => x.id === id);
            document.getElementById('licenseViewTitle').textContent = l ? ((l.userName ? l.userName + ' - ' : '') + licenseLabel(l)) : 'License';
            const body = document.getElementById('licenseViewBody');
            body.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';
            document.getElementById('licenseViewModal').style.display = 'flex';
            try {
                const snap = await db.collection('licenseFiles').doc(id).get({ source: 'server' });
                if (!snap.exists) { body.innerHTML = '<p style="color:var(--danger-glow);">The file for this license is missing.</p>'; return; }
                const f = snap.data();
                if (f.mime === 'application/pdf') {
                    const blob = await (await fetch(f.data)).blob();
                    licenseViewUrl = URL.createObjectURL(blob);
                    body.innerHTML = `<a class="btn btn-sm" style="text-decoration:none; display:inline-block; margin-bottom:12px;" href="${licenseViewUrl}" target="_blank" rel="noopener">Open PDF in new tab</a>
                        <iframe src="${licenseViewUrl}" style="width:100%; height:60vh; border:1px solid var(--border-glass); border-radius:12px; background:#fff;"></iframe>`;
                } else {
                    body.innerHTML = `<img src="${f.data}" alt="License" style="max-width:100%; border-radius:12px;">`;
                }
            } catch (err) {
                console.error('Could not open license:', err);
                body.innerHTML = `<p style="color:var(--danger-glow);">Couldn't open it (${escapeHtml(err.message)}).</p>`;
            }
        }
        function closeLicenseViewer() {
            document.getElementById('licenseViewModal').style.display = 'none';
            document.getElementById('licenseViewBody').innerHTML = '';
            if (licenseViewUrl) { URL.revokeObjectURL(licenseViewUrl); licenseViewUrl = null; }
        }

        // Admin roster: live-updating (metadata only) while the Licenses tab is open.
        function startAdminLicensesListener() {
            if (adminLicUnsub) { renderAdminLicenses(); return; }
            renderAdminLicenses();
            adminLicUnsub = db.collection('licenses').onSnapshot(snap => {
                adminLicenses = snap.docs.map(d => d.data());
                renderAdminLicenses();
            }, err => {
                console.error('Licenses listener failed:', err);
                document.getElementById('adminLicBody').innerHTML = `<tr><td colspan="4" style="color:var(--danger-glow);">Couldn't load licenses (${escapeHtml(err.message)}). Make sure the latest firestore.rules are published.</td></tr>`;
                adminLicUnsub = null;
            });
        }
        function stopAdminLicensesListener() {
            if (adminLicUnsub) { adminLicUnsub(); adminLicUnsub = null; }
        }
        function renderAdminLicenses() {
            const body = document.getElementById('adminLicBody');
            if (!body) return;
            const q = (document.getElementById('adminLicSearch').value || '').trim().toLowerCase();
            const chip = l => {
                const st = licenseStatus(l);
                return `<button class="btn btn-outline btn-sm" style="color:${st.color}; margin:2px 4px 2px 0; white-space:nowrap;" onclick="viewLicense('${escapeHtml(jsStr(l.id))}')">${l.type === 'other' ? escapeHtml(licenseLabel(l)) + ': ' : ''}${escapeHtml(st.text)}</button>`;
            };
            const none = '<span style="color:var(--text-muted);">&mdash;</span>';
            const users = getDB('users').filter(u => !q || String(u.name || '').toLowerCase().includes(q)).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            body.innerHTML = users.map(u => {
                const mine = adminLicenses.filter(l => l.uid === u.id);
                const one = t => { const l = mine.find(x => x.type === t); return l ? chip(l) : none; };
                const others = mine.filter(l => l.type === 'other');
                return `<tr><td><strong>${escapeHtml(u.name)}</strong></td><td>${one('title4')}</td><td>${one('guardcard')}</td><td>${others.length ? others.map(chip).join('') : none}</td></tr>`;
            }).join('') || '<tr><td colspan="4" style="color:var(--text-muted);">No matching staff.</td></tr>';
        }

        // Clean up a removed account's uploads (used by account deletion paths).
        async function purgeUserLicenses(uid) {
            try {
                const snap = await db.collection('licenses').where('uid', '==', uid).get();
                if (snap.empty) return;
                const batch = db.batch();
                snap.docs.forEach(d => { batch.delete(d.ref); batch.delete(db.collection('licenseFiles').doc(d.id)); });
                await batch.commit();
            } catch (err) { console.warn('Could not clean up licenses:', err); }
        }
