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
             idscan_full/{scanId}     everything on the card (ID number, address...), kept only for the hours an admin sets (max 72),
                                      then unreadable (rules) and deleted. Off unless an admin turns it on.
             idscan_flags/{id}        "flag for Ban List review" notes from staff; admins approve (adds a Ban List entry) or dismiss
           Without the full-data setting, the ID number and address on the card are read but never stored. */

        // ---- Defaults and constants -------------------------------------------------------
        const IDS_DEFAULT_CFG = { enabled: false, minAge: 21, rejectExpired: true, allowedStates: [], homeState: 'AZ', banAction: 'review', flagRescan: true, integrity: true, photo: 'off' };
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
        let idsGlobal = { retentionDays: 0, fullDataHours: 0 };
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
        const idsMs = v => (v && v.toMillis) ? v.toMillis() : +v || 0; // Firestore Timestamp or plain number -> milliseconds
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
            if (/^(none|nmn|n\/a|na|-)$/i.test(middle.trim())) middle = ''; // cards print NONE when there is no middle name
            const country = (el.DCG || 'USA').toUpperCase();
            const dob = idsParseDate(el.DBB, country);
            if (!lastName && !first && !dob) return null; // nothing usable: not an ID barcode
            return {
                firstName: idsTitleCase(first), middleName: idsTitleCase(middle), lastName: idsTitleCase(lastName),
                dob, expiry: idsParseDate(el.DBA, country), issued: idsParseDate(el.DBD, country),
                state: (el.DAJ || '').toUpperCase().slice(0, 2), country,
                iin: hdr ? hdr[1] : '', aamvaVersion: hdr ? hdr[2] : '', hasIdNumber: !!el.DAQ, hasHeader: !!hdr,
                rawDobPresent: !!el.DBB, rawExpiryPresent: !!el.DBA,
                fields: el // every element on the card, for the on-screen "all barcode data" view; never saved
            };
        }

        // Names for the data elements in an AAMVA barcode. Anything not listed is shown under its raw code.
        const IDS_FIELD_LABELS = {
            DCS: 'Last name', DAC: 'First name', DAD: 'Middle name', DCT: 'Given names', DCU: 'Name suffix', DAA: 'Full name',
            DBB: 'Birth date', DBA: 'Expiry date', DBD: 'Issue date', DBC: 'Sex', DAY: 'Eye color', DAZ: 'Hair color', DAU: 'Height', DAW: 'Weight (lb)', DAX: 'Weight (kg)',
            DAQ: 'ID number', DCF: 'Document discriminator', DCK: 'Inventory control number', DCA: 'License class', DCB: 'Restrictions', DCD: 'Endorsements',
            DAG: 'Street address', DAH: 'Street address 2', DAI: 'City', DAJ: 'State', DAK: 'ZIP / postal code', DCG: 'Country',
            DDA: 'Compliance type', DDB: 'Card revision date', DDC: 'Hazmat expiry', DDD: 'Limited duration', DDE: 'Last name truncated', DDF: 'First name truncated', DDG: 'Middle name truncated',
            DDH: 'Under 18 until', DDI: 'Under 19 until', DDJ: 'Under 21 until', DDK: 'Organ donor', DDL: 'Veteran', DCI: 'Place of birth', DCJ: 'Audit information', DCL: 'Race / ethnicity', DCM: 'Vehicle class', DCN: 'Vehicle codes'
        };
        const IDS_DATE_FIELDS = ['DBB', 'DBA', 'DBD', 'DDB', 'DDC', 'DDH', 'DDI', 'DDJ'];
        const IDS_FIELD_ORDER = ['DCS', 'DAC', 'DAD', 'DCT', 'DCU', 'DAA', 'DBB', 'DBC', 'DAY', 'DAZ', 'DAU', 'DAW', 'DAX', 'DAG', 'DAH', 'DAI', 'DAJ', 'DAK', 'DCG', 'DAQ', 'DCF', 'DCK', 'DCA', 'DCB', 'DCD', 'DBD', 'DBA', 'DDB'];
        function idsFieldValue(code, v, country) {
            if (IDS_DATE_FIELDS.includes(code)) { const iso = idsParseDate(v, country); return iso ? idsFmtDate(iso) : v; }
            if (code === 'DBC') return { '1': 'Male', '2': 'Female', '9': 'Not specified' }[v] || v;
            if (code === 'DDA') return v === 'F' ? 'F - REAL ID compliant' : v === 'N' ? 'N - not REAL ID compliant' : v;
            if (code === 'DDK' || code === 'DDL') return v === '1' ? 'Yes' : v;
            return v;
        }
        // Rows of [label, value] for everything the barcode carried, known fields first in a sensible order, then the rest.
        function idsFieldRows(p) {
            const f = p.fields || {}, rows = [];
            rows.push(['Barcode issuer (IIN)', p.iin ? p.iin + (IDS_IIN_STATE[p.iin] ? ' (' + IDS_IIN_STATE[p.iin] + ')' : '') : 'no header found']);
            if (p.aamvaVersion) rows.push(['AAMVA version', p.aamvaVersion]);
            const codes = IDS_FIELD_ORDER.filter(c => c in f).concat(Object.keys(f).filter(c => !IDS_FIELD_ORDER.includes(c)).sort());
            codes.forEach(c => rows.push([(IDS_FIELD_LABELS[c] || 'Field') + ' (' + c + ')', idsFieldValue(c, f[c], p.country) || '(empty)']));
            return rows;
        }
        // Raw text with the invisible separator characters made visible.
        function idsShowRaw(raw) { return String(raw || '').replace(/\x1e/g, '␞').replace(/\r/g, '␍').replace(/\n/g, '␊\n'); }

        // fail = turn away, review = a person decides, pass = nothing found.
        function idsResultOf(reasons) {
            return reasons.some(r => r.level === 'fail') ? 'fail' : reasons.some(r => r.level === 'review') ? 'review' : 'pass';
        }
        // The state with a ⚠️ in front when the ID is from outside the event's home state. The result is unaffected: it is still a pass.
        function idsStateHtml(state, outOfState) {
            return (outOfState ? '<span title="Out of state" aria-label="Out of state">⚠️</span> ' : '') + escapeHtml(state || '?');
        }
        // Decides pass / review / fail (plus whether the ID is out of state). `banNames` is the Ban List names; `now` is injectable for testing.
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
                const mine = new Set(idsNormName([p.firstName, p.middleName, p.lastName].join(' ')).split(' ').filter(Boolean)); // the middle name is only used here, to match longer Ban List names
                const hit = banNames.find(n => { const t = idsNormName(n).split(' ').filter(Boolean); return t.length >= 2 && t.every(w => mine.has(w)); });
                if (hit) add(c.banAction === 'deny' ? 'fail' : 'review', 'Name matches the Ban List entry "' + hit + '" - names alone are not proof, check the person against the entry');
            }
            const home = String(c.homeState || '').toUpperCase();
            const outOfState = !!(home && p.state && p.state !== home);
            return { result: idsResultOf(reasons), reasons, age, outOfState };
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
            snap.docs.forEach(d => { const v = d.data(); if (d.id === '_global') idsGlobal = Object.assign({ retentionDays: 0, fullDataHours: 0 }, v); else idsCfgs[d.id] = v; });
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
            document.getElementById('idsFullHours').value = idsGlobal.fullDataHours || 0;
            idsLoadFlags();
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
            document.getElementById('idsHome').value = c.homeState || '';
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
            const homeState = document.getElementById('idsHome').value.trim().toUpperCase();
            if (homeState && !/^[A-Z]{2}$/.test(homeState)) { status.style.color = 'var(--danger-glow)'; status.textContent = 'Home state must be a two-letter code like AZ (or blank to turn the flag off).'; return; }
            const cfg = {
                id: eventId, eventId, enabled: document.getElementById('idsEnabled').checked, minAge,
                rejectExpired: document.getElementById('idsRejectExpired').checked, allowedStates: states, homeState,
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
                await saveDoc('idscan_config', '_global', Object.assign({}, idsGlobal, { id: '_global', retentionDays: n, updatedAt: Date.now(), updatedBy: currUser()?.name || '' }));
                idsGlobal.retentionDays = n;
                status.style.color = 'var(--neon-saguaro)'; status.textContent = n ? '✅ Saved. Older records are deleted when an admin opens this tab.' : '✅ Saved. Records are kept until an admin deletes them.';
                logAction('Set ID scan retention to ' + (n || 'keep until deleted') + (n ? ' days' : ''));
                if (n > 0) idsPurgeExpired(true).then(c => { if (c) status.textContent += ' Deleted ' + c + ' old record' + (c === 1 ? '' : 's') + ' now.'; }).catch(() => {});
            } catch (err) { status.style.color = 'var(--danger-glow)'; status.textContent = '❌ Not saved: ' + err.message; }
        }
        async function idsSaveFullHours() {
            const n = parseInt(document.getElementById('idsFullHours').value, 10);
            const status = document.getElementById('idsFullStatus');
            if (isNaN(n) || n < 0 || n > 72) { status.style.color = 'var(--danger-glow)'; status.textContent = 'Enter a number of hours from 0 to 72.'; return; }
            if (n > 0 && !confirm('From now on, EVERYTHING on each scanned ID (including the ID number and home address) will be stored for ' + n + ' hours, readable only by admins, then deleted. Some states restrict this. Continue?')) return;
            try {
                await saveDoc('idscan_config', '_global', Object.assign({}, idsGlobal, { id: '_global', fullDataHours: n, updatedAt: Date.now(), updatedBy: currUser()?.name || '' }));
                idsGlobal.fullDataHours = n;
                status.style.color = 'var(--neon-saguaro)'; status.textContent = n ? '✅ Saved. New scans keep the full card data for ' + n + ' hours.' : '✅ Saved. The full card data is not kept.';
                logAction('Set ID scan full-card-data storage to ' + (n ? n + ' hours' : 'off'));
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
                    if (r.hasFull) batch.delete(db.collection('idscan_full').doc(d.id));
                    if (r.seenId) batch.delete(db.collection('idscan_seen').doc(r.seenId));
                });
                await batch.commit();
                total += snap.size;
                if (snap.size < 150) break;
            }
            // Flags that an admin already resolved go on the same schedule; pending ones stay until someone decides.
            const oldFlags = await db.collection('idscan_flags').where('createdAt', '<', cutoff).limit(150).get();
            const resolved = oldFlags.docs.filter(d => d.data().status !== 'pending');
            if (resolved.length) { const b = db.batch(); resolved.forEach(d => b.delete(d.ref)); await b.commit(); }
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
                idsRegRows.forEach(r => { if (r.result === 'flag') { r.result = 'pass'; r.outOfState = true; } }); // older records from when out-of-state was its own yellow result
                logAction('Viewed ID scan registry (' + idsRegRows.length + ' records' + (q ? ', searched' : '') + ')');
                idsRenderRegistry();
                idsSweepFull(idsRegRows);
            } catch (err) { status.style.color = 'var(--danger-glow)'; status.textContent = 'Could not load the registry: ' + err.message; }
        }
        // Deletes the full-card-data docs whose time is up. They are already unreadable (firestore.rules); this removes them for real,
        // whether or not the Firebase TTL policy on expireAt has been set up.
        const idsSwept = new Set();
        function idsSweepFull(rows) {
            const due = rows.filter(r => r.hasFull && idsMs(r.fullExpireAt) < Date.now() && !idsSwept.has(r.id)).slice(0, 400);
            if (!due.length) return;
            const b = db.batch();
            due.forEach(r => { idsSwept.add(r.id); b.delete(db.collection('idscan_full').doc(r.id)); });
            b.commit().catch(err => { due.forEach(r => idsSwept.delete(r.id)); console.warn('Full-card-data sweep failed:', err.message); });
        }
        function idsFilteredRows() {
            const eventId = document.getElementById('idsRegEvent').value, res = document.getElementById('idsRegResult').value;
            const showTest = document.getElementById('idsRegTest').checked;
            return idsRegRows.filter(r => (!eventId || r.eventId === eventId) && (!res || r.result === res) && (showTest || r.env !== 'dev'));
        }
        function idsResultBadge(r) {
            const m = { pass: ['✅ Pass', 'var(--neon-saguaro)'], review: ['⚠️ Review', '#ff8a3d'], fail: ['⛔ Fail', 'var(--danger-glow)'] }[r.result] || ['?', 'var(--text-muted)'];
            return `<span style="color:${m[1]}; font-weight:600; white-space:nowrap;">${m[0]}</span>`;
        }
        function idsRenderRegistry() {
            const rows = idsFilteredRows();
            document.getElementById('idsRegBody').innerHTML = rows.map(r => `
                <tr style="cursor:pointer;" onclick="idsOpenDetail('${jsStr(r.id)}')">
                    <td>${escapeHtml(r.lastName)}, ${escapeHtml(r.firstName)}${r.env === 'dev' ? ' <span style="font-size:0.65rem; color:var(--neon-pink);">TEST</span>' : ''}</td>
                    <td>${escapeHtml(idsFmtDate(r.dob))}${r.ageAtScan != null ? ' <span style="color:var(--text-muted);">(' + r.ageAtScan + ')</span>' : ''}</td>
                    <td>${r.state ? idsStateHtml(r.state, r.outOfState) : '—'}</td>
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
            const head = ['Scanned at', 'Event', 'Event date', 'Last name', 'First name', 'Birth date', 'Age at scan', 'State', 'Out of state', 'ID expires', 'Result', 'Decision', 'Reasons', 'Scanned by', 'Method', 'Photo'];
            const lines = [head.join(',')].concat(rows.map(r => [new Date(r.scannedAt).toISOString(), r.eventTitle, r.eventDate, r.lastName, r.firstName, r.dob, r.ageAtScan, r.state, r.outOfState ? 'yes' : 'no', r.expiry, r.result, r.decision, (r.reasons || []).join('; '), r.scannedBy && r.scannedBy.name, r.method, r.hasPhoto ? 'yes' : 'no'].map(idsCsvCell).join(',')));
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
                <h3 style="font-family:'Outfit'; font-size:1.25rem; margin-bottom:4px;">${escapeHtml([r.firstName, r.lastName].filter(Boolean).join(' '))}</h3>
                <p style="margin-bottom:12px;">${idsResultBadge(r)}${r.decision ? ' · ' + escapeHtml(r.decision) : ''}</p>
                <table class="data-table" style="margin-bottom:12px;"><tbody>
                    <tr><td>Birth date</td><td>${escapeHtml(idsFmtDate(r.dob))} (age ${r.ageAtScan == null ? '?' : r.ageAtScan} at scan)</td></tr>
                    <tr><td>Issued by</td><td>${r.state ? idsStateHtml(r.state, r.outOfState) : '—'}${r.country && r.country !== 'USA' ? ' · ' + escapeHtml(r.country) : ''}</td></tr>
                    <tr><td>ID expires</td><td>${escapeHtml(idsFmtDate(r.expiry))}</td></tr>
                    <tr><td>Event</td><td>${escapeHtml(r.eventTitle || '')} · ${escapeHtml(r.eventDate || '')}</td></tr>
                    <tr><td>Scanned</td><td>${escapeHtml(new Date(r.scannedAt).toLocaleString())} by ${escapeHtml((r.scannedBy && r.scannedBy.name) || '?')} (${escapeHtml(r.method || '?')})</td></tr>
                </tbody></table>
                ${(r.reasons || []).length ? '<p style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;">Notes from the check</p><ul style="font-size:0.84rem; padding-left:18px; margin-bottom:12px;">' + r.reasons.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul>' : ''}
                <div id="idsDetailFull" style="margin-bottom:12px;"></div>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button class="btn btn-sm" onclick="idsBanFromRecord('${jsStr(id)}')">🚫 Add to Ban List…</button>
                    <button class="btn btn-magenta btn-sm" onclick="idsDeleteRecord('${jsStr(id)}')">🗑️ Delete this record</button>
                </div>`;
            idsShowFullData(r);
            document.getElementById('idsDetailModal').style.display = 'flex';
            if (r.hasPhoto) {
                try {
                    const snap = await db.collection('idscan_photos').doc(id).get();
                    const el = document.getElementById('idsDetailPhoto');
                    if (idsDetailId === id && el) el.innerHTML = snap.exists && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(snap.data().photo || '') ? `<img src="${snap.data().photo}" alt="Photo taken at the door" style="width:100%; max-height:320px; object-fit:contain; border-radius:12px; background:#000;">` : '<p style="font-size:0.8rem; color:var(--text-muted);">Photo not found.</p>';
                } catch (err) { const el = document.getElementById('idsDetailPhoto'); if (el) el.innerHTML = '<p style="font-size:0.8rem; color:var(--danger-glow);">Could not load photo: ' + escapeHtml(err.message) + '</p>'; }
            }
        }
        // The 24-hour (or whatever the admin set) full card data for one record.
        async function idsShowFullData(r) {
            const box = document.getElementById('idsDetailFull');
            const note = (t, c) => { if (idsDetailId === r.id && box) box.innerHTML = `<p style="font-size:0.78rem; color:${c || 'var(--text-muted)'};">${t}</p>`; };
            if (!r.hasFull) { note('Full card data was not kept for this scan.'); return; }
            if (idsMs(r.fullExpireAt) < Date.now()) { note('Full card data expired and was deleted.'); idsSweepFull([r]); return; }
            note('Loading full card data…');
            try {
                const snap = await db.collection('idscan_full').doc(r.id).get();
                if (idsDetailId !== r.id) return;
                if (!snap.exists) { note('Full card data expired and was deleted.'); return; }
                const f = snap.data(), left = idsMs(f.expireAt) - Date.now();
                if (left <= 0) { note('Full card data expired and was deleted.'); return; }
                const hrs = Math.floor(left / 3600000), mins = Math.floor(left % 3600000 / 60000);
                const rows = idsFieldRows({ fields: f.fields || {}, iin: f.iin, aamvaVersion: f.aamvaVersion, country: f.country });
                box.innerHTML = `<p style="font-size:0.78rem; color:var(--neon-pink); font-weight:600; margin-bottom:6px;">Full card data · deleted in ${hrs}h ${mins}m</p>
                    <table class="data-table" style="font-size:0.78rem;"><tbody>${rows.map(x => `<tr><td style="padding:6px 8px; color:var(--text-muted); width:42%;">${escapeHtml(x[0])}</td><td style="padding:6px 8px; word-break:break-word;">${escapeHtml(x[1])}</td></tr>`).join('')}</tbody></table>`;
            } catch (err) { note('Full card data is no longer available.'); }
        }
        // Admin: put a scanned person on the Ban List straight from their record.
        async function idsBanFromRecord(id) {
            const r = idsRegRows.find(x => x.id === id);
            if (!r) return;
            const name = prompt('Add to the Ban List as:', r.firstName + ' ' + r.lastName);
            if (!name || !name.trim()) return;
            const why = prompt('Note for the Ban List entry (what happened):', '');
            if (why === null) return;
            try {
                await idsAddToBanList(name, 'Added from an ID scan at ' + (r.eventTitle || 'an event') + ' (' + (r.eventDate || '') + ').' + (why.trim() ? ' ' + why.trim() : ''));
                logAction('Added to ban list: ' + name.trim());
                alert('Added to the Ban List.');
            } catch (err) { /* saveDoc already showed the error */ }
        }
        // Adds a Ban List entry, or a note on the existing entry if that name is already there. The Ban List holds names and notes only
        // (it is readable by all staff), never ID numbers or addresses.
        async function idsAddToBanList(name, text) {
            const note = { date: new Date().toLocaleDateString(), by: currUser()?.name || '', text };
            const existing = getDB('banlist').find(b => idsNormName(b.name) === idsNormName(name));
            if (existing) { await saveDoc('banlist', existing.id, { ...existing, notes: [note, ...(existing.notes || [])] }); return existing.id; }
            const id = 'b' + Date.now();
            await saveDoc('banlist', id, { id, name: name.trim(), notes: [note] });
            return id;
        }

        // ---- Flags for Ban List review (staff send them from the scanner; admins decide) -------
        let idsFlags = [];
        async function idsLoadFlags() {
            const u = currUser();
            if (!u || !u.isAdmin) return;
            const status = document.getElementById('idsFlagStatus').value;
            const list = document.getElementById('idsFlagList');
            try {
                const snap = await db.collection('idscan_flags').where('status', '==', status).limit(200).get();
                idsFlags = snap.docs.map(d => d.data()).sort((a, b) => b.createdAt - a.createdAt);
                const pend = status === 'pending' ? idsFlags.length : null;
                document.getElementById('idsFlagCount').textContent = pend === null ? '' : pend ? '(' + pend + ' pending)' : '';
                list.innerHTML = idsFlags.map(f => `
                    <div style="border-top:1px solid rgba(255,255,255,0.08); padding:12px 0;">
                        <div style="font-family:'Outfit'; font-weight:700;">${escapeHtml(f.firstName)} ${escapeHtml(f.lastName)} <span style="font-weight:400; font-size:0.78rem; color:var(--text-muted);">· born ${escapeHtml(idsFmtDate(f.dob))} · ${escapeHtml(f.state || '?')}${f.env === 'dev' ? ' · TEST' : ''}</span></div>
                        <div style="font-size:0.74rem; color:var(--text-muted); margin:2px 0 6px;">${escapeHtml(f.eventTitle || '')} · flagged by ${escapeHtml((f.createdBy && f.createdBy.name) || '?')} · ${escapeHtml(new Date(f.createdAt).toLocaleString())}</div>
                        <p style="font-size:0.85rem; margin-bottom:8px; white-space:pre-wrap;">${escapeHtml(f.note)}</p>
                        ${f.status === 'pending' ? `<div style="display:flex; gap:8px; flex-wrap:wrap;">
                            <button class="btn btn-sm" onclick="idsApproveFlag('${jsStr(f.id)}')">🚫 Add to Ban List</button>
                            <button class="btn btn-outline btn-sm" onclick="idsDismissFlag('${jsStr(f.id)}')">Dismiss</button>
                            <button class="btn btn-outline btn-sm" onclick="idsViewFlagScan('${jsStr(f.id)}')">View scan</button></div>`
                        : `<p style="font-size:0.76rem; color:var(--text-muted);">${f.status === 'approved' ? '🚫 Added to the Ban List' + (f.banName ? ' as ' + escapeHtml(f.banName) : '') : 'Dismissed'} by ${escapeHtml((f.reviewedBy && f.reviewedBy.name) || '?')}${f.reviewNote ? ' - ' + escapeHtml(f.reviewNote) : ''}</p>
                           <button class="btn btn-outline btn-sm" style="margin-top:6px;" onclick="idsViewFlagScan('${jsStr(f.id)}')">View scan</button>`}
                    </div>`).join('') || `<p style="font-size:0.82rem; color:var(--text-muted); padding-top:8px;">${status === 'pending' ? 'Nothing waiting for review.' : 'None.'}</p>`;
            } catch (err) { list.innerHTML = '<p style="font-size:0.8rem; color:var(--danger-glow);">Could not load flags: ' + escapeHtml(err.message) + '</p>'; }
        }
        async function idsApproveFlag(id) {
            const f = idsFlags.find(x => x.id === id);
            if (!f) return;
            const name = prompt('Add to the Ban List as:', f.firstName + ' ' + f.lastName);
            if (!name || !name.trim()) return;
            try {
                const banId = await idsAddToBanList(name, 'Flagged by ' + ((f.createdBy && f.createdBy.name) || 'staff') + ' at ' + (f.eventTitle || 'an event') + ' (' + (f.eventDate || '') + '): ' + f.note);
                await db.collection('idscan_flags').doc(id).update({ status: 'approved', banId, banName: name.trim(), reviewedAt: Date.now(), reviewedBy: { uid: logActor().uid, name: currUser()?.name || '' } });
                logAction('Added to ban list: ' + name.trim());
                idsLoadFlags();
            } catch (err) { alert('⚠️ Could not finish: ' + err.message); }
        }
        async function idsDismissFlag(id) {
            const f = idsFlags.find(x => x.id === id);
            if (!f) return;
            const why = prompt('Reason for dismissing this flag (optional):', '');
            if (why === null) return;
            try {
                await db.collection('idscan_flags').doc(id).update({ status: 'dismissed', reviewNote: why.trim(), reviewedAt: Date.now(), reviewedBy: { uid: logActor().uid, name: currUser()?.name || '' } });
                logAction('Dismissed an ID scan Ban List flag');
                idsLoadFlags();
            } catch (err) { alert('⚠️ Could not dismiss: ' + err.message); }
        }
        async function idsViewFlagScan(id) {
            const f = idsFlags.find(x => x.id === id);
            if (!f || !f.scanId) { alert('This flag has no linked scan.'); return; }
            try {
                const snap = await db.collection('idscans').doc(f.scanId).get();
                if (!snap.exists) { alert('The scan record was not found - it may have been deleted or not saved.'); return; }
                if (!idsRegRows.some(x => x.id === f.scanId)) idsRegRows.unshift(snap.data());
                idsOpenDetail(f.scanId);
            } catch (err) { alert('⚠️ Could not open the scan: ' + err.message); }
        }
        async function idsDeleteRecord(id) {
            const r = idsRegRows.find(x => x.id === id);
            if (!r || !confirm('Permanently delete this scan record' + (r.hasPhoto ? ' and its photo' : '') + '? This cannot be undone.')) return;
            try {
                const batch = db.batch();
                batch.delete(db.collection('idscans').doc(id));
                if (r.hasPhoto) batch.delete(db.collection('idscan_photos').doc(id));
                if (r.hasFull) batch.delete(db.collection('idscan_full').doc(id));
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
        const idsCam = { stream: null, timer: null, detector: null, zx: null, nativeBad: false, paused: false, busy: false, torchWanted: false, torchOk: false };

        async function openIdScanner() {
            document.getElementById('idsScanModal').style.display = 'flex';
            document.getElementById('idsScanBody').style.display = 'none';
            document.getElementById('idsPick').style.display = 'none';
            const msg = document.getElementById('idsScanMsg');
            msg.style.display = 'block'; msg.style.color = 'var(--text-muted)'; msg.textContent = 'Loading…';
            try { await idsLoadConfigs(true); } catch (err) { msg.style.color = 'var(--danger-glow)'; msg.textContent = 'Could not load ID scan settings: ' + err.message; return; }
            if (!idsEnabledEvents().length) { msg.textContent = 'ID scanning is not turned on for any event. An admin can turn it on in Command Center → ID Scan.'; return; }
            msg.style.display = 'none';
            idsS = { eventId: '', mode: idsS.mode || 'camera', busy: false, showAll: idsS.showAll || false, flagOpen: false, flagNote: '', pending: null, last: null, stats: { pass: 0, review: 0, fail: 0 }, photoLive: false, seenLocal: {}, wedgeTimer: null };
            idsShowPicker();
        }
        function idsEnabledEvents() {
            const today = idsToday();
            return getDB('events').filter(e => !e.archived && idsCfgs[e.id] && idsCfgs[e.id].enabled)
                .sort((a, b) => { const fa = (a.date || '') >= today, fb = (b.date || '') >= today; return fa !== fb ? (fa ? -1 : 1) : fa ? (a.date || '').localeCompare(b.date || '') : (b.date || '').localeCompare(a.date || ''); }); // upcoming first (soonest on top), then past
        }
        function idsRuleSummary(c) {
            const bits = [];
            if (c.minAge > 0) bits.push(c.minAge + '+');
            if (c.allowedStates && c.allowedStates.length) bits.push(c.allowedStates.join('/') + ' IDs only');
            if (c.homeState) bits.push('non-' + c.homeState + ' marked ⚠️');
            if (c.photo === 'required') bits.push('photo required'); else if (c.photo === 'optional') bits.push('photo optional');
            return bits.join(' · ');
        }
        // Step 1: choose the event. The camera does not start until one is picked.
        function idsShowPicker() {
            idsCamStop();
            clearTimeout(idsS.wedgeTimer);
            document.getElementById('idsScanBody').style.display = 'none';
            const today = idsToday(), t = new Date(); t.setDate(t.getDate() + 1);
            const tomorrow = idsIso(t.getFullYear(), t.getMonth() + 1, t.getDate());
            document.getElementById('idsPickList').innerHTML = idsEnabledEvents().map(e => {
                const tag = e.date === today ? 'Tonight' : e.date === tomorrow ? 'Tomorrow' : '';
                const sum = idsRuleSummary(idsCfgs[e.id]);
                return `<button class="glass-card" style="display:block; width:100%; text-align:left; cursor:pointer; padding:14px 16px; margin-bottom:10px; color:inherit; font:inherit; ${tag === 'Tonight' ? 'border-color:var(--neon-teal);' : ''}" onclick="idsStartScanning('${jsStr(e.id)}')">
                    <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;"><span style="font-family:'Outfit'; font-weight:700; font-size:1rem;">${escapeHtml(e.title)}</span>${tag ? `<span style="font-size:0.68rem; font-weight:700; color:#08080c; background:var(--neon-teal); border-radius:8px; padding:2px 8px; flex-shrink:0;">${tag}</span>` : ''}</div>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">${escapeHtml(e.date || '')}${e.address ? ' · ' + escapeHtml(e.address) : ''}</div>
                    ${sum ? `<div style="font-size:0.74rem; color:var(--text-secondary); margin-top:4px;">${escapeHtml(sum)}</div>` : ''}</button>`;
            }).join('');
            document.getElementById('idsPick').style.display = 'block';
        }
        // Step 2: scan.
        function idsStartScanning(eventId) {
            const ev = getDB('events').find(e => e.id === eventId);
            idsS = { eventId, mode: idsS.mode || 'camera', busy: false, showAll: idsS.showAll || false, flagOpen: false, flagNote: '', pending: null, last: null, stats: { pass: 0, review: 0, fail: 0 }, photoLive: false, seenLocal: {}, wedgeTimer: null };
            document.getElementById('idsPick').style.display = 'none';
            document.getElementById('idsScanBody').style.display = 'block';
            document.getElementById('idsScanEventName').textContent = ev ? ev.title + (ev.date ? ' · ' + ev.date : '') : eventId;
            idsSetMode(idsS.mode);
            idsRenderResult();
            idsRenderStats();
        }
        function idsChangeEvent() {
            if (idsS.pending && !idsFinish()) { idsToast('Finish the scan on screen first.'); return; }
            idsShowPicker();
        }
        async function closeIdScanner() {
            if (idsS.pending && !idsFinish()) { if (!confirm('Close without logging the scan on screen?')) return; idsS.pending = null; }
            idsCamStop();
            idsCam.torchWanted = false;
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
            idsTorchSetup();
            const hint = document.getElementById('idsCamHint');
            hint.style.color = 'var(--text-muted)';
            if (scanning) { hint.textContent = 'Hold the BACK of the ID (the barcode) steady in the frame.'; idsCam.paused = false; await idsScanLoopStart(); }
        }
        // Flashlight: the phone's LED via the camera's "torch" setting. Android Chrome supports it; browsers that
        // don't (iPhone Safari) report no torch capability, and the button says so instead of silently doing nothing.
        function idsTorchTrack() { return idsCam.stream && idsCam.stream.getVideoTracks()[0]; }
        function idsTorchSetup() {
            const track = idsTorchTrack();
            let caps = {};
            try { caps = (track && track.getCapabilities && track.getCapabilities()) || {}; } catch (err) { /* treat as unsupported */ }
            idsCam.torchOk = !!caps.torch;
            if (idsCam.torchOk && idsCam.torchWanted) idsApplyTorch(true); else idsTorchRender();
        }
        function idsTorchRender() {
            const b = document.getElementById('idsTorchBtn');
            if (!b) return;
            b.disabled = !idsCam.torchOk;
            b.textContent = !idsCam.torchOk ? '🔦 Light not supported here' : idsCam.torchWanted ? '🔦 Light on' : '🔦 Light';
            b.style.background = idsCam.torchOk && idsCam.torchWanted ? 'var(--neon-teal)' : 'rgba(0,0,0,0.6)';
            b.style.color = idsCam.torchOk && idsCam.torchWanted ? '#08080c' : '#fff';
        }
        async function idsApplyTorch(on) {
            const track = idsTorchTrack();
            try { await track.applyConstraints({ advanced: [{ torch: on }] }); idsCam.torchWanted = on; }
            catch (err) { idsCam.torchWanted = false; const h = document.getElementById('idsCamHint'); h.style.color = 'var(--danger-glow)'; h.textContent = 'Could not switch the light: ' + err.message; }
            idsTorchRender();
        }
        function idsToggleTorch() { if (idsCam.torchOk) idsApplyTorch(!idsCam.torchWanted); }
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
            idsS.last = null; idsS.flagOpen = false; idsS.flagNote = '';
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
            const result = idsResultOf(verdict.reasons);
            idsS.pending = { parsed, raw: text, recId: 's' + Date.now() + Math.random().toString(36).slice(2, 6), result, reasons: verdict.reasons.map(r => r.text), age: verdict.age, outOfState: verdict.outOfState, method, dupKey, hadPrior: !!prior, photo: '', decision: result === 'pass' ? 'admitted' : result === 'fail' ? 'denied' : '', eventId: idsS.eventId, eventTitle: ev ? ev.title : '', eventDate: ev ? ev.date : '', photoMode: cfg.photo };
            idsRenderResult();
            if (cfg.photo === 'off') idsFinish(); // nothing more to collect, so log it now (unless it needs a decision)
            logEvent('id_scan', 'Scanned an ID at ' + (ev ? ev.title : idsS.eventId) + ' (' + result + ')');
        }
        function idsShowError(msg) {
            idsS.pending = null; idsS.last = null;
            const box = document.getElementById('idsResult');
            box.innerHTML = `<div style="border:2px solid #ffb020; border-radius:16px; padding:16px; text-align:center;"><div style="font-size:1.6rem;">⚠️</div><p style="font-size:0.9rem; margin:8px 0 12px;">${escapeHtml(msg)}</p><button class="btn btn-sm" onclick="idsClearResult()">Try again</button></div>`;
        }
        function idsClearResult() { idsS.pending = null; idsS.last = null; idsS.flagOpen = false; idsS.flagNote = ''; idsCam.paused = false; idsRenderResult(); if (idsS.mode === 'wedge') document.getElementById('idsWedge').focus(); }
        function idsCanFinish() {
            const p = idsS.pending;
            return !!p && (p.result !== 'review' || !!p.decision) && (p.photoMode !== 'required' || !!p.photo);
        }
        function idsRenderResult() {
            const box = document.getElementById('idsResult'), p = idsS.pending || idsS.last, logged = !idsS.pending;
            if (!p) { box.innerHTML = '<p style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding:18px 0;">Ready to scan.</p>'; return; }
            const c = { pass: ['var(--neon-saguaro)', '✅', 'PASS'], review: ['#ff8a3d', '⚠️', 'CHECK THIS ID'], fail: ['var(--danger-glow)', '⛔', 'DO NOT ADMIT'] }[p.result];
            const x = p.parsed;
            const decided = p.decision && p.result === 'review';
            box.innerHTML = `
                <div style="border:2px solid ${c[0]}; border-radius:16px; padding:16px;">
                    <div style="text-align:center; font-family:'Outfit'; font-weight:800; font-size:1.3rem; color:${c[0]};">${c[1]} ${c[2]}</div>
                    <div style="text-align:center; margin:10px 0;">
                        <div style="font-family:'Outfit'; font-size:1.2rem; font-weight:700;">${escapeHtml([x.firstName, x.lastName].filter(Boolean).join(' '))}</div>
                        <div style="font-size:0.88rem; color:var(--text-secondary);">Born ${escapeHtml(idsFmtDate(x.dob))}${p.age != null ? ' · age ' + p.age : ''} · ${idsStateHtml(x.state, p.outOfState)}</div>
                        <div style="font-size:0.82rem; color:var(--text-muted);">Expires ${escapeHtml(idsFmtDate(x.expiry))}</div>
                    </div>
                    ${p.reasons.length ? '<ul style="font-size:0.84rem; padding-left:18px; margin-bottom:12px;">' + p.reasons.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul>' : ''}
                    <details style="margin-bottom:12px;" ${idsS.showAll ? 'open' : ''} ontoggle="idsS.showAll = this.open">
                        <summary style="cursor:pointer; font-size:0.8rem; color:var(--neon-teal);">View all barcode data</summary>
                        <table class="data-table" style="margin-top:8px; font-size:0.78rem;"><tbody>${idsFieldRows(x).map(r => `<tr><td style="padding:6px 8px; color:var(--text-muted); width:42%;">${escapeHtml(r[0])}</td><td style="padding:6px 8px; word-break:break-word;">${escapeHtml(r[1])}</td></tr>`).join('')}</tbody></table>
                        <p style="font-size:0.7rem; color:var(--text-muted); margin:8px 0 4px;">Raw barcode text</p>
                        <pre style="font-size:0.68rem; white-space:pre-wrap; word-break:break-all; background:rgba(0,0,0,0.35); border-radius:8px; padding:8px; max-height:160px; overflow:auto; margin:0;">${escapeHtml(idsShowRaw(p.raw))}</pre>
                        <p style="font-size:0.7rem; color:var(--text-muted); margin-top:6px;">${(parseInt(idsGlobal.fullDataHours, 10) || 0) > 0 ? 'The full card data is also kept for admins for ' + idsGlobal.fullDataHours + ' hours, then deleted.' : 'Shown on this screen only. Only the fields listed in the registry are saved; the ID number and address are not.'}</p>
                    </details>
                    ${p.flagged ? '<p style="text-align:center; font-size:0.8rem; color:var(--neon-pink); margin-bottom:10px;">🚩 Flagged for admin review</p>'
                        : idsS.flagOpen ? `<div style="margin-bottom:12px;"><textarea id="idsFlagNote" class="input-field" rows="3" maxlength="1000" style="margin:0 0 8px;" placeholder="What happened? (required)" oninput="idsS.flagNote = this.value">${escapeHtml(idsS.flagNote || '')}</textarea>
                            <div style="display:flex; gap:8px;"><button class="btn btn-magenta btn-sm" style="flex:1;" onclick="idsSendFlag()">Send flag</button><button class="btn btn-outline btn-sm" onclick="idsS.flagOpen = false; idsRenderResult()">Cancel</button></div>
                            <p style="font-size:0.7rem; color:var(--text-muted); margin-top:6px;">Admins review flags and decide whether this person goes on the Ban List.</p></div>`
                        : '<button class="btn btn-outline btn-sm" style="width:100%; margin-bottom:10px;" onclick="idsS.flagOpen = true; idsRenderResult()">🚩 Flag for Ban List review</button>'}
                    ${logged ? `<p style="text-align:center; font-size:0.78rem; color:var(--text-muted); margin-bottom:10px;">Logged to the registry${p.decision ? ' · ' + (p.decision === 'admitted' ? 'admitted' : 'denied') : ''}</p>` : ''}
                    ${!logged && p.result === 'review' ? `<div style="display:flex; gap:8px; margin-bottom:10px;">
                        <button class="btn btn-sm" style="flex:1; ${p.decision === 'admitted' ? '' : 'opacity:0.75;'}" onclick="idsDecide('admitted')">${p.decision === 'admitted' ? '✔ ' : ''}Admit</button>
                        <button class="btn btn-magenta btn-sm" style="flex:1; ${p.decision === 'denied' ? '' : 'opacity:0.75;'}" onclick="idsDecide('denied')">${p.decision === 'denied' ? '✔ ' : ''}Deny</button></div>` : ''}
                    ${!logged && p.photoMode !== 'off' ? `<div style="margin-bottom:10px;">${p.photo ? `<img src="${p.photo}" alt="" style="width:100%; max-height:200px; object-fit:contain; border-radius:10px; background:#000;">` : ''}
                        <button class="btn btn-outline btn-sm" style="width:100%; margin-top:6px;" onclick="idsPhotoBtn()">${idsS.photoLive ? '📸 Capture now' : p.photo ? '📷 Retake photo' : '📷 Take photo' + (p.photoMode === 'required' ? ' (required)' : ' (optional)')}</button></div>` : ''}
                    ${logged ? `<button class="btn" style="width:100%;" onclick="idsClearResult()">Scan next ›</button>` : `<button class="btn" style="width:100%;" id="idsNextBtn" ${idsCanFinish() ? '' : 'disabled'} onclick="idsFinish()">${p.result === 'review' && !decided ? 'Choose Admit or Deny' : p.photoMode === 'required' && !p.photo ? 'Take the photo first' : 'Log it & scan next ›'}</button>`}
                </div>`;
        }
        // Any staff member can flag the person on screen with a note. Nothing goes on the Ban List until an admin approves it.
        async function idsSendFlag() {
            const p = idsS.pending || idsS.last;
            if (!p) return;
            const note = (idsS.flagNote || '').trim();
            if (!note) { idsToast('Add a note about what happened.'); return; }
            const actor = logActor(), x = p.parsed, id = 'f' + Date.now() + Math.random().toString(36).slice(2, 6);
            const flag = {
                id, status: 'pending', createdAt: Date.now(), createdBy: { uid: actor ? actor.uid : '', name: actor ? actor.user : '' },
                eventId: p.eventId, eventTitle: p.eventTitle, eventDate: p.eventDate, scanId: p.recId,
                firstName: x.firstName, lastName: x.lastName, dob: x.dob, state: x.state, note: note.slice(0, 1000), env: IS_DEV_SITE ? 'dev' : 'prod'
            };
            try {
                await withTimeout(db.collection('idscan_flags').doc(id).set(cleanData(flag)), 15000, 'sending the flag');
                p.flagged = true; idsS.flagOpen = false; idsS.flagNote = '';
                idsRenderResult();
                idsToast('Flag sent to the admins.');
                logAction('Flagged someone for Ban List review at ' + (p.eventTitle || 'an event'));
            } catch (err) { alert('⚠️ The flag was NOT sent: ' + err.message); }
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
            const actor = logActor(), x = p.parsed, id = p.recId || 's' + Date.now() + Math.random().toString(36).slice(2, 6);
            const seenId = p.dupKey ? p.eventId + '__' + p.dupKey : '';
            const rec = {
                id, eventId: p.eventId, eventTitle: p.eventTitle, eventDate: p.eventDate, scannedAt: Date.now(),
                scannedBy: { uid: actor ? actor.uid : '', name: actor ? actor.user : '' }, method: p.method,
                firstName: x.firstName, lastName: x.lastName, lastLower: idsNormName(x.lastName), firstLower: idsNormName(x.firstName),
                dob: x.dob, ageAtScan: p.age, state: x.state, outOfState: !!p.outOfState, country: x.country, expiry: x.expiry,
                result: p.result, decision: p.decision, reasons: p.reasons, hasPhoto: !!p.photo, seenId, env: IS_DEV_SITE ? 'dev' : 'prod'
            };
            idsS.seenLocal[p.dupKey] = { at: rec.scannedAt, result: p.result };
            const batch = db.batch();
            const fullHours = parseInt(idsGlobal.fullDataHours, 10) || 0;
            if (fullHours > 0 && x.fields) { // an admin chose to keep everything on the card for a limited time
                const expireMs = rec.scannedAt + fullHours * 3600000;
                rec.hasFull = true; rec.fullExpireAt = expireMs;
                batch.set(db.collection('idscan_full').doc(id), { id, uid: rec.scannedBy.uid, scannedAt: rec.scannedAt, expireAt: firebase.firestore.Timestamp.fromMillis(expireMs), iin: x.iin, aamvaVersion: x.aamvaVersion, country: x.country, fields: x.fields, raw: p.raw || '' });
            }
            batch.set(db.collection('idscans').doc(id), cleanData(rec));
            if (p.photo) batch.set(db.collection('idscan_photos').doc(id), { id, uid: rec.scannedBy.uid, photo: p.photo });
            // Not saved and not retried on failure (offline). The registry record is what matters, so it is written on its own below.
            batch.commit().catch(err => { console.error('ID scan not saved:', err); alert('⚠️ That scan was NOT saved to the registry: ' + err.message + '\n\nIt was for ' + x.firstName + ' ' + x.lastName + ' (' + p.result + '). Write it down and tell an admin.'); });
            if (seenId && !p.hadPrior) db.collection('idscan_seen').doc(seenId).set({ eventId: p.eventId, uid: rec.scannedBy.uid, at: rec.scannedAt, result: p.result }).catch(() => {});
        }
