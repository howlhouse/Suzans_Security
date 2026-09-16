        // --- 3. GLOBAL STATE ---
        window.ss_state = { events: [], users: [], channels: [], chats: [], promoters: [], logs: [], banlist: [], tags: [], roles: [], announcement: [] };
        const allCollections = ['events', 'users', 'channels', 'chats', 'promoters', 'logs', 'banlist', 'tags', 'roles', 'announcement'];
        const getDB = k => window.ss_state[k] || [];

        // --- 3b. SAFE WRITE HELPER (fixes silent-fail / undefined-field save bug) ---
        // JSON round-trip strips `undefined` values (Firestore rejects them outright,
        // which was silently killing entire writes any time one field was unset).
        function cleanData(obj) { return JSON.parse(JSON.stringify(obj)); }

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

        const logAction = act => {
            const id = 'l' + Date.now();
            saveDoc('logs', id, { id, time: new Date().toLocaleTimeString(), user: currUser()?.name || 'System', action: act });
        };

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

