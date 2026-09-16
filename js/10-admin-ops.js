        /* ADMIN CHAT */
        function renderAdminChats() {
            const ch = getDB('channels'), msgs = getDB('chats').sort((a, b) => b.id.localeCompare(a.id));
            document.getElementById('adminChanList').innerHTML = ch.map(c => `<div class="glass-card" style="display:flex;justify-content:space-between;padding:10px;margin-bottom:8px;"><span># ${c}</span><div><button class="btn btn-sm btn-magenta" onclick="delChan('${c}')">Del Chan</button> <button class="btn btn-sm btn-outline" onclick="clrChan('${c}')">Clr Hist</button></div></div>`).join('');
            document.getElementById('adminMsgList').innerHTML = msgs.map(m => `<div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.05);padding:8px;font-size:0.85rem;"><span style="color:var(--neon-teal);">[#${m.channel}] ${m.user}: ${m.text}</span><button class="btn btn-sm btn-outline" style="color:var(--danger-glow); border:none;" onclick="delMsg('${m.id}')">✕</button></div>`).join('');
            document.getElementById('adminAttachList').innerHTML = msgs.filter(m => m.file).map(m => `<div style="margin-bottom:6px;"><a href="${m.file}" style="color:var(--neon-teal); font-size:0.85rem; font-weight:600;">📎 Attachment in #${m.channel}</a></div>`).join('');
        }
        function addChannel() { let v = document.getElementById('newChanInput').value.toLowerCase().replace(/\s+/g, '-'); if (v) saveDoc('channels', v, { name: v }); }
        function delChan(c) { if (confirm('Delete channel #' + c + ' and all its history?')) { deleteDoc('channels', c); clrChan(c); } }
        function clrChan(c) { db.collection('chats').where('channel', '==', c).get().then(s => { let b = db.batch(); s.forEach(d => b.delete(d.ref)); return b.commit(); }).catch(err => alert('Clear failed: ' + err.message)); }
        function delMsg(id) { deleteDoc('chats', id); }

        /* TAG CATALOG - available options for every event's tag picker */
        function renderAdminTags() {
            const tags = getDB('tags').slice().sort((a, b) => a.name.localeCompare(b.name));
            document.getElementById('adminTagsList').innerHTML = tags.map(t => `
                <span class="neon-tag tag-active">${t.name} <b style="color:var(--danger-glow);cursor:pointer;margin-left:4px;" onclick="delCatalogTag('${t.id}','${jsStr(t.name)}')">×</b></span>
            `).join('') || '<span style="color:var(--text-muted); font-size:0.85rem;">No tags yet - add one above.</span>';
        }
        function addCatalogTag() {
            const input = document.getElementById('newTagInput');
            const name = input.value.trim();
            if (!name) return;
            const id = tagToId(name);
            if (getDB('tags').some(t => t.id === id)) { alert('That tag already exists.'); return; }
            saveDoc('tags', id, { id, name }).then(() => {
                logAction('Added tag to catalog: ' + name);
                input.value = '';
            });
        }
        function delCatalogTag(id, name) {
            if (confirm(`Remove "${name}" from the tag catalog? It will no longer be selectable on events, but any event that already has it keeps it until edited.`)) {
                deleteDoc('tags', id).then(() => logAction('Removed tag from catalog: ' + name));
            }
        }

        /* ROLE / RANK MANAGER - shares the adminTags pane with the tag catalog above */
        function renderAdminRoles() {
            const roles = getDB('roles').slice().sort((a, b) => a.name.localeCompare(b.name));
            document.getElementById('adminRolesList').innerHTML = roles.map(r => `
                <span class="neon-tag tag-active">${r.name} <b style="color:var(--neon-teal);cursor:pointer;margin-left:6px;" title="Rename" onclick="editCatalogRole('${r.id}','${jsStr(r.name)}')">✎</b><b style="color:var(--danger-glow);cursor:pointer;margin-left:4px;" title="Delete" onclick="delCatalogRole('${r.id}','${jsStr(r.name)}')">×</b></span>
            `).join('') || '<span style="color:var(--text-muted); font-size:0.85rem;">No ranks yet - add one above.</span>';
        }
        function addCatalogRole() {
            const input = document.getElementById('newRoleInput');
            const name = input.value.trim();
            if (!name) return;
            const id = roleToId(name);
            if (getDB('roles').some(r => r.id === id)) { alert('That rank already exists.'); return; }
            saveDoc('roles', id, { id, name }).then(() => {
                logAction('Added rank to catalog: ' + name);
                input.value = '';
            });
        }
        function editCatalogRole(id, oldName) {
            const newName = prompt('Rename rank:', oldName);
            if (newName === null) return;
            const trimmed = newName.trim();
            if (!trimmed || trimmed === oldName) return;
            saveDoc('roles', id, { id, name: trimmed }).then(() => {
                logAction(`Renamed rank "${oldName}" to "${trimmed}"`);
                alert(`Renamed. Note: this won't automatically update "${oldName}" already saved on users or on position rank restrictions - re-select the new name on those individually if needed.`);
            });
        }
        function delCatalogRole(id, name) {
            if (confirm(`Remove "${name}" from the rank catalog? Users and position restrictions that already reference it keep the name until edited.`)) {
                deleteDoc('roles', id).then(() => logAction('Removed rank from catalog: ' + name));
            }
        }

        /* LOGS, USERS, CONTACTS */
        function renderLogs() { document.getElementById('logsBody').innerHTML = getDB('logs').sort((a, b) => b.id.localeCompare(a.id)).map(l => `<tr><td style="color:var(--text-muted);">${l.time}</td><td style="color:var(--neon-teal); font-weight:600;">${l.user}</td><td>${l.action}</td></tr>`).join(''); }

        function renderUsers() {
            const me = currUser();
            document.getElementById('usersBody').innerHTML = getDB('users').map(u => `<tr>
                <td><strong>${u.name}</strong></td>
                <td style="font-size:0.8rem;">${u.email}<br>${u.phone || ''}</td>
                <td style="font-size:0.8rem; color:var(--neon-teal); font-weight:600;">${u.role || '<span style="color:var(--text-muted); font-weight:400;">—</span>'}</td>
                <td style="white-space:nowrap;">
                    <button class="btn btn-sm ${u.isAdmin ? 'btn-magenta' : 'btn-outline'}" onclick="togAdmin('${u.id}')">${u.isAdmin ? 'Admin' : 'Guard'}</button>
                    <button class="btn btn-sm btn-outline" onclick="openUserModal('${u.id}')">Edit</button>
                    <button class="btn btn-sm btn-outline" style="color:var(--danger-glow);" onclick="delUser('${u.id}')" ${me && me.id === u.id ? 'disabled title="Cannot delete your own active session"' : ''}>Delete</button>
                </td>
            </tr>`).join('');
        }
        function togAdmin(id) {
            let usr = getDB('users').find(x => x.id === id);
            if (!usr) return;
            if (!usr.isAdmin) {
                // No PIN prompt here anymore - granting admin access just
                // flips the flag. They'll be walked through setting their
                // own personal PIN the first time they actually open the
                // admin console (see promptAdminPin's no-PIN-yet branch).
                usr.isAdmin = true;
            } else {
                usr.isAdmin = false;
            }
            saveDoc('users', usr.id, usr);
        }
        function adminSendPasswordReset(email, name) {
            auth.sendPasswordResetEmail(email).then(() => {
                alert(`Password reset email sent to ${name} (${email}).`);
                logAction('Sent password reset email to: ' + name);
            }).catch(err => alert('Could not send reset email: ' + friendlyAuthError(err)));
        }
        function delUser(id) {
            const me = currUser();
            if (me && me.id === id) { alert("You can't delete the account you're currently signed in as. Sign in as another admin first."); return; }
            const u = getDB('users').find(x => x.id === id);
            if (!u) return;
            if (confirm(`Remove ${u.name}'s access and profile from this app? This cannot be undone.\n\nNote: this removes their app access immediately, but due to Firebase security restrictions it can't delete their underlying login credential from here. If you need to fully block that email/password combo from ever signing in again, also remove them under Firebase Console → Authentication → Users.`)) {
                deleteDoc('users', id);
            }
        }

        // --- Admin console: add / edit user profiles directly ---
        let editingUserId = null; // null while the modal is open in "create new user" mode
        function openUserModal(id) {
            editingUserId = id || null;
            const u = id ? getDB('users').find(x => x.id === id) : null;
            document.getElementById('umErr').style.display = 'none';
            document.getElementById('umTitle').innerText = id ? 'Edit User' : 'Add New User';
            document.getElementById('umName').value = u ? u.name : '';
            document.getElementById('umEmail').value = u ? u.email : '';
            document.getElementById('umEmail').disabled = !!id; // can't change another user's login email client-side
            document.getElementById('umEmailLockedNote').style.display = id ? 'block' : 'none';
            document.getElementById('umPhone').value = u ? (u.phone || '') : '';
            document.getElementById('umRole').innerHTML = '<option value="">-- No rank assigned --</option>' + getRoleCatalog().map(r => `<option value="${r}">${r}</option>`).join('');
            // New users default to Private - only override for an existing
            // user being edited, whose actual rank (or lack of one) we show as-is.
            document.getElementById('umRole').value = u ? (u.role || '') : 'Private';
            document.getElementById('umIsAdmin').checked = u ? !!u.isAdmin : false;
            document.getElementById('umPinWrap').style.display = (u && u.isAdmin) ? 'block' : 'none';
            document.getElementById('umPin').value = '';
            // Password field only makes sense when creating a brand new account.
            // Firebase's client SDK has no way to set another existing user's
            // password directly - only a reset email (see the button below).
            document.getElementById('umPasswordWrap').style.display = id ? 'none' : 'block';
            document.getElementById('umPassword').value = '';
            document.getElementById('umResetWrap').style.display = id ? 'block' : 'none';
            document.getElementById('umDeleteBtn').style.display = id ? 'inline-block' : 'none';
            document.getElementById('userModal').style.display = 'flex';
        }
        function sendResetFromModal() {
            const email = document.getElementById('umEmail').value.trim();
            const name = document.getElementById('umName').value.trim() || email;
            if (!email) return;
            adminSendPasswordReset(email, name);
        }
        async function saveUserModal() {
            const name = document.getElementById('umName').value.trim();
            const email = document.getElementById('umEmail').value.trim();
            const phone = document.getElementById('umPhone').value.trim();
            const role = document.getElementById('umRole').value;
            const pw = document.getElementById('umPassword').value;
            const isAdmin = document.getElementById('umIsAdmin').checked;
            const pinInput = document.getElementById('umPin').value.trim();
            const errEl = document.getElementById('umErr');
            const showErr = msg => { errEl.innerText = msg; errEl.style.display = 'block'; };
            errEl.style.display = 'none';

            if (!name || !email) { showErr('Name and email are required.'); return; }
            if (pinInput && pinInput.length < 4) { showErr('Admin PIN must be at least 4 characters.'); return; }
            const users = getDB('users');

            if (editingUserId) {
                // Editing only ever touches the Firestore profile fields - email
                // is locked in the UI, and password changes go through the reset
                // email flow instead (see openUserModal).
                const existing = users.find(x => x.id === editingUserId);
                if (!existing) return;
                // PIN is optional here - if granting admin access with no PIN
                // entered, they'll be prompted to set their own the first time
                // they open the admin console (see promptAdminPin).
                const pin = isAdmin ? (pinInput || existing.pin) : existing.pin;
                const updated = { ...existing, name, phone, role, isAdmin, pin };
                saveDoc('users', editingUserId, updated).then(() => {
                    logAction('Updated user profile: ' + name);
                    const me = currUser();
                    if (me && me.id === editingUserId) {
                        window._currentUserProfile = updated;
                        document.getElementById('userGreeting').innerText = updated.name;
                    }
                    closeModal('userModal');
                });
            } else {
                const dupe = users.find(x => x.email.toLowerCase() === email.toLowerCase());
                if (dupe) { showErr('Another account already uses that email.'); return; }
                if (!pw || pw.length < 6) { showErr('Please set an initial password of at least 6 characters.'); return; }
                try {
                    // Created via a SECONDARY Firebase app instance so this doesn't
                    // sign the admin out of their own session (see getSecondaryAuth).
                    const secAuth = getSecondaryAuth();
                    const cred = await secAuth.createUserWithEmailAndPassword(email, pw);
                    const newUid = cred.user.uid;
                    await secAuth.signOut();
                    const nu = { id: newUid, uid: newUid, name, email, phone, role, isAdmin, pin: isAdmin ? pinInput : undefined };
                    await saveDoc('users', newUid, nu);
                    logAction('Admin created new user: ' + name);
                    notifySystemAdminOfNewUser(nu);
                    closeModal('userModal');
                } catch (err) {
                    console.error('Create user failed:', err);
                    showErr(friendlyAuthError(err));
                }
            }
        }
        function deleteUserFromModal() {
            if (!editingUserId) return;
            const me = currUser();
            if (me && me.id === editingUserId) { alert("You can't delete the account you're currently signed in as. Sign in as another admin first."); return; }
            const u = getDB('users').find(x => x.id === editingUserId);
            if (confirm(`Remove ${u ? u.name : 'this user'}'s access and profile from this app? This cannot be undone.\n\nNote: this removes app access immediately but can't delete their underlying login credential from here - see Firebase Console → Authentication → Users for that.`)) {
                deleteDoc('users', editingUserId);
                closeModal('userModal');
            }
        }

