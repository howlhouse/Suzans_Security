        /* ID SCAN — scan a driver license / ID card barcode (phone camera or an external scanner),
           check it against the rules set for that event, and keep a registry of what was scanned.

           How an ID is "verified": there is no public database of US driver licenses (they are
           protected by the federal Driver's Privacy Protection Act), so every check here runs on
           the device against the data printed in the card's PDF417 barcode: valid AAMVA structure,
           issuing state, expiry, minimum age, and a name match against the Ban List. Real-time
           verification with the issuing state needs a paid vendor and a server-side key; the one
           place to plug that in is idsVerifyExternal() below.

           Collections (all locked down in firestore.rules - read them before changing anything):
             idscan_config/{eventId}  rules for one event ({id:'_global'} holds data retention)
             idscans/{id}             one registry record per scan; admin-read only
             idscan_photos/{id}       the photo for a record, kept apart so list queries stay small
             idscan_seen/{eventId__hash}  "this person was already scanned for this event" marker; no PII
           The ID number and address on the card are read but never stored. */

        // ---- Defaults and constants -------------------------------------------------------
        const IDS_DEFAULT_CFG = { enabled: false, minAge: 21, rejectExpired: true, allowedStates: [], banAction: 'review', flagRescan: true, integrity: true, photo: 'off' };
        // Issuer Identification Numbers from the AAMVA barcode header, used to catch a card whose
        // header says one state but whose data says another. A mismatch only ever asks for a human
        // look ("review"), never an automatic denial.
        const IDS_IIN_STATE = {
            '636033': 'AL', '636059': 'AK', '636026': 'AZ', '636021': 'AR', '636014': 'CA', '636020': 'CO', '636006': 'CT', '636011': 'DE',
            '636043': 'DC', '636010': 'FL', '636055': 'GA', '636047': 'HI', '636050': 'ID', '636035': 'IL', '636037': 'IN', '636018': 'IA',
            '636022': 'KS', '636046': 'KY', '636007': 'LA', '636041': 'ME', '636003': 'MD', '636002': 'MA', '636032': 'MI', '636038': 'MN',
            '636051': 'MS', '636030': 'MO', '636008': 'MT', '636054': 'NE', '636049': 'NV', '636039': 'NH', '636036': 'NJ', '636009': 'NM',
            '636001': 'NY', '636004': 'NC', '636034': 'ND', '636023': 'OH', '636058': 'OK', '636029': 'OR', '636025': 'PA', '636052': 'RI',
            '636005': 'SC', '636042': 'SD', '636053': 'TN', '636015': 'TX', '636040': 'UT', '636024': 'VT', '636000': 'VA', '636045': 'WA',
            '636061': 'WV', '636031': 'WI', '636060': 'WY'
        };
        const IDS_ZXING_VERSION = '2.1.0';
        const IDS_ZXING_BASE = 'https://cdn.jsdelivr.net/npm/zxing-wasm@' + IDS_ZXING_VERSION + '/dist/';
        let idsCfgs = {};            // eventId -> config doc
        let idsGlobal = { retentionDays: 0 };
        let idsCfgsLoaded = false;
        let idsPurgedThisSession = false;

        // ---- Pure logic (no DOM, no Firestore) --------------------------------------------
        function idsPad(n) { return String(n).padStart(2, '0'); }
        function idsIso(y, m, d) { return y + '-' + idsPad(m) + '-' + idsPad(d); }
        // AAMVA dates are MMDDCCYY in the US and CCYYMMDD in Canada. Returns 'YYYY-MM-DD' or ''.
        function idsParseDate(s, country) {
            s = String(s || '').replace(/\D/g, '');
            if (s.length !== 8) return '';
            const asYMD = () => { const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8); return (y >= 1880 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31) ? idsIso(y, m, d) : ''; };
            const asMDY = () => { const m = +s.slice(0, 2), d = +s.slice(2, 4), y = +s.slice(4, 8); return (y >= 1880 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31) ? idsIso(y, m, d) : ''; };
            const iso = country === 'CAN' ? (asYMD() || asMDY()) : (asMDY() || asYMD());
            if (!iso) return '';
            const [y, m, d] = iso.split('-').map(Number);
            const dt = new Date(y, m - 1, d);
            return (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) ? iso : ''; // rejects Feb 30 etc.
        }
        function idsToday(now) { const t = now || new Date(); return idsIso(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
        function idsAge(dobIso, now) {
            const [y, m, d] = dobIso.split('-').map(Number), t = now || new Date();
            let age = t.getFullYear() - y;
            if (t.getMonth() + 1 < m || (t.getMonth() + 1 === m && t.getDate() < d)) age--;
            return age;
        }
        function idsFmtDate(iso) { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return m + '/' + d + '/' + y; }
        function idsTitleCase(s) { return String(s || '').toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_, a, b) => a + b.toUpperCase()); }
        function idsNormName(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

        // Reads the text of an AAMVA PDF417 barcode. Returns null if it isn't one. Tolerates scanners
        // that drop the header or the control characters between fields.
        function idsParseAamva(raw) {
            if (!raw || typeof raw !== 'string') return null;
            // Some readers print control characters as <LF> / <CR> / <RS> instead of passing them through.
            const text = raw.replace(/<(lf|cr|rs)>/gi, (_, c) => c.toLowerCase() === 'rs' ? '\x1e' : '\n').replace(/\r\n/g, '\n');
            const hdr = text.match(/ANSI\s*(\d{6})(\d{2})(\d{2})/);
            const el = {};
            const take = line => { const m = line.match(/^([DZ][A-Z]{2})(.*)$/); if (m && !(m[1] in el)) el[m[1]] = m[2].trim(); };
            text.split(/[\n\r\x1e]+/).forEach(line => {
                line = line.trim();
                if (/ANSI\s*\d{6}/.test(line)) { const m = line.match(/(?:DL|ID)(?=D[A-Z]{2})(D[A-Z]{2}.*)$/); if (m) take(m[1]); return; }
                take(line.replace(/^(?:DL|ID)(?=[DZ][A-Z]{2})/, ''));
            });
            if (!el.DCS && !el.DAB && !el.DAA) { // no separators survived: split on the known element codes instead
                const body = text.replace(/^[\s\S]*?(?:DL|ID)(?=DAQ|DCS|DAC|DAA)/, '');
                body.split(/(?=D(?:AA|AB|AC|AD|AG|AI|AJ|AK|AQ|AU|AY|AZ|BA|BB|BC|BD|BH|CA|CB|CD|CF|CG|CH|CI|CJ|CK|CL|CS|CT|DA|DB|DC|DD|DE|DF|DG|DH|DI|DJ|DK|DL)[A-Za-z0-9 ,.'\-]*)/).forEach(take);
            }
            const last = el.DCS || el.DAB || '';
            let first = el.DAC || '', middle = el.DAD || '', lastName = last;
            if (!lastName && el.DAA) { // v1 cards: one "LAST,FIRST,MIDDLE" field
                const p = el.DAA.split(',').map(x => x.trim());
                if (p.length > 1) { lastName = p[0]; first = first || p[1]; middle = middle || p[2] || ''; }
                else { const w = el.DAA.split(/\s+/); lastName = w.pop() || ''; first = first || w.shift() || ''; middle = middle || w.join(' '); }
            }
            if (!first && el.DCT) { const w = el.DCT.split(/[\s,]+/); first = w.shift() || ''; middle = middle || w.join(' '); }
            const country = (el.DCG || 'USA').toUpperCase();
            const dob = idsParseDate(el.DBB, country);
            if (!lastName && !first && !dob) return null; // nothing usable: not an ID barcode
            return {
                firstName: idsTitleCase(first), middleName: idsTitleCase(middle), lastName: idsTitleCase(lastName),
                dob, expiry: idsParseDate(el.DBA, country), issued: idsParseDate(el.DBD, country),
                state: (el.DAJ || '').toUpperCase().slice(0, 2), country,
                iin: hdr ? hdr[1] : '', aamvaVersion: hdr ? hdr[2] : '', hasIdNumber: !!el.DAQ, hasHeader: !!hdr,
                rawDobPresent: !!el.DBB, rawExpiryPresent: !!el.DBA
            };
        }

        // Decides pass / review / fail. `banNames` is the Ban List names; `now` is injectable for testing.
        // fail = hard rule broken (turn away); review = a human should look; pass = nothing found.
        function idsEvaluate(p, cfg, banNames, now) {
            const c = Object.assign({}, IDS_DEFAULT_CFG, cfg || {});
            const reasons = [];
            const add = (level, text) => reasons.push({ level, text });
            const today = idsToday(now);
            let age = null;
            if (!p.dob) add('fail', 'Birth date is missing or unreadable');
            else {
                age = idsAge(p.dob, now);
                if (p.dob > today || age > 120) add('fail', 'Birth date is not plausible (' + idsFmtDate(p.dob) + ')');
                else if (c.minAge > 0 && age < c.minAge) add('fail', 'Under ' + c.minAge + ' (age ' + age + ')');
            }
            if (!p.expiry) { if (c.rejectExpired) add('review', 'Expiry date is missing or unreadable'); }
            else if (c.rejectExpired && p.expiry < today) add('fail', 'Expired ' + idsFmtDate(p.expiry));
            if (p.issued && p.issued > today) add('fail', 'Issue date is in the future (' + idsFmtDate(p.issued) + ')');
            const allowed = (c.allowedStates || []).map(s => String(s).toUpperCase());
            if (allowed.length && !allowed.includes(p.state)) add('fail', 'Issued by ' + (p.state || 'an unknown state') + ' - accepted: ' + allowed.join(', '));
            if (c.integrity) {
                if (!p.hasHeader) add('review', 'Barcode header is missing - may not be a standard license barcode');
                if (!p.hasIdNumber) add('review', 'No ID number in the barcode');
                if (!p.firstName || !p.lastName) add('review', 'Name is incomplete');
                const iinState = IDS_IIN_STATE[p.iin];
                if (iinState && p.state && iinState !== p.state) add('review', 'Barcode header says ' + iinState + ' but the card data says ' + p.state);
            }
            if (c.banAction !== 'off' && banNames && banNames.length) {
                const mine = new Set(idsNormName([p.firstName, p.middleName, p.lastName].join(' ')).split(' ').filter(Boolean));
                const hit = banNames.find(n => { const t = idsNormName(n).split(' ').filter(Boolean); return t.length >= 2 && t.every(w => mine.has(w)); });
                if (hit) add(c.banAction === 'deny' ? 'fail' : 'review', 'Name matches the Ban List entry "' + hit + '" - names alone are not proof, check the person against the entry');
            }
            const result = reasons.some(r => r.level === 'fail') ? 'fail' : reasons.length ? 'review' : 'pass';
            return { result, reasons, age };
        }

        // The single place to add a real-time check with the issuing state or a verification vendor.
        // It would call a server function (never the vendor directly from the browser - the key would
        // be public) and resolve to extra reasons: [{level:'fail'|'review', text}]. Does nothing today.
        async function idsVerifyExternal(parsed, cfg) { return []; }

        async function idsDupKey(eventId, p) {
            if (!(window.crypto && crypto.subtle)) return '';
            const data = new TextEncoder().encode([eventId, idsNormName(p.firstName), idsNormName(p.lastName), p.dob].join('|'));
            const buf = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
        }
        function idsCsvCell(v) {
            let s = String(v == null ? '' : v);
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection from names on a barcode
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }

        // ---- Config (rules per event) -----------------------------------------------------
        async function idsLoadConfigs(force) {
            if (idsCfgsLoaded && !force) return;
            const snap = await db.collection('idscan_config').get();
            idsCfgs = {};
            snap.docs.forEach(d => { const v = d.data(); if (d.id === '_global') idsGlobal = Object.assign({ retentionDays: 0 }, v); else idsCfgs[d.id] = v; });
            idsCfgsLoaded = true;
        }
        function idsCfgFor(eventId) { return Object.assign({}, IDS_DEFAULT_CFG, idsCfgs[eventId] || {}); }
        function idsEventOptions(selectedId, onlyEnabled, includeAll) {
            const evs = getDB('events').filter(e => onlyEnabled ? (!e.archived && idsCfgs[e.id] && idsCfgs[e.id].enabled) : (includeAll || !e.archived))
                .slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            return evs.map(e => `<option value="${escapeHtml(e.id)}" ${e.id === selectedId ? 'selected' : ''}>${escapeHtml(e.title)} · ${escapeHtml(e.date || '')}${e.archived ? ' (archived)' : ''}</option>`).join('');
        }

        // ---- Admin tab: rules ---------------------------------------------------------------
        let idsRegRows = [];
        async function renderAdminIdScan() {
            const u = currUser();
            if (!u || !u.isAdmin) return;
            const msg = document.getElementById('idsRulesMsg');
            msg.style.color = 'var(--text-muted)'; msg.textContent = 'Loading…';
            try { await idsLoadConfigs(true); } catch (err) { msg.style.color = 'var(--danger-glow)'; msg.textContent = 'Could not load ID Scan settings: ' + err.message + ' - if this is new, publish the updated firestore.rules in the Firebase Console first.'; return; }
            msg.textContent = '';
            const evSel = document.getElementById('idsRuleEvent');
            const keep = evSel.value;
            evSel.innerHTML = idsEventOptions(keep, false, false);
            if (keep && [...evSel.options].some(o => o.value === keep)) evSel.value = keep;
            document.getElementById('idsRegEvent').innerHTML = '<option value="">All events</option>' + idsEventOptions(document.getElementById('idsRegEvent').value, false, true);
            document.getElementById('idsRetention').value = idsGlobal.retentionDays || 0;
            idsFillRulesForm();
            if (!idsPurgedThisSession) { idsPurgedThisSession = true; idsPurgeExpired().catch(err => console.warn('ID scan purge failed:', err.message)); }
        }
        function idsFillRulesForm(fromCfg) {
            const id = document.getElementById('idsRuleEvent').value;
            const form = document.getElementById('idsRuleForm');
            if (!id) { form.style.display = 'none'; document.getElementById('idsRuleNone').style.display = 'block'; return; }
            form.style.display = 'block'; document.getElementById('idsRuleNone').style.display = 'none';
            const c = fromCfg || idsCfgFor(id);
            document.getElementById('idsEnabled').checked = !!c.enabled;
            document.getElementById('idsMinAge').value = c.minAge;
            document.getElementById('idsRejectExpired').checked = !!c.rejectExpired;
            document.getElementById('idsStates').value = (c.allowedStates || []).join(', ');
            document.getElementById('idsBanAction').value = c.banAction;
            document.getElementById('idsRescan').checked = !!c.flagRescan;
            document.getElementById('idsIntegrity').checked = !!c.integrity;
            document.getElementById('idsPhoto').value = c.photo;
            const copy = document.getElementById('idsCopyFrom');
            copy.innerHTML = '<option value="">Copy settings from another event…</option>' + getDB('events').filter(e => e.id !== id && idsCfgs[e.id])
                .sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.title)} · ${escapeHtml(e.date || '')}</option>`).join('');
            document.getElementById('idsRuleStatus').textContent = '';
        }
        function idsCopyRules(fromId) { if (fromId && idsCfgs[fromId]) { idsFillRulesForm(idsCfgs[fromId]); document.getElementById('idsRuleStatus').textContent = 'Copied - review and press Save to keep it.'; } }
        async function idsSaveRules() {
            const eventId = document.getElementById('idsRuleEvent').value;
            const status = document.getElementById('idsRuleStatus');
            if (!eventId) return;
            const minAge = parseInt(document.getElementById('idsMinAge').value, 10);
            if (isNaN(minAge) || minAge < 0 || minAge > 99) { status.style.color = 'var(--danger-glow)'; status.textContent = 'Minimum age must be between 0 and 99 (0 turns the age check off).'; return; }
            const states = document.getElementById('idsStates').value.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
            if (states.some(s => !/^[A-Z]{2}$/.test(s))) { status.style.color = 'var(--danger-glow)'; status.textContent = 'Use two-letter state codes separated by commas, like AZ, CA, NV.'; return; }
            const cfg = {
                id: eventId, eventId, enabled: document.getElementById('idsEnabled').checked, minAge,
                rejectExpired: document.getElementById('idsRejectExpired').checked, allowedStates: states,
                banAction: document.getElementById('idsBanAction').value, flagRescan: document.getElementById('idsRescan').checked,
                integrity: document.getElementById('idsIntegrity').checked, photo: document.getElementById('idsPhoto').value,
                updatedAt: Date.now(), updatedBy: currUser()?.name || ''
            };
            status.style.color = 'var(--text-muted)'; status.textContent = 'Saving…';
            try {
                await saveDoc('idscan_config', eventId, cfg);
                idsCfgs[eventId] = cfg;
                status.style.color = 'var(--neon-saguaro)'; status.textContent = '✅ Saved';
                const ev = getDB('events').find(e => e.id === eventId);
                logAction('Updated ID scan rules for: ' + (ev ? ev.title : eventId) + (cfg.enabled ? ' (on)' : ' (off)'));
            } catch (err) { status.style.color = 'var(--danger-glow)'; status.textContent = '❌ Not saved: ' + err.message; }
        }
        async function idsSaveRetention() {
            const n = parseInt(document.getElementById('idsRetention').value, 10);
            const status = document.getElementById('idsRetentionStatus');
            if (isNaN(n) || n < 0 || n > 3650) { status.style.color = 'var(--danger-glow)'; status.textContent = 'Enter a number of days from 0 to 3650.'; return; }
            if (n > 0 && !confirm('Records older than ' + n + ' days (and their photos) will be permanently deleted the next time an admin opens this tab. Continue?')) return;
            try {
                await saveDoc('idscan_config', '_global', { id: '_global', retentionDays: n, updatedAt: Date.now(), updatedBy: currUser()?.name || '' });
                idsGlobal.retentionDays = n;
                status.style.color = 'var(--neon-saguaro)'; status.textContent = n ? '✅ Saved. Older records are deleted when an admin opens this tab.' : '✅ Saved. Records are kept until an admin deletes them.';
                logAction('Set ID scan retention to ' + (n || 'keep until deleted') + (n ? ' days' : ''));
                if (n > 0) idsPurgeExpired(true).then(c => { if (c) status.textContent += ' Deleted ' + c + ' old record' + (c === 1 ? '' : 's') + ' now.'; }).catch(() => {});
            } catch (err) { status.style.color = 'var(--danger-glow)'; status.textContent = '❌ Not saved: ' + err.message; }
        }
        // Deletes records past the retention window, 150 at a time (a batch holds 500 writes and each record can own 2 more docs).
        async function idsPurgeExpired() {
            const days = parseInt(idsGlobal.retentionDays, 10) || 0;
            if (days <= 0) return 0;
            const cutoff = Date.now() - days * 86400000;
            let total = 0;
            for (;;) {
                const snap = await db.collection('idscans').where('scannedAt', '<', cutoff).limit(150).get();
                if (snap.empty) break;
                const batch = db.batch();
                snap.docs.forEach(d => {
                    const r = d.data();
                    batch.delete(d.ref);
                    if (r.hasPhoto) batch.delete(db.collection('idscan_photos').doc(d.id));
                    if (r.seenId) batch.delete(db.collection('idscan_seen').doc(r.seenId));
                });
                await batch.commit();
                total += snap.size;
                if (snap.size < 150) break;
            }
            if (total) logAction('ID scan retention removed ' + total + ' record' + (total === 1 ? '' : 's') + ' older than ' + days + ' days');
            return total;
        }

        // ---- Admin tab: registry ------------------------------------------------------------
        async function idsLoadRegistry() {
            const u = currUser();
            if (!u || !u.isAdmin) return;
            const eventId = document.getElementById('idsRegEvent').value;
            const q = document.getElementById('idsRegSearch').value.trim();
            const status = document.getElementById('idsRegStatus');
            status.style.color = 'var(--text-muted)'; status.textContent = 'Loading…';
            try {
                let query = db.collection('idscans');
                const dm = q.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/) || null, di = q.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                if (dm) query = query.where('dob', '==', idsIso(+dm[3], +dm[1], +dm[2])).limit(500);
                else if (di) query = query.where('dob', '==', q).limit(500);
                else if (q) { const lo = idsNormName(q.includes(',') ? q.split(',')[0] : q.split(/\s+/).pop()); query = query.where('lastLower', '>=', lo).where('lastLower', '<', lo + '').limit(500); }
                else if (eventId) query = query.where('eventId', '==', eventId).limit(1000);
                else query = query.orderBy('scannedAt', 'desc').limit(300);
                const snap = await query.get();
                idsRegRows = snap.docs.map(d => d.data()).sort((a, b) => b.scannedAt - a.scannedAt);
                logAction('Viewed ID scan registry (' + idsRegRows.length + ' records' + (q ? ', searched' : '') + ')');
                idsRenderRegistry();
            } catch (err) { status.style.color = 'var(--danger-glow)'; status.textContent = 'Could not load the registry: ' + err.message; }
        }
        function idsFilteredRows() {
            const eventId = document.getElementById('idsRegEvent').value, res = document.getElementById('idsRegResult').value;
            const showTest = document.getElementById('idsRegTest').checked;
            return idsRegRows.filter(r => (!eventId || r.eventId === eventId) && (!res || r.result === res) && (showTest || r.env !== 'dev'));
        }
        function idsResultBadge(r) {
            const m = { pass: ['✅ Pass', 'var(--neon-saguaro)'], review: ['⚠️ Review', '#ffb020'], fail: ['⛔ Fail', 'var(--danger-glow)'] }[r.result] || ['?', 'var(--text-muted)'];
            return `<span style="color:${m[1]}; font-weight:600; white-space:nowrap;">${m[0]}</span>`;
        }
        function idsRenderRegistry() {
            const rows = idsFilteredRows();
            document.getElementById('idsRegBody').innerHTML = rows.map(r => `
                <tr style="cursor:pointer;" onclick="idsOpenDetail('${jsStr(r.id)}')">
                    <td>${escapeHtml(r.lastName)}, ${escapeHtml(r.firstName)}${r.env === 'dev' ? ' <span style="font-size:0.65rem; color:var(--neon-pink);">TEST</span>' : ''}</td>
                    <td>${escapeHtml(idsFmtDate(r.dob))}${r.ageAtScan != null ? ' <span style="color:var(--text-muted);">(' + r.ageAtScan + ')</span>' : ''}</td>
                    <td>${escapeHtml(r.state || '—')}</td>
                    <td>${idsResultBadge(r)}${r.decision === 'admitted' ? '' : r.decision === 'denied' ? ' <span style="color:var(--text-muted); font-size:0.72rem;">denied</span>' : ''}</td>
                    <td style="font-size:0.78rem;">${escapeHtml(r.eventTitle || '')}<br><span style="color:var(--text-muted);">${escapeHtml(new Date(r.scannedAt).toLocaleString())}</span></td>
                </tr>`).join('') || '<tr><td colspan="5" style="color:var(--text-muted); text-align:center; padding:24px;">No records match.</td></tr>';
            const st = document.getElementById('idsRegStatus');
            st.style.color = 'var(--text-muted)';
            st.textContent = rows.length + ' record' + (rows.length === 1 ? '' : 's') + (idsRegRows.length >= 300 && !document.getElementById('idsRegEvent').value && !document.getElementById('idsRegSearch').value ? ' (latest 300 - pick an event or search for more)' : '');
        }
        function idsExportCsv() {
            const rows = idsFilteredRows();
            if (!rows.length) { alert('Nothing to export - load the registry first.'); return; }
            const head = ['Scanned at', 'Event', 'Event date', 'Last name', 'First name', 'Middle name', 'Birth date', 'Age at scan', 'State', 'ID expires', 'Result', 'Decision', 'Reasons', 'Scanned by', 'Method', 'Photo'];
            const lines = [head.join(',')].concat(rows.map(r => [new Date(r.scannedAt).toISOString(), r.eventTitle, r.eventDate, r.lastName, r.firstName, r.middleName, r.dob, r.ageAtScan, r.state, r.expiry, r.result, r.decision, (r.reasons || []).join('; '), r.scannedBy && r.scannedBy.name, r.method, r.hasPhoto ? 'yes' : 'no'].map(idsCsvCell).join(',')));
            const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
            const a = document.createElement('a'); a.href = url; a.download = 'id-scan-registry-' + idsToday() + '.csv';
            document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
            logAction('Exported ID scan registry (' + rows.length + ' records)');
        }
        let idsDetailId = null;
        async function idsOpenDetail(id) {
            const r = idsRegRows.find(x => x.id === id);
            if (!r) return;
            idsDetailId = id;
            document.getElementById('idsDetailBody').innerHTML = `
                <div id="idsDetailPhoto" style="margin-bottom:12px;">${r.hasPhoto ? '<p style="font-size:0.8rem; color:var(--text-muted);">Loading photo…</p>' : ''}</div>
                <h3 style="font-family:'Outfit'; font-size:1.25rem; margin-bottom:4px;">${escapeHtml([r.firstName, r.middleName, r.lastName].filter(Boolean).join(' '))}</h3>
                <p style="margin-bottom:12px;">${idsResultBadge(r)}${r.decision ? ' · ' + escapeHtml(r.decision) : ''}</p>
                <table class="data-table" style="margin-bottom:12px;"><tbody>
                    <tr><td>Birth date</td><td>${escapeHtml(idsFmtDate(r.dob))} (age ${r.ageAtScan == null ? '?' : r.ageAtScan} at scan)</td></tr>
                    <tr><td>Issued by</td><td>${escapeHtml(r.state || '—')}${r.country && r.country !== 'USA' ? ' · ' + escapeHtml(r.country) : ''}</td></tr>
                    <tr><td>ID expires</td><td>${escapeHtml(idsFmtDate(r.expiry))}</td></tr>
                    <tr><td>Event</td><td>${escapeHtml(r.eventTitle || '')} · ${escapeHtml(r.eventDate || '')}</td></tr>
                    <tr><td>Scanned</td><td>${escapeHtml(new Date(r.scannedAt).toLocaleString())} by ${escapeHtml((r.scannedBy && r.scannedBy.name) || '?')} (${escapeHtml(r.method || '?')})</td></tr>
                </tbody></table>
                ${(r.reasons || []).length ? '<p style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;">Notes from the check</p><ul style="font-size:0.84rem; padding-left:18px; margin-bottom:12px;">' + r.reasons.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul>' : ''}
                <button class="btn btn-magenta btn-sm" onclick="idsDeleteRecord('${jsStr(id)}')">🗑️ Delete this record</button>`;
            document.getElementById('idsDetailModal').style.display = 'flex';
            if (r.hasPhoto) {
                try {
                    const snap = await db.collection('idscan_photos').doc(id).get();
                    const el = document.getElementById('idsDetailPhoto');
                    if (idsDetailId === id && el) el.innerHTML = snap.exists && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(snap.data().photo || '') ? `<img src="${snap.data().photo}" alt="Photo taken at the door" style="width:100%; max-height:320px; object-fit:contain; border-radius:12px; background:#000;">` : '<p style="font-size:0.8rem; color:var(--text-muted);">Photo not found.</p>';
                } catch (err) { const el = document.getElementById('idsDetailPhoto'); if (el) el.innerHTML = '<p style="font-size:0.8rem; color:var(--danger-glow);">Could not load photo: ' + escapeHtml(err.message) + '</p>'; }
            }
        }
        async function idsDeleteRecord(id) {
            const r = idsRegRows.find(x => x.id === id);
            if (!r || !confirm('Permanently delete this scan record' + (r.hasPhoto ? ' and its photo' : '') + '? This cannot be undone.')) return;
            try {
                const batch = db.batch();
                batch.delete(db.collection('idscans').doc(id));
                if (r.hasPhoto) batch.delete(db.collection('idscan_photos').doc(id));
                if (r.seenId) batch.delete(db.collection('idscan_seen').doc(r.seenId));
                await withTimeout(batch.commit(), 15000, 'deleting the record');
                idsRegRows = idsRegRows.filter(x => x.id !== id);
                closeModal('idsDetailModal');
                idsRenderRegistry();
                logAction('Deleted an ID scan record (' + (r.eventTitle || r.eventId) + ')');
            } catch (err) { alert('⚠️ Delete failed: ' + err.message); }
        }

        // ---- Scanner (camera or external scanner) -----------------------------------------
        let idsS = { eventId: '', mode: 'camera', pending: null, stats: { pass: 0, review: 0, fail: 0 }, photoLive: false, seenLocal: {}, wedgeTimer: null };
        const idsCam = { stream: null, timer: null, detector: null, zx: null, nativeBad: false, paused: false, busy: false };

        async function openIdScanner(eventId) {
            const modal = document.getElementById('idsScanModal');
            modal.style.display = 'flex';
            const body = document.getElementById('idsScanBody');
            body.style.display = 'none';
            const msg = document.getElementById('idsScanMsg');
            msg.style.display = 'block'; msg.style.color = 'var(--text-muted)'; msg.textContent = 'Loading…';
            try { await idsLoadConfigs(true); } catch (err) { msg.style.color = 'var(--danger-glow)'; msg.textContent = 'Could not load ID scan settings: ' + err.message; return; }
            const enabled = getDB('events').filter(e => !e.archived && idsCfgs[e.id] && idsCfgs[e.id].enabled);
            if (!enabled.length) { msg.textContent = 'ID scanning is not turned on for any event. An admin can turn it on in Command Center → ID Scan.'; return; }
            const today = idsToday();
            const pick = eventId || (enabled.find(e => e.date === today) || enabled.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).find(e => (e.date || '') >= today) || enabled[0]).id;
            msg.style.display = 'none'; body.style.display = 'block';
            idsS = { eventId: pick, mode: idsS.mode || 'camera', busy: false, pending: null, last: null, stats: { pass: 0, review: 0, fail: 0 }, photoLive: false, seenLocal: {}, wedgeTimer: null };
            document.getElementById('idsScanEvent').innerHTML = idsEventOptions(pick, true);
            idsSetMode(idsS.mode);
            idsRenderResult();
            idsRenderStats();
        }
        function idsChangeEvent(id) {
            if (idsS.pending && !idsFinish()) { document.getElementById('idsScanEvent').value = idsS.eventId; return; }
            idsS.eventId = id; idsS.last = null; idsS.stats = { pass: 0, review: 0, fail: 0 }; idsS.seenLocal = {};
            idsRenderStats(); idsRenderResult();
        }
        async function closeIdScanner() {
            if (idsS.pending && !idsFinish()) { if (!confirm('Close without logging the scan on screen?')) return; idsS.pending = null; }
            idsCamStop();
            clearTimeout(idsS.wedgeTimer);
            document.getElementById('idsScanModal').style.display = 'none';
        }
        function idsSetMode(mode) {
            idsS.mode = mode;
            document.querySelectorAll('#idsModeBtns button').forEach(b => b.classList.toggle('active-mode', b.dataset.mode === mode));
            const cam = document.getElementById('idsCamWrap'), wedge = document.getElementById('idsWedgeWrap');
            idsCamStop();
            cam.style.display = mode === 'camera' ? 'block' : 'none';
            wedge.style.display = mode === 'wedge' ? 'block' : 'none';
            idsS.photoLive = false;
            if (mode === 'camera') idsCamStart(true).catch(err => idsCamError(err));
            else { const w = document.getElementById('idsWedge'); w.value = ''; setTimeout(() => w.focus(), 50); }
        }
        function idsCamError(err) {
            const hint = document.getElementById('idsCamHint');
            hint.style.color = 'var(--danger-glow)';
            hint.textContent = err && err.name === 'NotAllowedError' ? 'Camera access is blocked. Allow the camera for this site in your browser settings, or switch to External scanner.' : 'Could not start the camera: ' + (err && err.message ? err.message : err);
        }

        // -- camera
        async function idsCamStart(scanning) {
            if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw new Error('This browser has no camera access (the app must be opened over https).');
            idsCamStop();
            const video = document.getElementById('idsVideo');
            idsCam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
            video.srcObject = idsCam.stream;
            video.setAttribute('playsinline', '');
            await video.play();
            const hint = document.getElementById('idsCamHint');
            hint.style.color = 'var(--text-muted)';
            if (scanning) { hint.textContent = 'Hold the BACK of the ID (the barcode) steady in the frame.'; idsCam.paused = false; await idsScanLoopStart(); }
        }
        function idsCamStop() {
            clearTimeout(idsCam.timer); idsCam.timer = null;
            if (idsCam.stream) idsCam.stream.getTracks().forEach(t => t.stop());
            idsCam.stream = null;
            const v = document.getElementById('idsVideo'); if (v) v.srcObject = null;
        }
        function idsLoadScript(src) {
            return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not download the barcode reader (offline?). Use External scanner instead.')); document.head.appendChild(s); });
        }
        // Chrome/Android has a built-in PDF417 reader. iPhones (Safari) don't, so load a WebAssembly one.
        // If the built-in one hangs or errors, drop to the WebAssembly one rather than leaving the camera dead.
        async function idsEnsureReader() {
            if (idsCam.detector || idsCam.zx) return;
            if (!idsCam.nativeBad && 'BarcodeDetector' in window) {
                try {
                    const f = await withTimeout(BarcodeDetector.getSupportedFormats(), 2500, 'the camera barcode reader');
                    if (f.includes('pdf417')) { idsCam.detector = new BarcodeDetector({ formats: ['pdf417'] }); return; }
                } catch (err) { /* fall through to the WebAssembly reader */ }
                idsCam.nativeBad = true;
            }
            const hint = document.getElementById('idsCamHint'); hint.textContent = 'Loading barcode reader…';
            await idsLoadScript(IDS_ZXING_BASE + 'iife/reader/index.js');
            ZXingWASM.setZXingModuleOverrides({ locateFile: (path, prefix) => path.endsWith('.wasm') ? IDS_ZXING_BASE + 'reader/zxing_reader.wasm' : prefix + path });
            idsCam.zx = ZXingWASM;
            hint.textContent = 'Hold the BACK of the ID (the barcode) steady in the frame.';
        }
        async function idsScanLoopStart() { await idsEnsureReader(); idsScanTick(); }
        async function idsScanTick() {
            clearTimeout(idsCam.timer);
            if (!idsCam.stream || idsS.mode !== 'camera') return;
            const video = document.getElementById('idsVideo');
            if (!idsCam.paused && !idsCam.busy && video.readyState >= 2 && video.videoWidth) {
                idsCam.busy = true;
                try {
                    if (!idsCam.detector && !idsCam.zx) await idsEnsureReader();
                    let text = '';
                    if (idsCam.detector) {
                        const r = await withTimeout(idsCam.detector.detect(video), 3000, 'the camera barcode reader');
                        // Some built-in readers (macOS) see the barcode but return an empty value for PDF417: use the WebAssembly reader instead.
                        if (r.length && r[0].rawValue) text = r[0].rawValue;
                        else if (r.length) { idsCam.detector = null; idsCam.nativeBad = true; }
                    }
                    else if (idsCam.zx) {
                        const cv = document.createElement('canvas'), sc = Math.min(1, 1600 / video.videoWidth);
                        cv.width = Math.round(video.videoWidth * sc); cv.height = Math.round(video.videoHeight * sc);
                        const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(video, 0, 0, cv.width, cv.height);
                        const r = await idsCam.zx.readBarcodes(cx.getImageData(0, 0, cv.width, cv.height), { formats: ['PDF417'], tryHarder: true, maxNumberOfSymbols: 1, textMode: 'Plain' });
                        if (r.length && r[0].text) text = r[0].text;
                    }
                    if (text) { idsCam.paused = true; idsHandleScan(text, 'camera'); }
                } catch (err) {
                    console.warn('Scan frame failed:', err.message);
                    if (idsCam.detector) { idsCam.detector = null; idsCam.nativeBad = true; } // built-in reader misbehaved: use the WebAssembly one next frame
                    else if (!idsCam.zx) idsCamError(err); // couldn't even download the fallback
                }
                idsCam.busy = false;
            }
            idsCam.timer = setTimeout(idsScanTick, idsCam.zx ? 450 : 250);
        }

        // -- external scanner: acts like a keyboard, "types" the barcode into the focused box
        function idsWedgeInput() {
            clearTimeout(idsS.wedgeTimer);
            idsS.wedgeTimer = setTimeout(() => {
                const w = document.getElementById('idsWedge'), text = w.value;
                if (text.length < 30) { if (text.length) w.value = ''; return; } // too short to be an ID barcode: keystrokes, not a scan
                w.value = '';
                idsHandleScan(text, 'scanner');
            }, 400);
        }
        function idsWedgeRefocus() { if (idsS.mode === 'wedge' && document.getElementById('idsScanModal').style.display === 'flex') setTimeout(() => { const a = document.activeElement; if (!a || !/^(SELECT|INPUT|BUTTON|TEXTAREA)$/.test(a.tagName)) document.getElementById('idsWedge').focus(); }, 80); }

        // -- evaluating and showing a scan
        async function idsHandleScan(text, method) {
            if (idsS.busy) return;
            idsS.busy = true;
            try { await idsHandleScanInner(text, method); } finally { idsS.busy = false; }
        }
        async function idsHandleScanInner(text, method) {
            if (idsS.pending) { if (!idsFinish()) { idsToast('Finish the scan on screen first.'); if (method === 'camera') idsCam.paused = false; return; } }
            const cfg = idsCfgFor(idsS.eventId), ev = getDB('events').find(e => e.id === idsS.eventId);
            idsS.last = null;
            const parsed = idsParseAamva(text);
            if (!parsed) { idsShowError('That barcode isn\'t a driver license or ID card barcode. Scan the back of a US or Canadian license / ID.'); return; }
            const verdict = idsEvaluate(parsed, cfg, getDB('banlist').map(b => b.name));
            try { (await idsVerifyExternal(parsed, cfg)).forEach(r => verdict.reasons.push(r)); } catch (err) { verdict.reasons.push({ level: 'review', text: 'Outside verification unavailable: ' + err.message }); }
            let dupKey = '', prior = null;
            try { dupKey = await idsDupKey(idsS.eventId, parsed); } catch (err) { /* no hashing available: skip re-scan detection */ }
            if (dupKey && cfg.flagRescan) {
                prior = idsS.seenLocal[dupKey] || null;
                if (!prior) { try { const s = await withTimeout(db.collection('idscan_seen').doc(idsS.eventId + '__' + dupKey).get(), 4000, 'the re-scan check'); if (s.exists) prior = s.data(); } catch (err) { /* offline: carry on without it */ } }
                if (prior) verdict.reasons.push({ level: 'review', text: 'Already scanned for this event at ' + new Date(prior.at).toLocaleTimeString() + ' (' + prior.result + ')' });
            }
            const result = verdict.reasons.some(r => r.level === 'fail') ? 'fail' : verdict.reasons.length ? 'review' : 'pass';
            idsS.pending = { parsed, result, reasons: verdict.reasons.map(r => r.text), age: verdict.age, method, dupKey, hadPrior: !!prior, photo: '', decision: result === 'pass' ? 'admitted' : result === 'fail' ? 'denied' : '', eventId: idsS.eventId, eventTitle: ev ? ev.title : '', eventDate: ev ? ev.date : '', photoMode: cfg.photo };
            idsRenderResult();
            if (cfg.photo === 'off') idsFinish(); // nothing more to collect, so log it now (unless it needs a decision)
            logEvent('id_scan', 'Scanned an ID at ' + (ev ? ev.title : idsS.eventId) + ' (' + result + ')');
        }
        function idsShowError(msg) {
            idsS.pending = null; idsS.last = null;
            const box = document.getElementById('idsResult');
            box.innerHTML = `<div style="border:2px solid #ffb020; border-radius:16px; padding:16px; text-align:center;"><div style="font-size:1.6rem;">⚠️</div><p style="font-size:0.9rem; margin:8px 0 12px;">${escapeHtml(msg)}</p><button class="btn btn-sm" onclick="idsClearResult()">Try again</button></div>`;
        }
        function idsClearResult() { idsS.pending = null; idsS.last = null; idsCam.paused = false; idsRenderResult(); if (idsS.mode === 'wedge') document.getElementById('idsWedge').focus(); }
        function idsCanFinish() {
            const p = idsS.pending;
            return !!p && (p.result !== 'review' || !!p.decision) && (p.photoMode !== 'required' || !!p.photo);
        }
        function idsRenderResult() {
            const box = document.getElementById('idsResult'), p = idsS.pending || idsS.last, logged = !idsS.pending;
            if (!p) { box.innerHTML = '<p style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding:18px 0;">Ready to scan.</p>'; return; }
            const c = { pass: ['var(--neon-saguaro)', '✅', 'PASS'], review: ['#ffb020', '⚠️', 'CHECK THIS ID'], fail: ['var(--danger-glow)', '⛔', 'DO NOT ADMIT'] }[p.result];
            const x = p.parsed;
            const decided = p.decision && p.result === 'review';
            box.innerHTML = `
                <div style="border:2px solid ${c[0]}; border-radius:16px; padding:16px;">
                    <div style="text-align:center; font-family:'Outfit'; font-weight:800; font-size:1.3rem; color:${c[0]};">${c[1]} ${c[2]}</div>
                    <div style="text-align:center; margin:10px 0;">
                        <div style="font-family:'Outfit'; font-size:1.2rem; font-weight:700;">${escapeHtml([x.firstName, x.middleName, x.lastName].filter(Boolean).join(' '))}</div>
                        <div style="font-size:0.88rem; color:var(--text-secondary);">Born ${escapeHtml(idsFmtDate(x.dob))}${p.age != null ? ' · age ' + p.age : ''} · ${escapeHtml(x.state || '?')}</div>
                        <div style="font-size:0.82rem; color:var(--text-muted);">Expires ${escapeHtml(idsFmtDate(x.expiry))}</div>
                    </div>
                    ${p.reasons.length ? '<ul style="font-size:0.84rem; padding-left:18px; margin-bottom:12px;">' + p.reasons.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul>' : ''}
                    ${logged ? `<p style="text-align:center; font-size:0.78rem; color:var(--text-muted); margin-bottom:10px;">Logged to the registry${p.decision ? ' · ' + (p.decision === 'admitted' ? 'admitted' : 'denied') : ''}</p>` : ''}
                    ${!logged && p.result === 'review' ? `<div style="display:flex; gap:8px; margin-bottom:10px;">
                        <button class="btn btn-sm" style="flex:1; ${p.decision === 'admitted' ? '' : 'opacity:0.75;'}" onclick="idsDecide('admitted')">${p.decision === 'admitted' ? '✔ ' : ''}Admit</button>
                        <button class="btn btn-magenta btn-sm" style="flex:1; ${p.decision === 'denied' ? '' : 'opacity:0.75;'}" onclick="idsDecide('denied')">${p.decision === 'denied' ? '✔ ' : ''}Deny</button></div>` : ''}
                    ${!logged && p.photoMode !== 'off' ? `<div style="margin-bottom:10px;">${p.photo ? `<img src="${p.photo}" alt="" style="width:100%; max-height:200px; object-fit:contain; border-radius:10px; background:#000;">` : ''}
                        <button class="btn btn-outline btn-sm" style="width:100%; margin-top:6px;" onclick="idsPhotoBtn()">${idsS.photoLive ? '📸 Capture now' : p.photo ? '📷 Retake photo' : '📷 Take photo' + (p.photoMode === 'required' ? ' (required)' : ' (optional)')}</button></div>` : ''}
                    ${logged ? `<button class="btn" style="width:100%;" onclick="idsClearResult()">Scan next ›</button>` : `<button class="btn" style="width:100%;" id="idsNextBtn" ${idsCanFinish() ? '' : 'disabled'} onclick="idsFinish()">${p.result === 'review' && !decided ? 'Choose Admit or Deny' : p.photoMode === 'required' && !p.photo ? 'Take the photo first' : 'Log it & scan next ›'}</button>`}
                </div>`;
        }
        function idsDecide(d) { if (idsS.pending) { idsS.pending.decision = d; idsRenderResult(); if (idsS.pending.photoMode === 'off') idsFinish(); } }
        function idsRenderStats() { const s = idsS.stats; document.getElementById('idsStats').textContent = 'This session: ' + s.pass + ' passed · ' + s.review + ' reviewed · ' + s.fail + ' denied'; }
        let idsToastTimer = null;
        function idsToast(t) { const el = document.getElementById('idsToast'); el.textContent = t; el.style.display = 'block'; clearTimeout(idsToastTimer); idsToastTimer = setTimeout(() => { el.style.display = 'none'; }, 2500); }

        // -- photo
        async function idsPhotoBtn() {
            const p = idsS.pending; if (!p) return;
            try {
                if (idsS.photoLive || (idsS.mode === 'camera' && idsCam.stream)) {
                    p.photo = idsGrabJpeg();
                    if (idsS.mode !== 'camera') { idsCamStop(); document.getElementById('idsCamWrap').style.display = 'none'; }
                    idsS.photoLive = false;
                } else {
                    document.getElementById('idsCamWrap').style.display = 'block';
                    await idsCamStart(false);
                    idsS.photoLive = true;
                    document.getElementById('idsCamHint').textContent = 'Frame the person or the front of the ID, then tap Capture now.';
                }
            } catch (err) { idsCamError(err); idsS.photoLive = false; }
            idsRenderResult();
        }
        // Compressed JPEG data URL (about 40-120 KB) so it fits comfortably in a Firestore document.
        function idsGrabJpeg() {
            const v = document.getElementById('idsVideo');
            if (!v.videoWidth) throw new Error('The camera is not ready yet.');
            const sc = Math.min(1, 720 / v.videoWidth), cv = document.createElement('canvas');
            cv.width = Math.round(v.videoWidth * sc); cv.height = Math.round(v.videoHeight * sc);
            cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
            let q = 0.65, out = cv.toDataURL('image/jpeg', q);
            while (out.length > 300000 && q > 0.3) { q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
            return out;
        }

        // -- logging the scan to the registry
        function idsFinish() {
            const p = idsS.pending;
            if (!p) return true;
            if (!idsCanFinish()) return false;
            idsS.pending = null;
            if (idsS.photoLive) { // a photo preview was left open: close it (camera mode goes back to scanning)
                idsS.photoLive = false; idsCamStop();
                document.getElementById('idsCamWrap').style.display = idsS.mode === 'camera' ? 'block' : 'none';
                if (idsS.mode === 'camera') idsCamStart(true).catch(idsCamError);
            }
            idsCommit(p);
            idsS.stats[p.result === 'pass' ? 'pass' : p.decision === 'denied' ? 'fail' : 'review']++;
            idsS.last = p;
            idsRenderStats();
            idsRenderResult();
            if (idsS.mode === 'wedge') document.getElementById('idsWedge').focus();
            return true;
        }
        function idsCommit(p) {
            const actor = logActor(), x = p.parsed, id = 's' + Date.now() + Math.random().toString(36).slice(2, 6);
            const seenId = p.dupKey ? p.eventId + '__' + p.dupKey : '';
            const rec = {
                id, eventId: p.eventId, eventTitle: p.eventTitle, eventDate: p.eventDate, scannedAt: Date.now(),
                scannedBy: { uid: actor ? actor.uid : '', name: actor ? actor.user : '' }, method: p.method,
                firstName: x.firstName, middleName: x.middleName, lastName: x.lastName, lastLower: idsNormName(x.lastName), firstLower: idsNormName(x.firstName),
                dob: x.dob, ageAtScan: p.age, state: x.state, country: x.country, expiry: x.expiry,
                result: p.result, decision: p.decision, reasons: p.reasons, hasPhoto: !!p.photo, seenId, env: IS_DEV_SITE ? 'dev' : 'prod'
            };
            idsS.seenLocal[p.dupKey] = { at: rec.scannedAt, result: p.result };
            const batch = db.batch();
            batch.set(db.collection('idscans').doc(id), cleanData(rec));
            if (p.photo) batch.set(db.collection('idscan_photos').doc(id), { id, uid: rec.scannedBy.uid, photo: p.photo });
            // Not saved and not retried on failure (offline). The registry record is what matters, so it is written on its own below.
            batch.commit().catch(err => { console.error('ID scan not saved:', err); alert('⚠️ That scan was NOT saved to the registry: ' + err.message + '\n\nIt was for ' + x.firstName + ' ' + x.lastName + ' (' + p.result + '). Write it down and tell an admin.'); });
            if (seenId && !p.hadPrior) db.collection('idscan_seen').doc(seenId).set({ eventId: p.eventId, uid: rec.scannedBy.uid, at: rec.scannedAt, result: p.result }).catch(() => {});
        }
