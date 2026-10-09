        /* BAN LIST - open to every signed-in user, not just admins */
        function renderBanList() {
            const list = getDB('banlist').slice().sort((a, b) => a.name.localeCompare(b.name));
            document.getElementById('banListContainer').innerHTML = list.map(b => `
                <div class="glass-card event-tile" style="padding:16px;" onclick="openBanEntry('${b.id}')">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <h4 style="color:var(--neon-pink); font-family:'Outfit'; font-size:1.15rem;">🚫 ${b.name}</h4>
                        <span style="font-size:0.72rem; color:var(--text-muted); white-space:nowrap;">${(b.notes || []).length} incident${(b.notes || []).length === 1 ? '' : 's'}</span>
                    </div>
                    ${(b.notes && b.notes[0]) ? `<p style="font-size:0.85rem; color:var(--text-secondary); margin-top:8px;">Latest: ${b.notes[0].text}</p>` : '<p style="font-size:0.82rem; color:var(--text-muted); margin-top:8px;">No incidents logged yet.</p>'}
                </div>
            `).join('') || '<p style="color:var(--text-muted); text-align:center; margin-top:40px;">No one on the ban list yet.</p>';
        }
        function addBanEntry() {
            const name = prompt('Name of the person to add to the ban list:');
            if (!name || !name.trim()) return;
            const id = 'b' + Date.now();
            saveDoc('banlist', id, { id, name: name.trim(), notes: [] }).then(() => logAction('Added to ban list: ' + name.trim()));
        }
        let selBan = null;
        function openBanEntry(id) {
            selBan = id;
            const b = getDB('banlist').find(x => x.id === id);
            if (!b) return;
            document.getElementById('banModalTitle').innerText = '🚫 ' + b.name;
            document.getElementById('banNameInput').value = b.name;
            renderBanNotes(b);
            document.getElementById('banNoteIn').value = '';
            document.getElementById('banModal').style.display = 'flex';
        }
        function renderBanNotes(b) {
            document.getElementById('banNotes').innerHTML = (b.notes || []).map(n => `
                <div style="border-bottom:1px solid rgba(255,255,255,0.06); padding:8px 0;">
                    <span style="color:var(--neon-pink); font-size:0.75rem; font-weight:600;">${n.date}${n.by ? ' · ' + n.by : ''}</span>
                    <p style="font-size:0.85rem;">${n.text}</p>
                </div>
            `).join('') || '<p style="color:var(--text-muted); font-size:0.85rem;">No incidents logged yet.</p>';
        }
        function saveBanName() {
            const b = getDB('banlist').find(x => x.id === selBan);
            if (!b) return;
            const newName = document.getElementById('banNameInput').value.trim();
            if (!newName) { alert('Name cannot be empty.'); return; }
            const updated = { ...b, name: newName };
            saveDoc('banlist', selBan, updated).then(() => {
                document.getElementById('banModalTitle').innerText = '🚫 ' + newName;
                logAction('Updated ban list entry: ' + newName);
            });
        }
        function addBanNote() {
            const b = getDB('banlist').find(x => x.id === selBan);
            const v = document.getElementById('banNoteIn').value.trim();
            if (!b || !v) return;
            const updated = { ...b, notes: [{ date: new Date().toLocaleDateString(), by: currUser()?.name || '', text: v }, ...(b.notes || [])] };
            saveDoc('banlist', selBan, updated).then(() => {
                renderBanNotes(updated);
                document.getElementById('banNoteIn').value = '';
                logAction('Logged ban list incident for: ' + b.name);
            });
        }
        function delBanFromModal() {
            if (!selBan) return;
            if (confirm('Remove this person from the ban list permanently? This cannot be undone.')) {
                deleteDoc('banlist', selBan);
                closeModal('banModal');
            }
        }
        function closeModal(id) { document.getElementById(id).style.display = 'none'; }
        // About-window "How to Use" secondary page toggle.
        function showAboutPage(n) {
            document.getElementById('aboutPage1').style.display = n === 1 ? 'block' : 'none';
            document.getElementById('aboutPage2').style.display = n === 2 ? 'block' : 'none';
            const sheet = document.getElementById('aboutModal').querySelector('.modal-sheet');
            if (sheet) sheet.scrollTop = 0;
        }
        // FIRST-OPEN WELCOME POPUP: shown once per browser via localStorage, never
        // again after the user dismisses it. Falls back to sessionStorage (still
        // one-time per tab) if localStorage is unavailable (private browsing, etc.)
        // so the app never breaks just because storage is blocked.
        // --- GUIDED TOUR (first-run tutorial) ---
        // Speech bubbles with a spotlight, one per feature. Skippable at any time; finishing OR
        // skipping marks it done on the user's profile (tutorialDone) so it never reappears on its
        // own. The "Take the Tutorial" button in the info popup replays it without changing that.
        let tour = { steps: [], idx: 0, replay: false, view: '', menu: false, token: 0 };
        function tutorialDoneFor(u) {
            if (u.tutorialDone) return true;
            try { return localStorage.getItem('ss_tutorialDone_' + u.id) === '1'; } catch (err) { return false; }
        }
        const tourEl = id => document.getElementById(id);
        const tourSleep = ms => new Promise(r => setTimeout(r, ms));
        function tourDock(view) { return document.querySelector(`.dock-item[data-view="${view}"]`); }
        function tourMenuItem(view) { return document.querySelector(`#userMenuDropdown .user-menu-item[onclick*="${view}"]`); }
        function buildTourSteps() {
            const steps = [
                { title: "Welcome to Suzan's Security 👋", text: "Here's a quick tour of everything in the app. You can <strong>skip at any time</strong>, and replay it later from the ⓘ info button (top right) → <strong>Take the Tutorial</strong>.", view: 'eventsFeed' },
                { title: '🪩 Events', text: "Every upcoming shift posting lives here. Tap the <strong>Events</strong> tab any time to come back to this feed. You may also see a quick \"open shifts\" popup now and then &mdash; just acknowledge it.", view: 'eventsFeed', target: () => tourDock('eventsFeed') },
                { title: 'Shift postings', text: "Each tile is a shift. <strong>Tap one</strong> to see the brief, timeline and who's on it, then <strong>claim a shift or a specific position</strong>, add a personal note, add it to your calendar, and chat with the team on that shift.", view: 'eventsFeed', target: () => document.querySelector('#userEventsFeedList .event-tile') || tourEl('userEventsFeedList') },
                { title: 'Hide community events', text: "Turn this on to hide community-only events so your feed shows just the shifts.", view: 'eventsFeed', target: () => tourEl('hideCommunityToggle') && tourEl('hideCommunityToggle').parentElement },
                { title: '📅 Calendar', text: "See every shift on a month grid. Use the arrows to change months and tap an event to open it.", view: 'calendarView', target: () => tourEl('calMonthText') && tourEl('calMonthText').parentElement },
                { title: '💬 Comms', text: "Team chat. Pick a channel from the dropdown (each shift also gets its own chat), send messages, and attach files with the 📎 button. A red badge on this tab means something's unread.", view: 'eventsFeed', target: () => tourDock('teamChatView') },
                { title: '🚫 Ban List', text: "Known problem patrons and incident history, shared by the whole team. <strong>Add a person</strong> or log an incident so everyone is informed.", view: 'banListView', target: () => document.querySelector('#banListView .btn') },
                { title: '🛡️ Your menu', text: "Tap your name any time to open your menu. Here's what's inside, including <strong>Sign Out</strong> at the bottom.", view: 'eventsFeed', menu: true, target: () => tourEl('userPill') },
                { title: '📋 My Shifts & Notes', text: "Everything you're scheduled for, with shift hours and your personal notes, at a glance.", view: 'myShiftsView', menu: true, target: () => tourMenuItem('myShiftsView') },
                { title: '📇 Promoter Directory', text: "Client and promoter contacts, their links, and the shifts they're tied to.", view: 'contactsDirectoryView', menu: true, target: () => tourMenuItem('contactsDirectoryView') },
                { title: '🪪 Licenses', text: "Recommended certifications for the team, like the basic Title IV license, with a link to get it online.", view: 'licensesView', menu: true, target: () => tourMenuItem('licensesView') },
                { title: '⚙️ Settings', text: "Update your nickname and phone, choose which notifications you get, <strong>turn on phone notifications for this device</strong> so alerts reach you even when the app is closed, and reset your password.", view: 'settingsView', menu: true, target: () => tourMenuItem('settingsView') },
                { title: 'ℹ️ Info & help', text: "The info button has the full how-to guide, the Terms &amp; Conditions, <strong>Send Feedback</strong> to the developers, and <strong>Take the Tutorial</strong> to replay this tour.", view: 'eventsFeed', target: () => document.querySelector('header .btn-outline[onclick*="aboutModal"]') },
                { title: "You're all set 🎉", text: "That's everything. Tap <strong>Done</strong> and jump in &mdash; you can replay this tour anytime from the ⓘ info button.", view: 'eventsFeed' }
            ];
            return steps.filter(st => !st.when || st.when());
        }

        function startTour(replay) {
            if (window._tourActive) return;
            const u = currUser();
            if (!u) return;
            tour = { steps: buildTourSteps(), idx: 0, replay: !!replay, view: '', menu: false, token: 0 };
            window._tourActive = true;
            tourEl('tourLayer').style.display = 'block';
            document.addEventListener('keydown', tourKey);
            window.addEventListener('resize', tourReposition);
            window.addEventListener('scroll', tourReposition, true);
            logEvent('tutorial_started', replay ? 'Replayed the tutorial' : 'Started the tutorial');
            showTourStep(0);
        }
        function tourKey(e) {
            if (!window._tourActive) return;
            if (e.key === 'Escape') endTour('skipped');
            else if (e.key === 'ArrowRight' || e.key === 'Enter') tourNext();
            else if (e.key === 'ArrowLeft') tourBack();
        }
        function tourNext() { if (tour.idx >= tour.steps.length - 1) endTour('completed'); else showTourStep(tour.idx + 1); }
        function tourBack() { if (tour.idx > 0) showTourStep(tour.idx - 1); }

        async function showTourStep(i) {
            const token = ++tour.token;
            tour.idx = i;
            const st = tour.steps[i], last = i === tour.steps.length - 1;
            tourEl('tourBubble').style.opacity = '0'; // hidden while the app moves to the right screen, shown again once placed
            tourEl('tourStepNum').textContent = `Step ${i + 1} of ${tour.steps.length}`;
            tourEl('tourTitle').innerHTML = st.title;
            tourEl('tourText').innerHTML = st.text;
            tourEl('tourBack').style.visibility = i === 0 ? 'hidden' : 'visible';
            tourEl('tourNext').textContent = last ? 'Done' : 'Next';
            // Put the app on the right screen (and the menu open/closed) before pointing at it.
            const wantView = st.view || 'eventsFeed';
            const changed = wantView !== tour.view || !!st.menu !== tour.menu;
            if (wantView !== tour.view) switchView(wantView);
            if (st.menu) tourEl('userMenuDropdown').style.display = 'block'; else closeUserMenu();
            tour.view = wantView; tour.menu = !!st.menu;
            await tourSleep(changed ? 450 : 60);
            if (token !== tour.token || !window._tourActive) return; // user moved on / ended meanwhile
            const el = st.target ? st.target() : null;
            if (el && el.getBoundingClientRect().width > 0 && !el.closest('.dock-nav, header, #userMenuDropdown')) el.scrollIntoView({ block: 'center' });
            tourPlace(el && el.getBoundingClientRect().width > 0 ? el : null);
        }
        let tourTargetEl = null;
        function tourReposition() { if (window._tourActive) requestAnimationFrame(() => tourPlace(tourTargetEl)); }
        function tourPlace(el) {
            tourTargetEl = el;
            const layer = tourEl('tourLayer'), spot = tourEl('tourSpot'), bubble = tourEl('tourBubble'), arrow = tourEl('tourArrow');
            const vw = window.innerWidth, vh = window.innerHeight, bw = bubble.offsetWidth, bh = bubble.offsetHeight;
            bubble.style.opacity = '1';
            if (!el) { // nothing to point at: centered card on a dimmed backdrop
                layer.classList.add('centered'); spot.style.display = 'none'; arrow.style.display = 'none';
                bubble.style.left = Math.max(12, (vw - bw) / 2) + 'px'; bubble.style.top = Math.max(12, (vh - bh) / 2) + 'px';
                return;
            }
            layer.classList.remove('centered');
            const r = el.getBoundingClientRect(), pad = 6;
            spot.style.display = 'block';
            spot.style.left = (r.left - pad) + 'px'; spot.style.top = (r.top - pad) + 'px';
            spot.style.width = (r.width + pad * 2) + 'px'; spot.style.height = (r.height + pad * 2) + 'px';
            const gap = 16, below = (vh - r.bottom) >= bh + gap + 8 || (vh - r.bottom) >= r.top;
            let top = below ? r.bottom + pad + gap : r.top - pad - gap - bh;
            top = Math.min(Math.max(8, top), vh - bh - 8);
            let left = Math.min(Math.max(12, r.left + r.width / 2 - bw / 2), vw - bw - 12);
            bubble.style.left = left + 'px'; bubble.style.top = top + 'px';
            arrow.style.display = 'block';
            arrow.style.left = Math.min(Math.max(16, r.left + r.width / 2 - left - 7), bw - 30) + 'px';
            if (below) { arrow.style.top = '-8px'; arrow.style.bottom = ''; arrow.style.transform = 'rotate(45deg)'; arrow.style.borderLeft = arrow.style.borderTop = '1px solid rgba(0,245,212,0.55)'; arrow.style.borderRight = arrow.style.borderBottom = '0'; }
            else { arrow.style.bottom = '-8px'; arrow.style.top = ''; arrow.style.transform = 'rotate(225deg)'; arrow.style.borderLeft = arrow.style.borderTop = '1px solid rgba(0,245,212,0.55)'; arrow.style.borderRight = arrow.style.borderBottom = '0'; }
        }

        // Taps inside the tour must not reach the app's "tap outside closes the user menu" handler.
        tourEl('tourLayer').addEventListener('click', e => e.stopPropagation());

        function endTour(reason) {
            if (!window._tourActive) return;
            tour.token++;
            const wasReplay = tour.replay, step = tour.idx + 1, total = tour.steps.length;
            document.removeEventListener('keydown', tourKey);
            window.removeEventListener('resize', tourReposition);
            window.removeEventListener('scroll', tourReposition, true);
            tourEl('tourLayer').style.display = 'none';
            closeUserMenu();
            tour.view = '';
            switchView('eventsFeed'); // still flagged active here so this isn't logged as a real screen view
            window._tourActive = false;
            logEvent(reason === 'completed' ? 'tutorial_completed' : 'tutorial_skipped', (reason === 'completed' ? 'Finished the tutorial' : 'Skipped the tutorial at step ' + step + ' of ' + total) + (wasReplay ? ' (replay)' : ''), { step, total });
            const u = currUser();
            if (!wasReplay && u) {
                try { localStorage.setItem('ss_tutorialDone_' + u.id, '1'); } catch (err) { /* storage blocked */ }
                const patch = { tutorialDone: true, tutorialDoneAt: Date.now() };
                window._currentUserProfile = { ...u, ...patch };
                withTimeout(db.collection('users').doc(u.id).set(patch, { merge: true }), 15000, 'saving tutorial progress').catch(err => console.warn('Could not save tutorial progress:', err.message));
                maybeShowOpenShifts(); // held back while the tour ran
            }
        }

        // --- FEEDBACK (from the info popup) ---
        // One doc per submission in `feedback`. Developers triage it from the Dashboard on the
        // DEV site; `status` and an optional public `reply` are set there and shown back here.
        const FEEDBACK_TYPES = { bug: '🐞 Something is broken', idea: '💡 Idea or request', question: '❓ Question', praise: '👍 Something I like', other: '💬 Other' };
        const FEEDBACK_STATUSES = { new: ['New', '#7fd4ff'], reviewing: ['Reviewing', '#ffb020'], planned: ['Planned', 'var(--neon-teal)'], done: ['Done', 'var(--neon-saguaro)'], declined: ["Won't do", 'var(--text-muted)'] };
        function openFeedback() {
            document.getElementById('fbType').innerHTML = Object.keys(FEEDBACK_TYPES).map(k => `<option value="${k}">${FEEDBACK_TYPES[k]}</option>`).join('');
            document.getElementById('fbMessage').value = '';
            document.getElementById('fbCount').textContent = '0';
            document.getElementById('fbThanks').style.display = 'none';
            document.getElementById('feedbackModal').style.display = 'flex';
            loadMyFeedback();
        }
        async function loadMyFeedback() {
            const u = currUser();
            if (!u) return;
            try {
                const snap = await db.collection('feedback').where('uid', '==', u.id).get();
                const mine = snap.docs.map(d => d.data()).sort((a, b) => b.ts - a.ts).slice(0, 5);
                document.getElementById('fbMineWrap').style.display = mine.length ? 'block' : 'none';
                document.getElementById('fbMineList').innerHTML = mine.map(f => {
                    const st = FEEDBACK_STATUSES[f.status] || FEEDBACK_STATUSES.new;
                    return `<div style="padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.06); font-size:0.8rem;">
                        <div style="display:flex; justify-content:space-between; gap:8px;"><span style="color:var(--text-muted);">${escapeHtml(FEEDBACK_TYPES[f.type] || '')} &middot; ${new Date(f.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span><span style="color:${st[1]}; font-weight:700;">${st[0]}</span></div>
                        <div style="margin-top:3px;">${escapeHtml(String(f.message || '').slice(0, 160))}${String(f.message || '').length > 160 ? '…' : ''}</div>
                        ${f.reply ? `<div style="margin-top:4px; padding:6px 8px; border-left:2px solid var(--neon-teal); background:rgba(0,245,212,0.06); color:var(--text-secondary);"><strong>Developer reply:</strong> ${escapeHtml(f.reply)}</div>` : ''}
                    </div>`;
                }).join('');
            } catch (err) { console.warn('Could not load your feedback:', err.message); }
        }
        async function submitFeedback() {
            const u = currUser();
            if (!u) return;
            const type = document.getElementById('fbType').value;
            const message = document.getElementById('fbMessage').value.trim();
            if (message.length < 5) { alert('Please write a little more so we can understand.'); return; }
            const btn = document.getElementById('fbSubmitBtn');
            btn.disabled = true; btn.textContent = 'Sending…';
            const dev = deviceInfo();
            const id = 'f' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            const doc = { id, ts: Date.now(), uid: u.id, user: u.name || '', role: u.role || '', type, message: message.slice(0, 2000), status: 'new', view: _lastTrackedView || '', platform: dev.platform, installed: dev.installed, env: IS_DEV_SITE ? 'dev' : 'prod' };
            try {
                await saveDoc('feedback', id, doc);
                logEvent('feedback_submitted', 'Submitted feedback: ' + (FEEDBACK_TYPES[type] || type).replace(/^\S+\s/, ''), { feedbackId: id });
                document.getElementById('fbMessage').value = '';
                document.getElementById('fbCount').textContent = '0';
                document.getElementById('fbThanks').style.display = 'block';
                loadMyFeedback();
            } catch (err) { /* saveDoc already alerted */ }
            finally { btn.disabled = false; btn.textContent = 'Send Feedback'; }
        }

        function maybeShowWelcome() {
            if (maybeRequireTerms()) return; // updated Terms come first; accepting them calls this again
            try {
                const store = (typeof localStorage !== 'undefined') ? localStorage : sessionStorage;
                if (!store.getItem('ss_welcomeSeen')) {
                    document.getElementById('welcomeModal').style.display = 'flex';
                }
            } catch (err) {
                // Storage blocked entirely - just show it once for this load and move on.
                document.getElementById('welcomeModal').style.display = 'flex';
            }
            afterWelcome(); // no-ops while the welcome popup is up
        }
        function dismissWelcome() {
            try {
                const store = (typeof localStorage !== 'undefined') ? localStorage : sessionStorage;
                store.setItem('ss_welcomeSeen', '1');
            } catch (err) { /* no persistent storage available - nothing more we can do */ }
            closeModal('welcomeModal');
            afterWelcome();
        }

        // First-run order: Terms (if needed) -> Welcome popup -> guided tour (once per person) ->
        // open-shifts popup. The tour hands over to the open-shifts popup when it ends.
        function afterWelcome() {
            const welcome = document.getElementById('welcomeModal');
            if (welcome && welcome.style.display === 'flex') return;
            const u = currUser();
            if (u && !window._termsPending && !window._tourActive && !tutorialDoneFor(u)) { startTour(false); return; }
            maybeShowOpenShifts();
        }

        // OPEN-SHIFTS SUMMARY: once per period (daily / weekly / monthly - see settings below) per user, list every
        // upcoming shift/position the user could still claim. Only marked as seen when
        // they press "Acknowledge open shifts" (no X, no backdrop dismiss), so a
        // refresh mid-popup brings it back. Nothing shows when there's nothing open.
        // Team-wide settings (Command Center > Users): on/off and how often it reappears.
        // Stored in settings/openShifts; defaults to on + daily when nothing has been saved.
        const OPEN_SHIFTS_FREQUENCIES = {
            daily: { label: 'Daily', note: 'This summary shows once a day.' },
            weekly: { label: 'Weekly', note: 'This summary shows once a week.' },
            monthly: { label: 'Monthly', note: 'This summary shows once a month.' }
        };
        function getOpenShiftsSettings() {
            const s = getDB('settings').find(x => x.id === 'openShifts') || {};
            return { enabled: s.enabled !== false, frequency: OPEN_SHIFTS_FREQUENCIES[s.frequency] ? s.frequency : 'daily' };
        }
        // Start of the current period in the person's local time: today 12:00 AM, this
        // Monday 12:00 AM, or the 1st of this month 12:00 AM.
        function openShiftsPeriodStart(freq) {
            const now = new Date();
            const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            if (freq === 'weekly') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
            else if (freq === 'monthly') d.setDate(1);
            return d.getTime();
        }
        function openShiftsAckAtKey(u) { return 'ss_openShiftsAckAt_' + (u.id || u.name); }
        // When this device last acknowledged (ms). Also understands the old "YYYY-MM-DD" format.
        function lastOpenShiftsAck(u) {
            try {
                const v = Number(localStorage.getItem(openShiftsAckAtKey(u)));
                if (v) return v;
                const legacy = localStorage.getItem(openShiftsKey(u));
                if (/^\d{4}-\d{2}-\d{2}$/.test(legacy || '')) { const [y, m, d] = legacy.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
            } catch (err) { /* storage blocked */ }
            return 0;
        }
        function openShiftsKey(u) { return 'ss_openShiftsAck_' + (u.id || u.name); }
        function todayKey() {
            const d = new Date();
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }
        function getOpenShiftsForUser(u) {
            const out = [];
            getDB('events').filter(e => !e.archived && !e.hidden && !e.cancelled && daysSinceEvent(e) <= 0)
                .sort((a, b) => new Date(a.date) - new Date(b.date))
                .forEach(e => {
                    if ((e.guards || []).includes(u.name)) return;
                    let items = [];
                    if (e.positions && e.positions.length) {
                        e.positions.forEach(p => {
                            const left = (p.slots || 0) - positionFilled(e, p.name);
                            const eligible = !(p.allowedRoles && p.allowedRoles.length) || p.allowedRoles.includes(u.role);
                            if (left > 0 && eligible) items.push(`${p.name} (${left} open)`);
                        });
                    } else if ((e.openSlots || 0) > 0) {
                        items.push(`General shift (${e.openSlots} open)`);
                    }
                    if (items.length) out.push({ e, items });
                });
            return out;
        }
        function maybeShowOpenShifts() {
            try {
                const u = currUser();
                if (!u) return;
                if (window._termsPending) return;
                if (u.openShiftsPopupOff) return; // an admin turned the popup off for this person
                const osSettings = getOpenShiftsSettings();
                if (!osSettings.enabled) return; // ...or for the whole team
                const welcome = document.getElementById('welcomeModal');
                if (welcome && welcome.style.display === 'flex') return; // dismissWelcome() calls us again
                if (lastOpenShiftsAck(u) >= openShiftsPeriodStart(osSettings.frequency)) return; // already acknowledged this period
                const shifts = getOpenShiftsForUser(u);
                if (!shifts.length) return;
                document.getElementById('openShiftsList').innerHTML = shifts.map(({ e, items }) => `
                    <div style="background:rgba(12,12,18,0.7); border:1px solid var(--border-glass); border-radius:14px; padding:14px 16px;">
                        <div style="font-family:'Outfit'; font-weight:700; font-size:1.02rem; margin-bottom:2px;">${e.title}</div>
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:8px;">🗓️ ${e.date}${e.startTime ? ' · ' + e.startTime : ''}</div>
                        <ul style="margin:0 0 12px 18px; padding:0; font-size:0.85rem; color:var(--text-secondary); line-height:1.6;">${items.map(i => `<li>${i}</li>`).join('')}</ul>
                        <button class="btn btn-sm" onclick="goToOpenShift('${e.id}')">View &amp; Sign Up</button>
                    </div>`).join('');
                document.getElementById('openShiftsFreqNote').textContent = OPEN_SHIFTS_FREQUENCIES[osSettings.frequency].note;
                document.getElementById('openShiftsModal').style.display = 'flex';
                logEvent('open_shifts_shown', 'Open-shifts summary shown', { shifts: shifts.length });
                document.getElementById('openShiftsSheet').scrollTop = 0;
            } catch (err) { console.error('Open shifts popup failed:', err); }
        }
        function goToOpenShift(id) {
            // Following a link counts as acting on the summary, so it's acknowledged
            // for the day the same as pressing the button.
            acknowledgeOpenShifts('link', id);
            openEventDetail(id);
        }
        function acknowledgeOpenShifts(via, eventId) {
            const u = currUser();
            logEvent('shift_ack', 'Acknowledged open shifts', { via: via || 'button', eventId: eventId || '' });
            try { if (u) localStorage.setItem(openShiftsAckAtKey(u), String(Date.now())); } catch (err) { /* storage blocked - shows again next load */ }
            closeModal('openShiftsModal');
        }
        function changePin() {
            const np = document.getElementById('newPinInput').value.trim();
            if (!np || np.length < 4) { alert('PIN must be at least 4 characters.'); return; }
            const u = currUser();
            if (!u) return;
            const updated = { ...u, pin: np };
            saveDoc('users', u.id, updated).then(() => {
                window._currentUserProfile = updated;
                alert('PIN saved.');
                document.getElementById('newPinInput').value = '';
                logAction('Changed own admin PIN');
            });
        }

        /* CHAT */
        let actChan = 'general';
        function renderChat() { document.getElementById('chatDropdown').innerHTML = getDB('channels').map(c => `<option value="${c}" ${c === actChan ? 'selected' : ''}>#${c}</option>`).join(''); document.getElementById('chatTitle').innerText = '# ' + actChan; document.getElementById('chatBox').innerHTML = getDB('chats').filter(c => c.channel === actChan).sort((a, b) => a.id.localeCompare(b.id)).map(c => `<div class="chat-bubble ${c.user === currUser()?.name ? 'mine' : ''}"><div style="font-size:0.72rem; font-weight:600; color:${c.user === currUser()?.name ? '#ff9ee2' : 'var(--neon-teal)'}; margin-bottom:3px;">${c.user}</div><div>${c.text}</div>${c.file ? `<div style="margin-top:6px;"><a href="${c.file}" style="color:var(--text-primary); font-size:0.75rem; font-weight:600;">📎 View File</a></div>` : ''}</div>`).join(''); document.getElementById('chatBox').scrollTop = document.getElementById('chatBox').scrollHeight; markChannelRead(actChan); updateCommsBadge(); }
        function switchChat(c) { actChan = c; renderChat(); }
        function sendChat(fUrl = null) { let v = document.getElementById('chatInput').value; if (v || fUrl) { logEvent('chat_send', 'Sent a chat message', { channel: actChan }); let cm = { id: 'm' + Date.now(), channel: actChan, user: currUser().name, text: v || 'Sent file', file: fUrl }; saveDoc('chats', cm.id, cm); document.getElementById('chatInput').value = ''; } }
        function uploadFile(e) { if (e.target.files[0]) sendChat(URL.createObjectURL(e.target.files[0])); }
