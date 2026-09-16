        // --- USER NAME DROPDOWN (Settings / Sign Out) ---
        function toggleUserMenu(evt) {
            evt.stopPropagation(); // don't let this bubble straight into the document click-outside handler below
            const dd = document.getElementById('userMenuDropdown');
            dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
        }
        function closeUserMenu() { document.getElementById('userMenuDropdown').style.display = 'none'; }
        document.addEventListener('click', evt => {
            const wrap = document.getElementById('userMenuWrap');
            if (wrap && !wrap.contains(evt.target)) closeUserMenu();
        });

        // Same pattern as the user menu above, for the small "Add to Calendar"
        // dropdown on the event detail view (Google Calendar vs. .ics).
        function toggleCalMenu(evt) {
            evt.stopPropagation();
            const dd = document.getElementById('calMenuDropdown');
            if (dd) dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
        }
        function closeCalMenu() {
            const dd = document.getElementById('calMenuDropdown');
            if (dd) dd.style.display = 'none';
        }
        document.addEventListener('click', evt => {
            const wrap = document.getElementById('calMenuWrap');
            if (wrap && !wrap.contains(evt.target)) closeCalMenu();
        });

        // --- UNREAD CHAT TRACKING ---
        // Tracked per-device (localStorage) rather than in Firestore - this is
        // read-position bookkeeping, not data worth syncing across devices, and
        // keeping it local avoids a write on every single message view.
        // Message ids are 'm' + Date.now(), so plain string comparison sorts
        // them chronologically the same way the rest of the app already relies
        // on for chat ordering.
        function lastReadKey(channel) {
            const u = currUser();
            return `ss_lastRead::${u ? u.id : 'anon'}::${channel}`;
        }
        function getLastRead(channel) { return localStorage.getItem(lastReadKey(channel)) || ''; }
        function markChannelRead(channel) {
            const msgs = getDB('chats').filter(c => c.channel === channel);
            if (!msgs.length) return;
            const latestId = msgs.reduce((max, m) => (m.id > max ? m.id : max), '');
            if (latestId) localStorage.setItem(lastReadKey(channel), latestId);
        }
        function unreadCount(channel) {
            const u = currUser();
            const lastRead = getLastRead(channel);
            return getDB('chats').filter(c => c.channel === channel && c.id > lastRead && c.user !== u?.name).length;
        }
        function updateCommsBadge() {
            const badge = document.getElementById('commsBadge');
            if (!badge) return;
            const total = getDB('channels').reduce((sum, c) => sum + unreadCount(c), 0);
            badge.innerText = total > 99 ? '99+' : total;
            badge.style.display = total > 0 ? 'flex' : 'none';
        }

        // Shows/hides the 🔒 Admin dock icon based on the signed-in user's
        // admin status. Called after login and on every realtime refresh,
        // so an admin demoted mid-session loses the icon immediately too.
        function updateDockForUser() {
            const u = currUser();
            const btn = document.getElementById('dockAdminBtn');
            if (btn) btn.style.display = (u && u.isAdmin) ? '' : 'none';
        }

        // Secondary Firebase app instance, used ONLY for admin-created accounts.
        // Firebase's client SDK automatically signs in as whatever account
        // createUserWithEmailAndPassword just created - fine for self-registration,
        // but disastrous for "admin creates an account for someone else," since it
        // would silently sign the ADMIN out and into the new account instead. A
        // second, throwaway app instance keeps that account-creation call from
        // touching the admin's real session at all.
        function getSecondaryAuth() {
            let secondaryApp = firebase.apps.find(a => a.name === 'Secondary');
            if (!secondaryApp) secondaryApp = firebase.initializeApp(firebaseConfig, 'Secondary');
            return secondaryApp.auth();
        }

        // If a signed-in user's app profile disappears (an admin removed their
        // access) while they're actively using the app, sign them out rather
        // than leaving them in a broken half-authenticated state. Their real
        // Firebase Auth credential still exists after this - see the note on
        // delUser() - but they can no longer do anything useful in the app.
        let usersEverLoaded = false;
        function validateSession() {
            if (window._selfDeleting) return; // deleteMyAccount() owns sign-out/messaging for this case
            const u = currUser();
            if (!u) return;
            const users = getDB('users');
            if (users.length === 0 && !usersEverLoaded) return; // don't false-trigger before initial data has arrived
            usersEverLoaded = true;
            const stillValid = users.some(x => x.id === u.id);
            if (!stillValid) {
                alert('Your account no longer has access to this app. Please contact an administrator.');
                auth.signOut().then(() => location.reload());
            }
        }

        function toggleAuth() {
            isReg = !isReg;
            document.getElementById('regFields').style.display = isReg ? 'block' : 'none';
            document.getElementById('authBtn').innerText = isReg ? 'Register' : 'Sign In';
            document.getElementById('authToggleText').innerText = isReg ? 'Have credentials? Sign In' : 'New Officer? Register Account';
            // A fresh trip into registration mode always requires a fresh
            // scroll-through and re-check - don't carry over an accepted
            // state from a previous registration attempt this session.
            if (isReg) resetRegTermsGate();
        }

        /* TERMS & CONDITIONS
           - #termsContentTemplate holds the canonical terms text once; it's
             cloned into every element tagged .terms-content on load.
           - Registration ("Create Officer") embeds the terms directly in the
             regFields box: scroll to the bottom to unlock the checkbox,
             check it to accept - all in the same window, no popup needed.
           - The About window still opens a read-only viewer modal. */
        let termsAccepted = false;
        function isScrolledToBottom(el) { return el.scrollTop + el.clientHeight >= el.scrollHeight - 24; }

        function populateTermsContainers() {
            const tpl = document.getElementById('termsContentTemplate');
            document.querySelectorAll('.terms-content').forEach(el => {
                el.innerHTML = '';
                el.appendChild(tpl.content.cloneNode(true));
            });
        }
        populateTermsContainers();

        function resetRegTermsGate() {
            termsAccepted = false;
            const body = document.getElementById('regTermsScrollBody');
            const cb = document.getElementById('regTermsCheckbox');
            body.scrollTop = 0;
            cb.checked = false;
            cb.disabled = true;
            // Short content that doesn't need scrolling shouldn't trap the
            // user - if it's already "at the bottom" on open, unlock it.
            requestAnimationFrame(() => { if (isScrolledToBottom(body)) cb.disabled = false; });
        }
        function onRegTermsScroll() {
            const body = document.getElementById('regTermsScrollBody');
            if (isScrolledToBottom(body)) document.getElementById('regTermsCheckbox').disabled = false;
        }
        function onRegTermsCheckboxChange() {
            termsAccepted = document.getElementById('regTermsCheckbox').checked;
        }

        function viewTermsModal() {
            document.getElementById('termsScrollBody').scrollTop = 0;
            document.getElementById('termsModal').style.display = 'flex';
        }

        function friendlyAuthError(err) {
            const map = {
                'auth/email-already-in-use': 'An account with that email already exists. Sign in instead, or use "Forgot password?" below.',
                'auth/invalid-email': 'That email address doesn\'t look valid.',
                'auth/weak-password': 'Password must be at least 6 characters.',
                'auth/wrong-password': 'Incorrect password.',
                'auth/user-not-found': 'No account found with that email.',
                'auth/too-many-requests': 'Too many attempts - please wait a bit and try again.',
                'auth/invalid-credential': 'Incorrect email or password.'
            };
            return map[err.code] || err.message;
        }

        async function handleAuth() {
            const email = document.getElementById('authEmail').value.trim();
            const pass = document.getElementById('authPass').value;
            const errEl = document.getElementById('authErr');
            const showErr = msg => { errEl.innerText = msg; errEl.style.display = 'block'; };

            if (!email || !pass) { showErr('Email and password are required.'); return; }

            try {
                if (isReg) {
                    const name = document.getElementById('authName').value.trim();
                    const phone = document.getElementById('authPhone').value.trim();
                    if (!name) { showErr('Full name / callsign is required.'); return; }
                    if (!termsAccepted) { showErr('You must review and accept the Terms & Conditions to register.'); return; }

                    // isRegistering tells onAuthStateChanged to stand down for this
                    // sign-in - see the listener above. We own the full transition
                    // into the app ourselves below instead.
                    isRegistering = true;
                    let cred;
                    try {
                        cred = await auth.createUserWithEmailAndPassword(email, pass);
                        // The very first person to ever register becomes admin, since
                        // there's no other way to bootstrap Command Center access on a
                        // brand new install (a Firestore doc alone isn't a real login).
                        const existingSnap = await db.collection('users').limit(1).get({ source: 'server' });
                        const isFirstEver = existingSnap.empty;
                        // Everyone starts at the bottom rank until Command promotes
                        // them - matches how admin-created accounts default too
                        // (see openUserModal).
                        const profile = { id: cred.user.uid, uid: cred.user.uid, name, email, phone, role: 'Private', isAdmin: isFirstEver };
                        await saveDoc('users', cred.user.uid, profile);
                        logAction(isFirstEver ? 'Registered first account (auto-admin)' : 'Registered new guard');
                        notifySystemAdminOfNewUser(profile);

                        // onAuthStateChanged skipped this sign-in (isRegistering), so
                        // finish what it would normally have done: load the profile
                        // into memory and drop into the app.
                        window._currentUserProfile = profile;
                        document.getElementById('authModal').style.display = 'none';
                        document.getElementById('userGreeting').innerText = profile.name;
                        updateDockForUser();
                        requestNotificationPermission();
                        await initialLoad();
                    } catch (err) {
                        // The Auth account may have been created even though the
                        // profile write failed (e.g. a Firestore rules/network
                        // hiccup). Don't leave a signed-in-but-profile-less user
                        // stuck behind the register screen - sign them back out so
                        // the error is honest and they can retry cleanly.
                        if (cred) await auth.signOut().catch(() => {});
                        throw err;
                    } finally {
                        isRegistering = false;
                    }
                } else {
                    await auth.signInWithEmailAndPassword(email, pass);
                    logAction('Logged in');
                    // onAuthStateChanged takes it from here: loads the profile,
                    // hides this modal, and loads the rest of the app's data.
                }
                errEl.style.display = 'none';
            } catch (err) {
                console.error('Auth error:', err);
                showErr(friendlyAuthError(err));
            }
        }

        function forgotPassword() {
            const email = document.getElementById('authEmail').value.trim();
            if (!email) { alert('Enter your email address above first, then tap "Forgot password?" again.'); return; }
            auth.sendPasswordResetEmail(email).then(() => {
                alert(`Password reset email sent to ${email}. Check your inbox (and spam folder).`);
            }).catch(err => alert('Could not send reset email: ' + friendlyAuthError(err)));
        }

        function logout() { logAction('Logged out'); auth.signOut().then(() => location.reload()); }

        function switchView(v) {
            // Belt-and-suspenders: even if something calls switchView('adminConsoleView')
            // directly (bypassing promptAdminPin), never actually show it to a
            // non-admin. The PIN prompt is the intended door in.
            if (v === 'adminConsoleView' && !currUser()?.isAdmin) { v = 'eventsFeed'; }
            ['eventsFeedView', 'eventDetailView', 'calendarView', 'teamChatView', 'banListView', 'myShiftsView', 'contactsDirectoryView', 'settingsView', 'adminConsoleView'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = (id === v + 'View' || id === v) ? 'block' : 'none';
            });
            document.querySelectorAll('.dock-item').forEach(item => {
                item.classList.toggle('active', item.dataset.view === v || item.dataset.view === v + 'View');
            });
            if (v === 'eventsFeed') renderEvents();
            if (v === 'calendarView') renderCal();
            if (v === 'teamChatView') renderChat();
            if (v === 'banListView') renderBanList();
            if (v === 'myShiftsView') renderMyShiftsView();
            if (v === 'contactsDirectoryView') renderContactsDirectory();
            if (v === 'settingsView') renderSettings();
            if (v === 'adminConsoleView') renderAdminEv();
            if (v !== 'adminConsoleView') clearAnnouncementPreview();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

