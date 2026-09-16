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
        function maybeShowWelcome() {
            try {
                const store = (typeof localStorage !== 'undefined') ? localStorage : sessionStorage;
                if (!store.getItem('ss_welcomeSeen')) {
                    document.getElementById('welcomeModal').style.display = 'flex';
                }
            } catch (err) {
                // Storage blocked entirely - just show it once for this load and move on.
                document.getElementById('welcomeModal').style.display = 'flex';
            }
        }
        function dismissWelcome() {
            try {
                const store = (typeof localStorage !== 'undefined') ? localStorage : sessionStorage;
                store.setItem('ss_welcomeSeen', '1');
            } catch (err) { /* no persistent storage available - nothing more we can do */ }
            closeModal('welcomeModal');
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
        function sendChat(fUrl = null) { let v = document.getElementById('chatInput').value; if (v || fUrl) { let cm = { id: 'm' + Date.now(), channel: actChan, user: currUser().name, text: v || 'Sent file', file: fUrl }; saveDoc('chats', cm.id, cm); document.getElementById('chatInput').value = ''; } }
        function uploadFile(e) { if (e.target.files[0]) sendChat(URL.createObjectURL(e.target.files[0])); }
