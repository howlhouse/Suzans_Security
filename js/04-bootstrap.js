        // --- 4. LOADING SCREEN: real progress, not a fake timer ---
        let isUILoaded = false;
        let totalLoadSteps = allCollections.length + 1; // +1 for the auth handshake
        let doneLoadSteps = 0;
        const HARD_LOAD_TIMEOUT_MS = 20000; // absolute ceiling per requirement

        function bumpProgress(stepLabel) {
            doneLoadSteps = Math.min(totalLoadSteps, doneLoadSteps + 1);
            const pct = Math.round((doneLoadSteps / totalLoadSteps) * 100);
            const fill = document.getElementById('loadProgressFill');
            const pctEl = document.getElementById('loadProgressPct');
            const stepEl = document.getElementById('loadStepText');
            if (fill) fill.style.width = pct + '%';
            if (pctEl) pctEl.innerText = pct + '%';
            if (stepEl && stepLabel) stepEl.innerText = stepLabel;
        }

        function dropLoadingScreen() {
            if (!isUILoaded) {
                isUILoaded = true;
                bumpProgress('Ready.');
                const overlay = document.getElementById('loadingOverlay');
                overlay.style.opacity = '0';
                setTimeout(() => { overlay.style.display = 'none'; }, 400);
                refreshGlobalUI();
                if (window._currentUserProfile) setTimeout(maybeShowWelcome, 600);
            }
        }

        // FIX for "blank portal that fills in a moment later" AND "reverts to
        // Neon Circuit on refresh": both bugs had the same root cause. Firestore's
        // onSnapshot can fire an empty result from local cache for an instant
        // before the real server data arrives. The old code treated that very
        // first callback as "fully loaded," which (a) sometimes showed an empty
        // UI that then popped in real data a moment later, and (b) sometimes
        // made the app wrongly conclude "this database is empty" and re-run the
        // seed script - wiping out edits to the "Neon Circuit" event.
        //
        // Fix: do one explicit, authoritative, SERVER-sourced read of every
        // collection before showing anything, and gate seeding behind a
        // permanent "_meta/seedStatus" flag document instead of guessing from
        // collection size. Seeding can now only ever happen once, ever.
        async function initialLoad() {
            try {
                const seedDoc = await db.collection('_meta').doc('seedStatus').get({ source: 'server' }).catch(() => null);
                const alreadySeeded = !!(seedDoc && seedDoc.exists && seedDoc.data().seeded === true);

                await Promise.all(allCollections.map(col =>
                    db.collection(col).get({ source: 'server' }).then(snap => {
                        window.ss_state[col] = snap.docs.map(d => col === 'channels' ? d.id : d.data());
                        bumpProgress('Loaded ' + col + '...');
                    })
                ));

                if (!alreadySeeded) {
                    await seedDatabase();
                    await db.collection('_meta').doc('seedStatus').set({ seeded: true, at: Date.now() });
                }

                // Tag management used to be a hardcoded list in the app, not a
                // real Firestore collection. For an existing installation the
                // new `tags` collection starts out empty (the full-database
                // seed above only ever runs once, on a genuinely fresh
                // database). Backfill it independently, exactly once, so
                // existing events keep working with the same tag options as
                // before instead of suddenly having none to pick from.
                if (window.ss_state.tags.length === 0) {
                    await Promise.all(DEFAULT_TAGS.map(name => saveDoc('tags', tagToId(name), { id: tagToId(name), name })));
                    window.ss_state.tags = DEFAULT_TAGS.map(name => ({ id: tagToId(name), name }));
                }

                // Same backfill for the roles/ranks catalog - a brand new
                // collection for existing installations that predate ranks.
                if (window.ss_state.roles.length === 0) {
                    await Promise.all(DEFAULT_ROLES.map(name => saveDoc('roles', roleToId(name), { id: roleToId(name), name })));
                    window.ss_state.roles = DEFAULT_ROLES.map(name => ({ id: roleToId(name), name }));
                }

                dropLoadingScreen();
            } catch (err) {
                console.error('Initial load failed:', err);
                document.getElementById('loadStepText').innerText = 'Load error: ' + err.message;
                document.getElementById('loadWarnText').style.display = 'block';
                dropLoadingScreen();
            }
            attachRealtimeListeners(); // live updates going forward, regardless of outcome above

            // Catch anything that's already 2+ days past its date the moment
            // we have data to check, then keep checking hourly for events that
            // cross that threshold while the app stays open. Guarded so a
            // second initialLoad() call (there isn't one today, but just in
            // case) can't stack up duplicate intervals.
            try { runAutoArchiveSweep(); } catch (err) { console.error('Initial auto-archive sweep failed:', err); }
            if (!window._archiveSweepIntervalStarted) {
                window._archiveSweepIntervalStarted = true;
                setInterval(() => { try { runAutoArchiveSweep(); } catch (err) { console.error('Auto-archive sweep failed:', err); } }, 60 * 60 * 1000);
            }

            // Announcement banner: the authoritative Firestore flip (enabled -> false)
            // only needs to happen occasionally (any client can do it), but every
            // client should stop *displaying* an expired banner right away rather
            // than waiting up to an hour - hence the separate, much shorter interval
            // for just the render check below.
            try { runAnnouncementExpirySweep(); } catch (err) { console.error('Initial announcement expiry sweep failed:', err); }
            if (!window._annExpirySweepIntervalStarted) {
                window._annExpirySweepIntervalStarted = true;
                setInterval(() => { try { runAnnouncementExpirySweep(); } catch (err) { console.error('Announcement expiry sweep failed:', err); } }, 60 * 60 * 1000);
            }
            if (!window._annBannerIntervalStarted) {
                window._annBannerIntervalStarted = true;
                setInterval(() => { try { renderAnnouncementBanner(); } catch (err) { console.error('Announcement banner render failed:', err); } }, 30 * 1000);
            }
        }

        function attachRealtimeListeners() {
            allCollections.forEach(col => {
                let firstFire = true;
                db.collection(col).onSnapshot(snap => {
                    if (!firstFire) {
                        snap.docChanges().forEach(change => {
                            if (change.type === 'added') {
                                const data = change.doc.data();
                                if (col === 'events' && !data.hidden) notifyUser("🚨 New Deployment Posted", data.title, 'shifts');
                                if (col === 'chats' && data.user !== currUser()?.name) {
                                    let chanClean = data.channel.replace('evt_', 'Event ');
                                    notifyUser(`💬 ${data.user} in #${chanClean}`, data.text, 'chat');
                                }
                                // New-user notice, restricted to Commanders. This fires
                                // independently on every open client - each one just
                                // checks its own signed-in user's rank before showing
                                // anything, so only Commanders actually see it, and only
                                // while they have the app open (same as every other
                                // notification here - there's no server-side push).
                                if (col === 'users' && data.id !== currUser()?.id && currUser()?.role === 'Commander') {
                                    notifyUser('New User Added', `${data.name || data.email} joined as ${data.role || 'no rank assigned'}.`, 'admin');
                                }
                            }
                        });
                    }
                    firstFire = false;
                    window.ss_state[col] = snap.docs.map(d => col === 'channels' ? d.id : d.data());
                    refreshGlobalUI();
                }, err => console.error(`Listener error [${col}]:`, err));
            });
        }

        function seedDatabase() {
            return Promise.all([
                saveDoc('channels', 'general', { name: 'general' }),
                saveDoc('promoters', 'p1', { id: 'p1', name: 'Dax', phone: '555-1234', email: 'dax@club.com', instagram: '', website: '', venueLink: '', tags: ['VIP'], notes: [{ date: '2026-09-08', text: 'Great payer.' }] }),
                saveDoc('events', 'e1', {
                    id: 'e1', title: 'Neon Circuit', date: '2026-09-15', tags: ['NSFW', 'Club', 'Kink'],
                    desc: 'Main door watch.', address: '', timeline: [], openSlots: 2, guards: [], guardPosts: {}, guardNotes: {}, positions: [],
                    promoterIds: ['p1'], ticketLink: '', communityOnly: false,
                    image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=700',
                    layout: ['img', 'info', 'tags', 'logistics', 'roster']
                }),
                ...DEFAULT_TAGS.map(name => saveDoc('tags', tagToId(name), { id: tagToId(name), name })),
                ...DEFAULT_ROLES.map(name => saveDoc('roles', roleToId(name), { id: roleToId(name), name }))
            ]);
        }

        function refreshGlobalUI() {
            validateSession();
            updateDockForUser();
            updateCommsBadge();
            try { scheduleShiftReminders(); } catch (err) { console.error('Reminder scheduling failed:', err); }
            try { renderAnnouncementBanner(); } catch (err) { console.error('Announcement banner render failed:', err); }
            renderEvents();
            if (document.getElementById('eventDetailView').style.display !== 'none' && activeDetailId) renderEventDetail(activeDetailId);
            if (document.getElementById('calendarView').style.display !== 'none') renderCal();
            if (document.getElementById('teamChatView').style.display !== 'none') renderChat();
            if (document.getElementById('banListView').style.display !== 'none') renderBanList();
            if (document.getElementById('myShiftsView').style.display !== 'none') renderMyShiftsView();
            if (document.getElementById('settingsView').style.display !== 'none') renderSettings();
            if (document.getElementById('adminConsoleView').style.display !== 'none') {
                if (!currUser()?.isAdmin) { switchView('eventsFeed'); return; } // demoted mid-session - bounce out
                if (document.getElementById('adminEvents').style.display === 'block') renderAdminEv();
                if (document.getElementById('adminArchive').style.display === 'block') renderArchive();
                if (document.getElementById('adminChats').style.display === 'block') renderAdminChats();
                if (document.getElementById('adminTags').style.display === 'block') { renderAdminTags(); renderAdminRoles(); }
                if (document.getElementById('adminLogs').style.display === 'block') renderLogs();
                if (document.getElementById('adminUsers').style.display === 'block') renderUsers();
                if (document.getElementById('adminContacts').style.display === 'block') renderContacts();
            }
        }

