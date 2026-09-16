        // Hard failsafe: never make staff wait more than 20s, per spec. This only
        // forces the OVERLAY to hide early if something is truly stuck; the real
        // load (below) keeps running and will populate the UI once it finishes.
        setTimeout(() => {
            if (!isUILoaded) document.getElementById('loadWarnText').style.display = 'block';
            dropLoadingScreen();
        }, HARD_LOAD_TIMEOUT_MS);

        // Real Firebase Authentication (email/password) now gates the app.
        // Firestore rules require `request.auth != null`, which a real signed-in
        // user satisfies just as well as the old anonymous handshake did - so
        // that anonymous sign-in step is gone entirely. Instead, we wait to find
        // out whether anyone is already logged in (from a previous session) and
        // only load app data once we know who's asking for it.
        // Set while handleAuth() is actively registering a brand-new account.
        // createUserWithEmailAndPassword signs the new user in instantly, which
        // fires onAuthStateChanged before handleAuth() has had a chance to write
        // that user's Firestore profile doc. Without this guard, onAuthStateChanged
        // reads the (not-yet-written) profile, wrongly concludes "no access," and
        // signs the brand-new account back out mid-registration - even though the
        // Auth account (and often the profile write too) went through fine. See
        // handleAuth() for the registration side of this handshake.
        let isRegistering = false;
        auth.onAuthStateChanged(async (user) => {
            if (user) {
                if (isRegistering) return; // handleAuth() owns this sign-in; let it finish.
                bumpProgress('Signed in...');
                try {
                    const profileSnap = await db.collection('users').doc(user.uid).get({ source: 'server' });
                    if (!profileSnap.exists) {
                        // Auth credential exists but the app profile doesn't (e.g. an
                        // admin removed this person's access). Don't let them into a
                        // broken half-signed-in state.
                        window._currentUserProfile = null;
                        await auth.signOut();
                        if (!isUILoaded) dropLoadingScreen();
                        alert('Your account no longer has access to this app. Contact an administrator.');
                        return;
                    }
                    window._currentUserProfile = profileSnap.data();
                    document.getElementById('authModal').style.display = 'none';
                    document.getElementById('userGreeting').innerText = window._currentUserProfile.name;
                    updateDockForUser();
                    requestNotificationPermission();
                    await initialLoad();
                } catch (err) {
                    console.error('Failed to load profile:', err);
                    document.getElementById('loadStepText').innerText = 'Profile load error: ' + err.message;
                    document.getElementById('loadWarnText').style.display = 'block';
                    if (!isUILoaded) dropLoadingScreen();
                }
            } else {
                window._currentUserProfile = null;
                document.getElementById('authModal').style.display = 'flex';
                if (!isUILoaded) dropLoadingScreen(); // nothing to load pre-login - don't leave staff staring at a spinner
            }
        });
