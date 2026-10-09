        // --- ENVIRONMENT: PROD (the normal address) vs DEV (the same address + /dev/) ---
        // Both run this same code against the same Firebase project. See docs/ENVIRONMENTS.md.
        const IS_DEV_SITE = /\/dev(\/|$)/.test(location.pathname);
        const PROD_URL = new URL(IS_DEV_SITE ? '../' : './', location.href).href;
        const DEV_URL = new URL('dev/', PROD_URL).href;

        // --- 3. GLOBAL STATE ---
        window.ss_state = { events: [], users: [], channels: [], chats: [], promoters: [], banlist: [], tags: [], roles: [], announcement: [], pushes: [], settings: [] };
        const allCollections = ['events', 'users', 'channels', 'chats', 'promoters', 'banlist', 'tags', 'roles', 'announcement', 'pushes', 'settings'];
        const getDB = k => window.ss_state[k] || [];

        // --- 3b. SAFE WRITE HELPER (fixes silent-fail / undefined-field save bug) ---
        // JSON round-trip strips `undefined` values (Firestore rejects them outright,
        // which was silently killing entire writes any time one field was unset).
        function cleanData(obj) { return JSON.parse(JSON.stringify(obj)); }

        // Safely embeds a value inside a single-quoted JS string literal within
        // an inline onclick/onchange handler (e.g. onclick="fn('${jsStr(name)}')").
        // Backslashes MUST be escaped before quotes - escaping quotes alone lets
        // a literal backslash in the value (a name ending in one, a pasted note,
        // etc.) combine with the very quote-escaping backslash this inserts,
        // breaking out of the string instead of just being a backslash.
        function jsStr(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

        // If Firestore genuinely never responds (blocked by a firewall/ad
        // blocker, an expired auth session, a misconfigured project, etc.)
        // the SDK's own promise can hang indefinitely with no error at all -
        // that's what produced a permanent "Saving..." with nothing in the
        // console and no alert. This forces a definitive failure after 15s so
        // every write/delete in the app gets a clear signal instead of a
        // silent, endless spinner.
        function withTimeout(promise, ms, label) {
            let timer;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(
                    `Timed out after ${ms / 1000}s waiting for ${label}. This usually means the browser can't reach Firestore - check your internet connection, disable any ad blocker/privacy extension for this site, and confirm your Firestore rules are actually published (not just written locally).`
                )), ms);
            });
            return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
        }

        function saveDoc(col, id, data) {
            const payload = cleanData(data);
            return withTimeout(db.collection(col).doc(id).set(payload), 15000, `saving to ${col}`)
                // Same fix applied to events: don't trust the local optimistic
                // write as proof of success. Explicitly re-read from the
                // server to confirm it actually landed - this is what was
                // missing here, and why a user/contact edit could report
                // success and then vanish on refresh.
                .then(() => withTimeout(db.collection(col).doc(id).get({ source: 'server' }), 15000, `confirming save to ${col}`))
                .then(snap => {
                    if (!snap.exists) throw new Error(`Document unexpectedly missing on the server right after saving to ${col}.`);
                    return snap;
                })
                .catch(err => {
                    console.error(`Save failed [${col}/${id}]:`, err);
                    alert('⚠️ Save failed: ' + err.message);
                    throw err;
                });
        }
        function deleteDoc(col, id) {
            return withTimeout(db.collection(col).doc(id).delete(), 15000, `deleting from ${col}`).catch(err => {
                console.error(`Delete failed [${col}/${id}]:`, err);
                alert('⚠️ Delete failed: ' + err.message);
                throw err;
            });
        }

        // --- ACTIVITY LOG ---
        // One document per event in `logs`, ids like "l<13-digit ms timestamp>_<rand>" so
        // they sort (and can be range-queried) by time. `logs` is deliberately NOT in
        // allCollections: it grows without bound, so only the admin Logs tab ever reads
        // it, on demand, for a chosen date range. `presence/{uid}` holds one small
        // "last seen" doc per person. Both writes are fire-and-forget and silent: a failed
        // log must never alert the user or slow the app down.
        //   type: session_start | session_resume | login | logout | view | event_view |
        //         open_shifts_shown | shift_ack | shift_claim | shift_drop | chat_send |
        //         push_open | register | action (everything else)
        const SESSION_ID = Math.random().toString(36).slice(2, 10);
        const RESUME_GAP_MS = 5 * 60 * 1000;     // away this long, then back = "checked the app again"
        const PRESENCE_EVERY_MS = 15 * 60 * 1000; // at most one presence write per 15 min of use
        let _lastLogSig = '', _lastLogAt = 0, _presenceAt = 0, _lastHiddenAt = 0, _sessionStarted = false, _lastTrackedView = '';

        function dayKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
        // Who is acting. Falls back to the raw Firebase sign-in for the moment between
        // signing in and the profile finishing loading.
        function logActor() {
            const u = currUser();
            if (u) return { uid: u.id, user: u.name || u.email || 'Unknown' };
            const a = auth.currentUser;
            return a ? { uid: a.uid, user: a.email || 'Unknown' } : null;
        }
        function deviceInfo() {
            const ua = navigator.userAgent || '';
            const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
            const platform = ios ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac|Windows|Linux|CrOS/.test(ua) ? 'Desktop' : 'Other';
            const installed = !!((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);
            let pushOn = false;
            try { pushOn = localStorage.getItem('ss_pushOn') === '1'; } catch (err) { /* storage blocked */ }
            return { platform, installed, notif: (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported', pushOn };
        }
        function logEvent(type, action, meta) {
            try {
                const actor = logActor();
                if (!actor) return Promise.resolve();
                const now = Date.now();
                const sig = type + '|' + action;
                if (sig === _lastLogSig && now - _lastLogAt < 3000) return Promise.resolve(); // double-tap / double-fire guard
                _lastLogSig = sig; _lastLogAt = now;
                const id = 'l' + now + '_' + Math.random().toString(36).slice(2, 6);
                const doc = { id, ts: now, day: dayKey(new Date(now)), time: new Date(now).toLocaleTimeString(), uid: actor.uid, user: actor.user, type, action, sid: SESSION_ID, env: IS_DEV_SITE ? 'dev' : 'prod' };
                if (meta) doc.meta = meta;
                return withTimeout(db.collection('logs').doc(id).set(cleanData(doc)), 15000, 'activity log')
                    .catch(err => console.warn('Activity log write failed (ignored):', err.message));
            } catch (err) { return Promise.resolve(); }
        }
        // Existing call sites: logAction('text'). New ones can pass a type and extra details.
        const logAction = (act, type, meta) => logEvent(type || 'action', act, meta);

        // "Last seen" doc for the adoption dashboard (one small doc per person).
        function touchPresence(force, countOpen) {
            try {
                if (IS_DEV_SITE) return; // developer testing shouldn't change anyone's "last seen"
                const actor = logActor();
                if (!actor) return;
                const now = Date.now();
                if (!force && now - _presenceAt < PRESENCE_EVERY_MS) return;
                _presenceAt = now;
                const data = { uid: actor.uid, name: actor.user, lastSeen: now, ...deviceInfo() };
                if (countOpen) data.opens = firebase.firestore.FieldValue.increment(1);
                db.collection('presence').doc(actor.uid).set(data, { merge: true }).catch(err => console.warn('Presence write failed (ignored):', err.message));
            } catch (err) { /* never break the app over analytics */ }
        }
        // Called once per page load, after the signed-in profile is loaded.
        function trackSessionStart() {
            if (_sessionStarted) return;
            _sessionStarted = true;
            logEvent('session_start', 'Opened the app', deviceInfo());
            if (window._justSignedIn) { window._justSignedIn = false; logEvent('login', 'Signed in'); }
            touchPresence(true, true);
        }
        // Phone apps usually stay alive in the background, so coming back to the
        // foreground after a while is the real "checked the app" moment.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') { _lastHiddenAt = Date.now(); return; }
            if (_sessionStarted && _lastHiddenAt && Date.now() - _lastHiddenAt > RESUME_GAP_MS) {
                logEvent('session_resume', 'Returned to the app', { awayMin: Math.round((Date.now() - _lastHiddenAt) / 60000) });
                touchPresence(true, true);
            }
        });
        const VIEW_NAMES = { eventsFeed: 'Events', eventsFeedView: 'Events', calendarView: 'Calendar', teamChatView: 'Comms', banListView: 'Ban List', myShiftsView: 'My Shifts', contactsDirectoryView: 'Promoter Directory', licensesView: 'Licenses', dashboardView: 'Dashboard', settingsView: 'Settings', adminConsoleView: 'Admin Console' };
        function trackView(v) {
            const name = VIEW_NAMES[v];
            if (!name || name === _lastTrackedView) return;
            _lastTrackedView = name;
            logEvent('view', 'Viewed ' + name, { view: name });
            touchPresence(false, false);
        }

        // --- NEW-USER EMAIL NOTICE (via the Firebase "Trigger Email" extension) ---
        // This app has no server of its own, so it can't send email directly.
        // Instead it writes a document shaped the way that extension expects
        // into a `mail` collection; once the extension is installed on this
        // Firebase project (Firebase Console -> Extensions -> "Trigger Email",
        // configured with an SMTP connection) it picks the doc up and sends it
        // for real. Until then, these documents just sit in Firestore unsent -
        // harmless, but no email actually goes out.
        const SYSTEM_ADMIN_EMAIL = 'howlhousemedia@gmail.com';
        function notifySystemAdminOfNewUser(profile) {
            const roleLabel = profile.role || 'No rank assigned';
            const when = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
            const row = (label, value, valueColor) => `<tr><td style="color:#8a8a94; font-size:13px; padding:7px 0; border-bottom:1px solid #22222c; font-family:Arial,Helvetica,sans-serif;">${label}</td><td style="color:${valueColor || '#ffffff'}; font-size:13px; padding:7px 0; border-bottom:1px solid #22222c; text-align:right; font-weight:600; font-family:Arial,Helvetica,sans-serif;">${value}</td></tr>`;
            const html = `
                <div style="background:#08080c; padding:32px 16px; font-family:Arial,Helvetica,sans-serif;">
                    <table role="presentation" width="100%" style="max-width:460px; margin:0 auto; background:#111118; border-radius:16px; overflow:hidden; border:1px solid #2a2a35;">
                        <tr><td style="background:#0c0c12; padding:24px 28px; text-align:center; border-bottom:1px solid #2a2a35;">
                            <div style="color:#00f5d4; font-size:20px; font-weight:800; letter-spacing:1px;">SUZAN'S SECURITY</div>
                            <div style="color:#777; font-size:11px; letter-spacing:2px; text-transform:uppercase; margin-top:4px;">Phoenix Staff Portal</div>
                        </td></tr>
                        <tr><td style="padding:28px;">
                            <p style="color:#ffffff; font-size:15px; margin:0 0 18px; line-height:1.5;">A new officer has registered with the app. Here's what was submitted:</p>
                            <table role="presentation" width="100%" style="border-collapse:collapse; margin-bottom:20px;">
                                ${row('Name', profile.name || 'Not provided')}
                                ${row('Email', profile.email || 'Not provided')}
                                ${row('Phone', profile.phone || 'Not provided')}
                                ${row('Rank', roleLabel, '#00f5d4')}
                                ${row('Joined', when)}
                            </table>
                            <p style="color:#9a9aa4; font-size:13px; line-height:1.6; margin:0;">You can review, promote, or remove this account anytime from Command Center &rarr; Users.</p>
                        </td></tr>
                        <tr><td style="padding:16px 28px; background:#0c0c12; text-align:center; border-top:1px solid #2a2a35;">
                            <div style="color:#555; font-size:10px; text-transform:uppercase; letter-spacing:1px;">Created and Managed by HowlHouse</div>
                        </td></tr>
                    </table>
                </div>`;
            const text = `A new officer has registered with Suzan's Security.\n\nName: ${profile.name || 'Not provided'}\nEmail: ${profile.email || 'Not provided'}\nPhone: ${profile.phone || 'Not provided'}\nRank: ${roleLabel}\nJoined: ${when}\n\nReview this account from Command Center -> Users.`;
            db.collection('mail').add({
                to: [SYSTEM_ADMIN_EMAIL],
                message: { subject: `New Officer Registered: ${profile.name || profile.email}`, text, html }
            }).catch(err => console.error('Failed to queue new-user notification email:', err));
        }

