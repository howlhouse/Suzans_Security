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
                            <p style="font-size:0.85rem; color:var(--text-muted);">🗓️ ${e.date} &nbsp;•&nbsp; ⏰ ${shiftTimeLabel(e)}</p>
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

