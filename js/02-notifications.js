        // --- 2. NOTIFICATION ENGINE ---
        function requestNotificationPermission() {
            if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
                Notification.requestPermission();
            }
        }
        function notifyUser(title, body, type) {
            const prefs = currUser()?.notifPrefs;
            if (type === 'shifts' && prefs && prefs.shifts === false) return;
            if (type === 'chat' && prefs && prefs.chat === false) return;
            if (type === 'reminder' && prefs && prefs.reminder90 === false) return;
            if ("Notification" in window && Notification.permission === "granted") {
                new Notification(title, { body: body, icon: 'Suzans_Security_Icon_192.png' });
            }
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

