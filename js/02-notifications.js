        // --- 2. NOTIFICATION ENGINE ---
        function requestNotificationPermission() {
            if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
                Notification.requestPermission();
            }
        }
        function notifyUser(title, body, type, onClick) {
            const prefs = currUser()?.notifPrefs;
            if (type === 'shifts' && prefs && prefs.shifts === false) return;
            if (type === 'chat' && prefs && prefs.chat === false) return;
            if (type === 'reminder' && prefs && prefs.reminder90 === false) return;
            if ("Notification" in window && Notification.permission === "granted") {
                const n = new Notification(title, { body: body, icon: 'Suzans_Security_Icon_192.png' });
                if (onClick) n.onclick = () => { window.focus(); onClick(); n.close(); };
            }
        }

        // --- 2c. ADMIN-SENT PUSH NOTIFICATIONS ---
        // Admins schedule these from Command Center > System (stored in the
        // `pushes` collection with a sendAt timestamp). Same caveat as every other
        // notification in this app: there's no server-side push, so delivery
        // happens on each user's device while the app is open - a check runs on
        // every data refresh and every 30s. A push whose time passed while the user
        // was away is delivered on their next open, up to PUSH_CATCHUP_MS late;
        // anything older is skipped so a new device doesn't get a pile of stale alerts.
        // Each device remembers what it already showed (localStorage) so nothing repeats.
        const PUSH_CATCHUP_MS = 24 * 60 * 60 * 1000;
        function getShownPushIds() {
            try { return JSON.parse(localStorage.getItem('ss_pushShown') || '[]'); } catch (err) { return []; }
        }
        function markPushShown(id) {
            try {
                const ids = getShownPushIds();
                if (!ids.includes(id)) ids.push(id);
                localStorage.setItem('ss_pushShown', JSON.stringify(ids.slice(-200)));
            } catch (err) { /* storage blocked - worst case it shows again next load */ }
        }
        function showPushToast(push, open) {
            const wrap = document.getElementById('pushToastWrap') || (() => {
                const d = document.createElement('div');
                d.id = 'pushToastWrap';
                d.style.cssText = 'position:fixed; top:12px; left:12px; right:12px; z-index:3000; display:flex; flex-direction:column; gap:8px; align-items:center; pointer-events:none;';
                document.body.appendChild(d);
                return d;
            })();
            const t = document.createElement('div');
            t.style.cssText = 'pointer-events:auto; max-width:460px; width:100%; background:var(--glass-sheet); border:1px solid var(--neon-teal); border-radius:14px; padding:12px 14px; box-shadow:0 8px 30px rgba(0,0,0,0.5);';
            const h = document.createElement('div');
            h.style.cssText = "font-family:'Outfit'; font-weight:700; color:var(--neon-teal); margin-bottom:2px;";
            h.textContent = '🔔 ' + push.title;
            const b = document.createElement('div');
            b.style.cssText = 'font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;';
            b.textContent = push.body || '';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; gap:8px;';
            if (open) {
                const v = document.createElement('button');
                v.className = 'btn btn-sm'; v.textContent = 'View event';
                v.onclick = () => { t.remove(); open(); };
                row.appendChild(v);
            }
            const x = document.createElement('button');
            x.className = 'btn btn-outline btn-sm'; x.textContent = 'Dismiss';
            x.onclick = () => t.remove();
            row.appendChild(x);
            t.append(h, b, row);
            wrap.appendChild(t);
        }
        function deliverDuePushes() {
            const u = currUser();
            if (!u) return;
            const now = Date.now();
            const shown = getShownPushIds();
            getDB('pushes').forEach(p => {
                if (p.cancelled || shown.includes(p.id)) return;
                if (!p.sendAt || p.sendAt > now || now - p.sendAt > PUSH_CATCHUP_MS) return;
                markPushShown(p.id);
                const ev = p.eventId && getDB('events').find(e => e.id === p.eventId);
                const open = ev ? () => openEventDetail(ev.id) : null;
                // In-app toast always (works without browser permission); OS notification on top when granted.
                showPushToast(p, open);
                notifyUser(p.title, p.body || '', 'push', open);
            });
        }

        // --- 2b. 90-MINUTE-BEFORE-SHIFT REMINDERS ---
        // Client-side scheduling: while the app stays open in a tab, this checks
        // the signed-in user's upcoming shifts and arms a one-shot timer 90
        // minutes ahead of each shift's start time. Guarded by a Set so repeat
        // calls (every realtime update) never double-schedule the same shift.
        // NOTE: like the rest of this app's notifications, this only fires while
        // the browser tab is open - there's no server-side push (that would need
        // a scheduled Cloud Function) - but it covers the common case of staff
        // keeping the app open or checking in periodically.
        window._scheduledReminders = window._scheduledReminders || new Set();
        function scheduleShiftReminders() {
            const u = currUser();
            if (!u || !("Notification" in window)) return;
            if (u.notifPrefs && u.notifPrefs.reminder90 === false) return;
            const now = Date.now();
            myUpcomingShifts().forEach(e => {
                if (!e.startTime) return; // no start time on this shift yet - nothing to count down from
                const key = e.id + '_' + e.date + '_' + e.startTime;
                if (window._scheduledReminders.has(key)) return;
                const startMs = new Date(e.date + 'T' + e.startTime + ':00').getTime();
                if (isNaN(startMs)) return;
                const msUntilReminder = (startMs - 90 * 60 * 1000) - now;
                // Only arm timers for the near-term (next 48h) so we're never
                // stacking up a long-lived setTimeout for a shift weeks away;
                // this re-runs on every refresh so it'll get picked up as it
                // gets closer.
                if (msUntilReminder > 0 && msUntilReminder < 48 * 60 * 60 * 1000) {
                    window._scheduledReminders.add(key);
                    setTimeout(() => {
                        notifyUser('⏰ Shift Starting Soon', `${e.title} starts at ${to12Hour(e.startTime)} — you're on the roster for this one.`, 'reminder');
                    }, msUntilReminder);
                }
            });
        }


        // --- 2d. REAL PUSH (works with the app closed) ---
        // Each device registers with Firebase Cloud Messaging and saves its token in
        // the `pushTokens` collection so a server (Cloud Function / Firebase console)
        // can reach it. Display + tap handling live in sw.js. Opt-in only, from a
        // button in Settings: iPhones require the tap, and they also require the app
        // to be installed to the Home Screen first.
        const VAPID_PUBLIC_KEY = 'BPXVrQgkqbnfPesAZIrTc540lK8RjfT0pilRM5TZrKGtYxMSHzsM5MpQWwWhTH1jsNHvLL-NcCc0swiVMfo97o4';
        function pushSupported() {
            return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && firebase.messaging.isSupported();
        }
        function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
        function isStandalone() { return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches; }
        function getPushRegistration() { return navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready); }
        async function getPushToken() {
            const reg = await getPushRegistration();
            return firebase.messaging().getToken({ vapidKey: VAPID_PUBLIC_KEY, serviceWorkerRegistration: reg });
        }
        async function savePushToken(token) {
            const u = currUser();
            if (!u) return;
            await db.collection('pushTokens').doc(token).set({
                token, userId: u.id, userName: u.name || '', platform: isIOS() ? 'ios' : 'other', updatedAt: Date.now()
            });
            try { localStorage.setItem('ss_pushToken', token); } catch (err) { /* fine */ }
        }
        // Tokens can rotate, so refresh the saved one on each sign-in for devices already opted in.
        async function syncPushToken() {
            try {
                if (!pushSupported() || Notification.permission !== 'granted' || localStorage.getItem('ss_pushOn') !== '1') return;
                await savePushToken(await getPushToken());
            } catch (err) { console.warn('Push token sync failed:', err); }
        }
        function renderPushDeviceStatus() {
            const st = document.getElementById('pushDeviceStatus'), btn = document.getElementById('pushDeviceBtn');
            if (!st || !btn) return;
            let on = false;
            try { on = localStorage.getItem('ss_pushOn') === '1'; } catch (err) { /* ignore */ }
            btn.style.display = '';
            if (isIOS() && !isStandalone()) {
                st.textContent = 'On iPhone/iPad, first tap Share → "Add to Home Screen", then open the app from your Home Screen and enable notifications here.';
                btn.style.display = 'none';
            } else if (!pushSupported()) {
                st.textContent = 'This browser doesn\'t support phone notifications.';
                btn.style.display = 'none';
            } else if (Notification.permission === 'denied') {
                st.textContent = 'Notifications are blocked for this app. Re-enable them in your device or browser settings, then come back.';
                btn.style.display = 'none';
            } else if (on && Notification.permission === 'granted') {
                st.textContent = '✅ Enabled on this device.';
                btn.textContent = 'Turn off on this device';
            } else {
                st.textContent = 'Not enabled on this device.';
                btn.textContent = 'Enable on this device';
            }
        }
        async function togglePushOnDevice() {
            const btn = document.getElementById('pushDeviceBtn');
            btn.disabled = true;
            try {
                if (localStorage.getItem('ss_pushOn') === '1') {
                    const token = localStorage.getItem('ss_pushToken');
                    try { await firebase.messaging().deleteToken(); } catch (err) { console.warn(err); }
                    if (token) await db.collection('pushTokens').doc(token).delete().catch(() => {});
                    localStorage.removeItem('ss_pushOn'); localStorage.removeItem('ss_pushToken');
                } else {
                    const perm = await Notification.requestPermission();
                    if (perm !== 'granted') { alert('Notifications weren\'t allowed, so phone notifications stay off.'); return; }
                    await savePushToken(await getPushToken());
                    localStorage.setItem('ss_pushOn', '1');
                }
            } catch (err) {
                console.error('Push toggle failed:', err);
                alert('Could not change phone notifications: ' + err.message);
            } finally {
                btn.disabled = false;
                renderPushDeviceStatus();
            }
        }
        // Tapping a push opens the app at ?event=<id>; jump straight to that event.
        function handlePushDeepLink() {
            try {
                const id = new URLSearchParams(location.search).get('event');
                if (id && getDB('events').some(e => e.id === id)) {
                    history.replaceState(null, '', location.pathname);
                    openEventDetail(id);
                }
            } catch (err) { console.warn('Deep link failed:', err); }
        }
