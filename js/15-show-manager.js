        /* SHOW MANAGER — the second module of the app.
           Switched to from the name dropdown (Show Manager / Security). It has its own list of
           shows (same flyer-tile look as the security Events feed, but a separate collection),
           and inside each show a floorplan of the venue where tables can be dragged around,
           guests are typed in per table, and each person is checked off as they arrive.

           DATA (all plain Firestore collections, covered by the signed-in catch-all rule):
             venues/{id}      { id, name, address, building: { items[], w, h } }   <- building = the venue's walls & zones only (optional)
             floorplans/{id}  { id, venueId, name, items[], w, h, updatedAt }   <- saved layouts, several per venue
             shows/{id}       { id, title, date, startTime, endTime, venueId, venueName, image, ticketLink,
                                desc, tags[], floorplanId, floorplanName,
                                layout: { items[] },          <- this show's own copy of the room
                                standing: n,                  <- walk-ins with no table (general admission tally, written with increment())
                                guests: { [bookingId]: { id, name (purchaser), tableId ('' = on the waiting list), size (people in the party), arrived (how many are here), arrivedAt, wasTable (label of the table they were taken off) } } }
           Layout items: { id, type: 't2'|'t4'|'t6'|'bar'|'stage', x, y, rot, num (label), shape ('round'|'square', tables), seats (bar), w/h/label (stage + zone), kind (zone/line), flip (door swing in/out), flipH (door hinge side) }.
           Piece types: seating (t2/t4/t6/bar) holds guests; 'stage' and 'zone' are resizable room areas (bar counter, bathrooms,
           green room, bar storage, A/V booth, patio...); 'line' is a wall, doorway, garage door or curtain (w = length, h = thickness).
           Each layout also has its own room size: layout.w / layout.h (default 1000 x 640 units), saved with floorplans.
           x/y are the item's centre on a fixed 1000 x 640 canvas.

           A "guest" entry is really a BOOKING: one purchaser's name plus how many people are in the party, and a count of
           how many have arrived so far (the party need not arrive together). Older entries - one per person with a true/false
           `arrived` - still load: they read as a party of 1. When the people arrived at a table exceed its seats, the host
           gets a popup to charge the purchaser for the extra guest.
           Bookings are a MAP on the show doc and are written with dotted field paths ('guests.<id>.arrived', using Firestore
           increment()), so two phones checking people in at once never overwrite each other, and moving a table (which only
           writes 'layout.items') never touches them.

           WEEKLY SHOWS: a show can repeat weekly (repeat: 'weekly'). Every week is its OWN show doc - own date, own layout, own
           bookings - so nothing is ever reset or overwritten; last week's doc simply stays in the list as history (guests,
           party sizes, arrivals) for analytics. All the weeks of one run share `seriesId` (the first week's id). The run is
           alive while its NEWEST week says repeat: 'weekly'. `smRolloverSweep` runs whenever the shows load: once the newest
           week's date has arrived, it creates the next week (same details, last week's layout, no guests, layoutPending: true
           so the host is nudged to pick/keep a layout). The new doc's id is `<seriesId>_<date>` and it's written in a
           transaction, so two phones opening the app together can't create it twice. Weeks nobody opened the app for are skipped.

           PAGES: an open show has Floor / Tables / Guests / Show pages (smPage). The Venues page can open a saved layout, or a venue's
           "building" (walls & zones only), in the same map editor without a show (smEditTarget / smEditDoc / smLayoutUpdate).
           Bookings with tableId '' (or whose table is gone) form the WAITING LIST; show.standing is the walk-in (no table) tally.

           These three collections are deliberately NOT in allCollections (js/03): they are loaded by
           their own listeners the first time someone opens the module, so security-only users pay nothing. */

        const SM_GRID = 10, SM_DEF_W = 1000, SM_DEF_H = 640, SM_CANVAS_MIN = 400, SM_CANVAS_MAX = 3000;
        const SM_DEFAULT_IMG = 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=700';
        // Every top-level view of the security module - hidden while the Show Manager is open.
        const SM_SECURITY_VIEWS = ['eventsFeedView', 'eventDetailView', 'calendarView', 'teamChatView', 'banListView', 'myShiftsView', 'contactsDirectoryView', 'licensesView', 'dashboardView', 'settingsView', 'adminConsoleView'];
        // Quick sizes for a stage piece; the width/height boxes and the corner handle fine-tune from there.
        const SM_STAGE_PRESETS = { runway: { w: 440, h: 70, label: 'RUNWAY' }, square: { w: 240, h: 240, label: 'STAGE' }, wide: { w: 320, h: 110, label: 'STAGE' } };
        const SM_ZONE_MIN = 30;
        // Room areas (resizable rectangles) and line pieces (walls, openings) the builder can place.
        const SM_ZONES = {
            stage:      { label: 'Stage',       w: 320, h: 110, fill: 'rgba(121,40,202,0.45)',  stroke: '#be78ff' },
            barcounter: { label: 'Bar',         w: 280, h: 50,  fill: 'rgba(255,176,32,0.32)',  stroke: '#ffb020' },
            bathroom:   { label: 'Bathrooms',   w: 130, h: 100, fill: 'rgba(79,195,247,0.30)',  stroke: '#4fc3f7' },
            greenroom:  { label: 'Green room',  w: 150, h: 110, fill: 'rgba(0,255,135,0.22)',   stroke: '#00ff87' },
            storage:    { label: 'Bar storage', w: 110, h: 80,  fill: 'rgba(160,140,120,0.35)', stroke: '#b8a58e' },
            av:         { label: 'A/V booth',   w: 110, h: 70,  fill: 'rgba(255,122,60,0.32)',  stroke: '#ff7a3c' },
            patio:      { label: 'Patio',       w: 280, h: 190, fill: 'rgba(120,200,80,0.14)',  stroke: '#8fd45a', dash: '10 7' },
            area:       { label: 'Area',        w: 200, h: 150, fill: 'rgba(255,255,255,0.07)', stroke: 'rgba(255,255,255,0.55)', dash: '4 4' }
        };
        const SM_LINES = {
            wall:    { label: 'Wall',        len: 200, thick: 10 },
            door:    { label: 'Doorway',     len: 60,  thick: 8 },
            garage:  { label: 'Garage door', len: 160, thick: 12 },
            curtain: { label: 'Curtain',     len: 200, thick: 8 }
        };
        const SM_OWN_VIEWS = ['smShowsView', 'smShowView', 'smVenuesView'];
        const SM_TYPES = {
            t2: { label: '2-top', cap: 2 }, t4: { label: '4-top', cap: 4 }, t6: { label: '6-top', cap: 6 },
            bar: { label: 'Bar seats', cap: 6 }, stage: { label: 'Stage', cap: 0 }
        };

        window._module = 'security';
        let smTab = 'shows';          // 'shows' | 'venues' (only matters while no show is open)
        let smShowId = null;          // the open show, or null for the list
        let smShellId = null;         // which show the show-view shell was built for
        let smSeenShow = false, smOpenedAt = 0; // a just-created show may reach the listener a moment after we open it
        let smMode = 'seat';          // 'seat' = seating & check-in, 'layout' = move/add tables
        let smPage = 'floor';         // which page of an open show is showing: 'floor' | 'tables' | 'guests' | 'show'
        let smEditTarget = null;      // { kind: 'plan' | 'building', id }: the Venues page is editing a saved layout (or a venue's walls & zones) instead of a show
        let smNewShape = 'round';     // shape given to newly added tables
        let smQa = null;              // the quick add / seat-picker dialog: { mode: 'add' | 'seat', gid }
        let smSelId = null;           // selected layout item
        let smZoom = 1, smFitKey = '';
        let smFilter = { q: '', pending: false, hideEmpty: false };
        let smTableOpenId = null;     // the table whose popup is open
        let smDrag = null;
        let smListening = false;
        const smLoaded = { shows: false, venues: false, floorplans: false };
        let smDataError = '';
        let smSyncCount = 0, smSyncErr = '';
        let smHeadSig = '', smPanelSig = '';
        let smFormTags = [], smFormEditId = null;
        let smPieceGrowX = 'both', smPieceGrowY = 'both'; // which side(s) of a selected room area / wall the typed Width / Height changes happen at
        let smGrowX = 'right', smGrowY = 'bottom'; // which side(s) of the room Width / Depth changes happen at (remembered while the app is open)

        try { if (localStorage.getItem('ss_smShape') === 'square') smNewShape = 'square'; } catch (err) { /* ignore */ }
        const smEl = id => document.getElementById(id);
        const smClone = o => JSON.parse(JSON.stringify(o));
        const smShows = () => getDB('shows');
        const smVenues = () => getDB('venues');
        const smPlans = () => getDB('floorplans');
        const smCurShow = () => smEditTarget ? smEditDoc() : smShows().find(s => s.id === smShowId);
        // While a saved layout (or a venue's building) is open in the editor, it stands in for a show: same room, no guests.
        // layout points straight at the saved doc (a floorplan, or venue.building), which already has items / w / h.
        function smEditDoc() {
            const t = smEditTarget; if (!t) return null;
            if (t.kind === 'plan') { const p = smPlans().find(x => x.id === t.id); return p ? { id: 'layout:' + p.id, title: p.name, venueId: p.venueId, layout: p, guests: {}, virtual: true } : null; }
            const v = smVenues().find(x => x.id === t.id);
            return v && v.building ? { id: 'building:' + v.id, title: v.name, venueId: v.id, layout: v.building, guests: {}, virtual: true } : null;
        }
        const smItems = show => (show && show.layout && show.layout.items) || [];
        // A booking: purchaser name, party size, and how many of the party have arrived. Older per-person entries (arrived: true/false) read as a party of 1.
        const smNormBooking = g => {
            const size = Math.max(1, parseInt(g.size, 10) || 1);
            const rawNum = typeof g.arrived === 'number';
            return { ...g, size, arrived: rawNum ? Math.max(0, g.arrived) : (g.arrived ? size : 0), rawNum };
        };
        const smGuests = show => Object.values((show && show.guests) || {}).filter(g => g && g.name).map(smNormBooking);
        const smUid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const smIsSeat = it => it.type === 't2' || it.type === 't4' || it.type === 't6' || it.type === 'bar';
        const smIsLine = it => it.type === 'line';
        const smIsZone = it => it.type === 'stage' || it.type === 'zone';
        const smKind = it => it.type === 'stage' ? 'stage' : it.kind;
        const smPieceName = it => smIsLine(it) ? (SM_LINES[it.kind] || SM_LINES.wall).label : smIsZone(it) ? (SM_ZONES[smKind(it)] || SM_ZONES.area).label : smItemName(it);
        // Size of the room for a show (each layout has its own; older ones use the default).
        const smCV = show => { const l = ((show || smCurShow() || {}).layout) || {}; return { w: l.w || SM_DEF_W, h: l.h || SM_DEF_H }; };
        const smCap = it => it.type === 'bar' ? Math.max(1, it.seats || 6) : (SM_TYPES[it.type] ? SM_TYPES[it.type].cap : 0);
        const smNatural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
        const smItemName = it => (it.type === 'bar' ? 'Bar ' : 'Table ') + (it.num || '?');
        // 'round' or 'square'. Tables saved before shapes existed: 2- and 4-tops were round, 6-tops were a (rounded) rectangle.
        const smShape = it => it.shape === 'round' || it.shape === 'square' ? it.shape : (it.type === 't6' ? 'square' : 'round');
        const smShowRef = () => db.collection('shows').doc(smShowId);

        // ---------- MODULE SWITCH (name dropdown) ----------
        function smSetModuleUI(m) {
            window._module = m;
            document.body.classList.toggle('module-shows', m === 'shows');
            const tag = smEl('brandTagline');
            if (tag) {
                if (!tag.dataset.orig) tag.dataset.orig = tag.textContent;
                tag.textContent = m === 'shows' ? 'SHOW MANAGER' : tag.dataset.orig;
            }
            const a = smEl('modItemSecurity'), b = smEl('modItemShows');
            if (a) a.classList.toggle('mod-current', m === 'security');
            if (b) b.classList.toggle('mod-current', m === 'shows');
            try { localStorage.setItem('ss_module', m); } catch (err) { /* storage blocked - just won't be remembered */ }
        }
        function smHideOwnViews() { SM_OWN_VIEWS.forEach(id => { const el = smEl(id); if (el) el.style.display = 'none'; }); }

        function switchModule(m) {
            closeUserMenu();
            if (m === 'shows') {
                if (window._module !== 'shows') smEnter();
            } else if (window._module === 'shows') {
                switchView('eventsFeed'); // switchView leaves the Show Manager itself
            }
        }
        function smEnter() {
            smSetModuleUI('shows');
            SM_SECURITY_VIEWS.forEach(id => { const el = smEl(id); if (el) el.style.display = 'none'; });
            document.querySelectorAll('.dock-item').forEach(i => { if (i.closest('#smDock')) return; i.classList.remove('active'); });
            try { const saved = localStorage.getItem('ss_smShow'); if (saved && !smShowId) smShowId = saved; } catch (err) { /* ignore */ }
            smEnsureListeners();
            trackView('showManagerView');
            smRender();
            window.scrollTo({ top: 0 });
        }
        // Called once after sign-in so a refresh at the door lands back in the Show Manager.
        function smRestoreModuleOnce() {
            if (window._moduleRestored || !currUser()) return;
            window._moduleRestored = true;
            try { if (localStorage.getItem('ss_module') === 'shows') smEnter(); } catch (err) { /* ignore */ }
        }

        function smEnsureListeners() {
            if (smListening) return;
            smListening = true;
            ['shows', 'venues', 'floorplans'].forEach(col => {
                if (!window.ss_state[col]) window.ss_state[col] = [];
                db.collection(col).onSnapshot(snap => {
                    window.ss_state[col] = snap.docs.map(d => d.data());
                    smLoaded[col] = true;
                    smDataError = '';
                    smOnData();
                }, err => {
                    console.error(`Listener error [${col}]:`, err);
                    smDataError = err.message;
                    smOnData();
                });
            });
        }
        function smOnData() {
            if (window._module === 'shows' && !smDrag) smRender();
            if (smLoaded.shows) setTimeout(smRolloverSweep, 0);
        }

        // ---------- WEEKLY SHOWS (a fresh show doc each week; old weeks stay as history) ----------
        const smSweepTried = {};   // new show id -> when we last tried to create it (don't hammer a failing write)
        let smSweeping = false;
        function smAddDays(dateStr, n) {
            const [y, m, d] = String(dateStr).split('-').map(Number);
            return dayKey(new Date(y, m - 1, d + n, 12)); // noon: a daylight-saving jump can't slip the date
        }
        // All the weeks of the run this show belongs to, oldest first.
        const smSeriesOf = show => {
            const sid = show.seriesId || show.id;
            return smShows().filter(s => (s.seriesId || s.id) === sid).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        };
        function smRolloverSweep() {
            if (smSweeping || !smLoaded.shows || !currUser()) return;
            const today = dayKey(new Date());
            const newest = {};
            smShows().forEach(s => {
                if (!s.date || !(s.repeat || s.seriesId)) return;
                const sid = s.seriesId || s.id;
                if (!newest[sid] || s.date > newest[sid].date) newest[sid] = s;
            });
            const jobs = [];
            Object.keys(newest).forEach(sid => {
                const src = newest[sid];
                if (src.repeat !== 'weekly' || src.date > today) return; // stopped, or next week already exists
                let date = smAddDays(src.date, 7);
                while (date < today) date = smAddDays(date, 7);          // skip weeks nobody opened the app for
                const id = sid + '_' + date;
                if (Date.now() - (smSweepTried[id] || 0) < 30000) return;
                smSweepTried[id] = Date.now();
                const next = {
                    id, title: src.title, date, startTime: src.startTime || '', endTime: src.endTime || '',
                    venueId: src.venueId || '', venueName: src.venueName || '', image: src.image || SM_DEFAULT_IMG,
                    ticketLink: src.ticketLink || '', desc: src.desc || '', tags: [...(src.tags || [])],
                    floorplanId: src.floorplanId || '', floorplanName: src.floorplanName || '',
                    layout: { items: smClone(smItems(src)), w: smCV(src).w, h: smCV(src).h }, guests: {},
                    repeat: 'weekly', seriesId: sid, layoutPending: true, createdAt: Date.now(), createdBy: 'Weekly auto-create'
                };
                const ref = db.collection('shows').doc(id);
                jobs.push(withTimeout(db.runTransaction(async tx => {
                    const snap = await tx.get(ref);
                    if (snap.exists) return false; // another phone got there first
                    tx.set(ref, cleanData(next));
                    return true;
                }), 15000, 'creating this week\'s show').then(made => { if (made) logAction('Auto-created weekly show: ' + next.title + ' (' + date + ')'); })
                  .catch(err => console.warn('Weekly show not created yet:', err.message)));
            });
            if (!jobs.length) return;
            smSweeping = true;
            Promise.all(jobs).finally(() => { smSweeping = false; });
        }

        // ---------- ROUTER ----------
        function smGoTab(t) {
            smTab = t; smShowId = null; smShellId = null; smEditTarget = null; smQa = null;
            try { localStorage.removeItem('ss_smShow'); } catch (err) { /* ignore */ }
            smRender();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        function smOpenShow(id) {
            smEditTarget = null; smShowId = id; smShellId = null; smSeenShow = false; smOpenedAt = Date.now();
            try { localStorage.setItem('ss_smShow', id); } catch (err) { /* ignore */ }
            smRender();
            window.scrollTo({ top: 0 });
        }
        function smCloseShow() { smGoTab('shows'); }
        // Venues page -> the layout editor (a saved layout, or a venue's building = its walls & zones), no show needed.
        function smOpenLayoutEditor(kind, id) {
            smEditTarget = { kind, id }; smShowId = 'edit:' + kind + ':' + id; smShellId = null; smSeenShow = false; smOpenedAt = Date.now(); smQa = null;
            try { localStorage.removeItem('ss_smShow'); } catch (err) { /* ignore */ }
            smRender();
            window.scrollTo({ top: 0 });
        }
        function smCloseEditor() { smGoTab('venues'); }

        function smRender() {
            if (window._module !== 'shows') return;
            let show = null;
            if (smShowId) {
                show = smCurShow();
                if (show) smSeenShow = true;
                else if (smLoaded.shows) {
                    // Gone (deleted elsewhere / stale remembered id) - but give a show we just created a few seconds to arrive.
                    if (smSeenShow || Date.now() - smOpenedAt > 4000) { smShowId = null; smEditTarget = null; try { localStorage.removeItem('ss_smShow'); } catch (err) { /* ignore */ } }
                    else setTimeout(smRender, 4200);
                }
            }
            const showOpen = !!smShowId;
            smEl('smShowsView').style.display = (!showOpen && smTab === 'shows') ? 'block' : 'none';
            smEl('smVenuesView').style.display = (!showOpen && smTab === 'venues') ? 'block' : 'none';
            smEl('smShowView').style.display = showOpen ? 'block' : 'none';
            document.querySelectorAll('#smDock .dock-item').forEach(b => b.classList.toggle('active', b.dataset.smtab === (showOpen ? (smEditTarget ? 'venues' : 'shows') : smTab)));
            if (showOpen) smRenderShow(show);
            else if (smTab === 'shows') smRenderShowList();
            else smRenderVenues();
        }

        // ---------- SHOW LIST (same flyer tiles as the security Events feed) ----------
        function smGuestStats(show) {
            const gs = smGuests(show);
            return { total: gs.reduce((n, g) => n + g.size, 0), arrived: gs.reduce((n, g) => n + g.arrived, 0) };
        }
        function smImgLoaded(img) {
            const tile = img.closest('.ev2'), list = smEl('smShowList');
            if (!tile || !img.naturalWidth || !list) return;
            evImgInfo[img.getAttribute('src')] = { w: img.naturalWidth, h: img.naturalHeight };
            const box = evBox(list.clientWidth);
            evSetMode(tile, evMode(img.getAttribute('src'), box.w, box.h));
        }
        function smRenderShowList() {
            const listEl = smEl('smShowList');
            if (smDataError) { listEl.innerHTML = `<p style="color:var(--danger-glow); padding:20px 4px;">Couldn't load shows: ${escapeHtml(smDataError)}</p>`; return; }
            if (!smLoaded.shows) { listEl.innerHTML = `<p style="color:var(--text-muted); padding:20px 4px;">Loading shows…</p>`; return; }
            const today = dayKey(new Date());
            const all = smShows();
            const upcoming = all.filter(s => (s.date || '') >= today).sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
            const past = all.filter(s => (s.date || '') < today).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            const summary = smEl('smShowsSummary');
            if (summary) summary.innerHTML = all.length ? `<strong style="color:var(--text-primary);">${upcoming.length}</strong> upcoming &middot; ${past.length} past` : 'Seating charts &amp; guest check-in';
            const boxW = listEl.clientWidth, box = evBox(boxW);
            let html = '', lastGroup = null, idx = 0;
            const tile = (s, isPast) => {
                const group = isPast ? 'PAST SHOWS' : evGroupLabel(s);
                if (group !== lastGroup) {
                    lastGroup = group;
                    const n = (isPast ? past : upcoming).filter(x => (isPast ? 'PAST SHOWS' : evGroupLabel(x)) === group).length;
                    html += `<div class="ev2-group">${escapeHtml(group)} <small>${n} show${n === 1 ? '' : 's'}</small></div>`;
                }
                const st = smGuestStats(s), dp = evDateParts(s), mode = evMode(s.image, box.w, box.h);
                const status = st.total === 0 ? ['full', 'NO BOOKINGS YET'] : st.arrived === st.total ? ['in', `ALL ${st.total} HERE`] : ['open', `${st.arrived} / ${st.total} HERE`];
                const titleHtml = `<h3 class="ev2-name">${escapeHtml(s.title)}</h3>`;
                const hours = shiftHoursLabel(s);
                const cls = ['ev2', 'event-tile', mode === 'poster' ? 'is-poster' : '', isPast ? 'is-full' : '', group === 'TONIGHT' ? 'is-tonight' : ''].filter(Boolean).join(' ');
                html += `
                <div class="${cls}" style="animation-delay:${Math.min(idx++, 8) * 45}ms" role="button" tabindex="0" onclick="smOpenShow('${escapeHtml(jsStr(s.id))}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();smOpenShow('${escapeHtml(jsStr(s.id))}');}">
                    <div class="ev2-in">
                        <div class="ev2-media">
                            <div class="ev2-bg" style="background-image:url(&quot;${escapeHtml(evCssUrl(s.image || SM_DEFAULT_IMG))}&quot;)"></div>
                            <img src="${escapeHtml(s.image || SM_DEFAULT_IMG)}" alt="" loading="lazy" onload="smImgLoaded(this)" onerror="this.onerror=null;this.src='${escapeHtml(jsStr(SM_DEFAULT_IMG))}'">
                            ${dp ? `<div class="ev2-date"><span class="w">${dp.wk}</span><span class="d">${dp.day}</span><span class="m">${dp.mon}</span></div>` : ''}
                            <div class="ev2-status ${status[0]}"><i></i>${status[1]}</div>
                            ${mode === 'poster' ? '' : titleHtml}
                        </div>
                        <div class="ev2-body">
                            ${mode === 'poster' ? titleHtml : ''}
                            <div class="ev2-meta"><span>🕘 ${escapeHtml(shiftTimeLabel(s))}${hours ? ' &middot; ' + escapeHtml(hours) : ''}</span><span class="go">Seating ›</span></div>
                            ${s.venueName ? `<div style="font-size:0.8rem; color:var(--text-secondary);">📍 ${escapeHtml(s.venueName)}${s.repeat === 'weekly' ? ' &middot; 🔁 Weekly' : ''}</div>` : (s.repeat === 'weekly' ? `<div style="font-size:0.8rem; color:var(--text-secondary);">🔁 Weekly</div>` : '')}
                            ${s.layoutPending && !isPast ? `<div style="font-size:0.78rem; color:#ffb020;">🗺️ Layout not chosen for this week yet</div>` : ''}
                            ${st.total > 0 ? `<div class="ev2-fill"><div class="ev2-bar"><i style="width:${Math.round(st.arrived / st.total * 100)}%"></i></div><span>${st.arrived} of ${st.total} arrived</span></div>` : ''}
                            ${(s.tags || []).length ? `<div class="tags-container" style="margin:0;">${s.tags.map(t => `<span class="neon-tag ${t === 'NSFW' || t === 'Kink' ? 'tag-nsfw' : 'tag-active'}">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                        </div>
                    </div>
                </div>`;
            };
            upcoming.forEach(s => tile(s, false));
            lastGroup = null;
            past.forEach(s => tile(s, true));
            listEl.innerHTML = html || `<p style="color:var(--text-muted); text-align:center; padding:30px 10px;">No shows yet. Tap "+ New Show" to add the first one.</p>`;
        }

        // ---------- SHOW CREATE / EDIT MODAL ----------
        function smFillVenueSelect(selectedId) {
            const sel = smEl('smfVenue');
            const cur = selectedId !== undefined ? selectedId : sel.value;
            const venues = [...smVenues()].sort((a, b) => smNatural(a.name, b.name));
            sel.innerHTML = `<option value="">— No venue —</option>` + venues.map(v => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('') + `<option value="__new">➕ New venue…</option>`;
            sel.value = venues.some(v => v.id === cur) ? cur : '';
        }
        function smFillPlanSelect() {
            const vid = smEl('smfVenue').value, sel = smEl('smfPlan');
            const plans = smPlans().filter(p => p.venueId === vid).sort((a, b) => smNatural(a.name, b.name));
            sel.innerHTML = `<option value="">Blank — I'll add tables myself</option>` + plans.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
            sel.disabled = !vid;
        }
        async function smVenueChanged() {
            const sel = smEl('smfVenue');
            if (sel.value === '__new') {
                const name = await askText({ title: '📍 New venue', message: 'Name of the new venue:', okText: 'Add venue' });
                if (!name || !name.trim()) { sel.value = ''; smFillPlanSelect(); return; }
                const v = { id: smUid('v'), name: name.trim(), address: '' };
                saveDoc('venues', v.id, v).catch(() => {});
                // The live listener hasn't delivered it yet - add the option by hand and select it.
                const opt = document.createElement('option'); opt.value = v.id; opt.textContent = v.name;
                sel.insertBefore(opt, sel.querySelector('option[value="__new"]'));
                sel.value = v.id;
            }
            smFillPlanSelect();
        }
        function smRenderFormTags() {
            smEl('smfTags').innerHTML = getTagCatalog().map(t => `<span class="neon-tag ${smFormTags.includes(t) ? 'tag-active' : 'tag-inactive'}" style="cursor:pointer;" onclick="smToggleFormTag('${escapeHtml(jsStr(t))}')">${smFormTags.includes(t) ? '✓ ' : ''}${escapeHtml(t)}</span>`).join('') || '<span style="color:var(--text-muted); font-size:0.8rem;">No tags in the catalog yet.</span>';
        }
        function smToggleFormTag(t) {
            smFormTags = smFormTags.includes(t) ? smFormTags.filter(x => x !== t) : [...smFormTags, t];
            smRenderFormTags();
        }
        function smOpenShowModal(editId) {
            smEnsureListeners();
            const s = editId ? smShows().find(x => x.id === editId) : null;
            smFormEditId = s ? s.id : null;
            smEl('smShowModalTitle').textContent = s ? 'Edit Show' : 'New Show';
            smEl('smfSave').textContent = s ? 'Save Changes' : 'Create Show';
            smEl('smfErr').style.display = 'none';
            smEl('smfTitle').value = s ? s.title : '';
            smEl('smfDate').value = s ? s.date : dayKey(new Date());
            smEl('smfRepeat').value = s && s.repeat === 'weekly' ? 'weekly' : '';
            smEl('smfStart').value = s ? (s.startTime || '') : '';
            smEl('smfEnd').value = s ? (s.endTime || '') : '';
            smEl('smfImage').value = s ? (s.image || '') : '';
            smEl('smfTicket').value = s ? (s.ticketLink || '') : '';
            smEl('smfDesc').value = s ? (s.desc || '') : '';
            smFormTags = s ? [...(s.tags || [])] : [];
            smRenderFormTags();
            smFillVenueSelect(s ? (s.venueId || '') : '');
            smFillPlanSelect();
            smEl('smfPlanRow').style.display = s ? 'none' : 'block';
            smEl('smShowModal').style.display = 'flex';
        }
        function smSaveShowForm() {
            const errEl = smEl('smfErr');
            const showErr = m => { errEl.textContent = m; errEl.style.display = 'block'; };
            const title = smEl('smfTitle').value.trim(), date = smEl('smfDate').value;
            if (!title) { showErr('Show title is required.'); return; }
            if (!date) { showErr('Show date is required.'); return; }
            errEl.style.display = 'none';
            const venueId = smEl('smfVenue').value;
            const venue = smVenues().find(v => v.id === venueId);
            const venueName = venue ? venue.name : (smEl('smfVenue').selectedOptions[0] && venueId ? smEl('smfVenue').selectedOptions[0].textContent : '');
            const fields = {
                title, date, startTime: smEl('smfStart').value, endTime: smEl('smfEnd').value,
                venueId, venueName, image: smEl('smfImage').value.trim() || SM_DEFAULT_IMG,
                ticketLink: smEl('smfTicket').value.trim(), desc: smEl('smfDesc').value.trim(), tags: smFormTags
            };
            const btn = smEl('smfSave'), label = btn.textContent;
            btn.disabled = true; btn.textContent = 'Saving…';
            const repeat = smEl('smfRepeat').value; // '' or 'weekly'
            let job;
            if (smFormEditId) {
                // Merge only the details so a check-in landing at the same moment isn't overwritten.
                const cur = smShows().find(x => x.id === smFormEditId);
                const upd = { ...fields, repeat };
                if (repeat === 'weekly' && cur && !cur.seriesId) upd.seriesId = cur.id;
                const batch = db.batch();
                batch.update(db.collection('shows').doc(smFormEditId), cleanData(upd));
                // Repeating belongs to the whole run: it lives on the newest week, wherever you flip it.
                if (cur && (cur.repeat || '') !== repeat) {
                    const newest = smSeriesOf(cur).pop();
                    if (newest && newest.id !== cur.id) batch.update(db.collection('shows').doc(newest.id), { repeat, seriesId: cur.seriesId || cur.id });
                }
                job = withTimeout(batch.commit(), 15000, 'saving the show');
            } else {
                const plan = smPlans().find(p => p.id === smEl('smfPlan').value);
                const newId = smUid('s');
                const show = {
                    id: newId, ...fields, repeat, seriesId: repeat === 'weekly' ? newId : '', createdAt: Date.now(), createdBy: (currUser() || {}).name || '',
                    floorplanId: plan ? plan.id : '', floorplanName: plan ? plan.name : '',
                    layout: { items: plan ? smClone(plan.items || []) : [], w: plan ? (plan.w || SM_DEF_W) : SM_DEF_W, h: plan ? (plan.h || SM_DEF_H) : SM_DEF_H }, guests: {}
                };
                job = saveDoc('shows', show.id, show).then(() => { smFormEditId = show.id; });
            }
            job.then(() => {
                logAction((smEl('smShowModalTitle').textContent === 'New Show' ? 'Created show: ' : 'Updated show: ') + title, 'action');
                const openId = smFormEditId;
                closeModal('smShowModal');
                if (openId && !smShowId) smOpenShow(openId);
            }).catch(err => showErr('Could not save: ' + err.message))
              .finally(() => { btn.disabled = false; btn.textContent = label; });
        }
        function smDeleteShow() {
            const show = smCurShow(); if (!show) return;
            const n = smGuests(show).length;
            const weeks = smSeriesOf(show), isNewest = weeks[weeks.length - 1].id === show.id;
            const stopsRun = show.repeat === 'weekly' && isNewest;
            if (!confirm(`Delete "${show.title}"${n ? ` and its ${n} guest${n === 1 ? '' : 's'}` : ''}? This can't be undone.` +
                (stopsRun ? `\n\nThis is the newest week of a weekly show, so deleting it also stops the show repeating (earlier weeks and their guest history are kept). You can turn "Repeat" back on from Edit details on any week.` : '') +
                (!stopsRun && weeks.length > 1 ? `\n\nThis removes this week's guest history from the show's record.` : ''))) return;
            deleteDoc('shows', show.id).then(() => {
                const prev = stopsRun ? weeks[weeks.length - 2] : null;
                if (prev) db.collection('shows').doc(prev.id).update({ repeat: '' }).catch(() => {});
                logAction('Deleted show: ' + show.title); smCloseShow();
            }).catch(() => {});
        }

        // ---------- WRITES (small, field-level, with a visible sync status) ----------
        function smSyncUi() {
            const el = smEl('smSync'); if (!el) return;
            if (smSyncCount > 0) { el.textContent = 'Saving…'; el.style.color = 'var(--text-muted)'; }
            else if (smSyncErr) { el.textContent = '⚠ ' + smSyncErr; el.style.color = '#ffb020'; }
            else { el.textContent = '✓ Saved'; el.style.color = 'var(--neon-saguaro)'; }
        }
        function smWrite(promise) {
            smSyncCount++; smSyncUi();
            return withTimeout(promise, 15000, 'saving')
                .then(() => { smSyncErr = ''; })
                .catch(err => {
                    console.error('Show Manager write failed:', err);
                    if (/Timed out/.test(err.message)) smSyncErr = "No connection — your change is on this device and will sync when you're back online.";
                    else { smSyncErr = ''; alert('⚠️ Could not save: ' + err.message); }
                })
                .finally(() => { smSyncCount--; smSyncUi(); });
        }
        // Writes to the room's layout. For a show the keys are 'layout.items' / 'layout.w' / 'layout.h' (plus any guest paths);
        // for a saved layout or a venue's building they land on that document instead.
        function smLayoutUpdate(upd) {
            const t = smEditTarget;
            if (!t) return smShowRef().update(upd);
            const pre = t.kind === 'building' ? 'building.' : '', out = {};
            ['items', 'w', 'h'].forEach(k => { if (('layout.' + k) in upd) out[pre + k] = upd['layout.' + k]; });
            if (t.kind === 'plan') out.updatedAt = Date.now();
            return db.collection(t.kind === 'plan' ? 'floorplans' : 'venues').doc(t.id).update(out);
        }
        function smSaveItems(items) {
            // Optimistic: later edits must build on this one even before the listener echoes the write back.
            const live = smCurShow();
            if (live) { live.layout = live.layout || {}; live.layout.items = smClone(items); }
            return smWrite(smLayoutUpdate({ 'layout.items': cleanData(items) }));
        }
        // A short message that fades by itself (nothing to dismiss, safe under a phone keyboard).
        function smToast(msg) {
            let t = smEl('smToast');
            if (!t) { t = document.createElement('div'); t.id = 'smToast'; t.className = 'sm-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
            t.textContent = msg; t.classList.add('on');
            clearTimeout(smToast.timer); smToast.timer = setTimeout(() => t.classList.remove('on'), 2600);
        }
        // A small in-app choice box (the browser's confirm() can't offer named buttons, and some embedded browsers refuse it).
        //   smChoose({ title, message, options: [{ value, label, desc, primary }], cancelText }) -> Promise of the chosen value, or null on Cancel.
        let smChooseDone = null;
        function smChoose(opts) {
            if (smChooseDone) smChooseDone(null);
            let m = smEl('smChooseModal');
            if (!m) {
                m = document.createElement('div'); m.className = 'modal'; m.id = 'smChooseModal'; m.style.zIndex = '3300';
                m.innerHTML = `<div class="modal-sheet sm-choose" role="dialog" aria-modal="true" aria-labelledby="smChTitle"><h3 id="smChTitle"></h3><p id="smChMsg"></p><div id="smChOpts"></div><button type="button" class="btn btn-outline" id="smChCancel" style="width:100%; margin-top:8px;"></button></div>`;
                document.body.appendChild(m);
            }
            m.querySelector('#smChTitle').textContent = opts.title || '';
            const msg = m.querySelector('#smChMsg'); msg.textContent = opts.message || ''; msg.style.display = opts.message ? 'block' : 'none';
            m.querySelector('#smChCancel').textContent = opts.cancelText || 'Cancel';
            m.querySelector('#smChOpts').innerHTML = (opts.options || []).map((o, i) => `<button type="button" class="sm-ch-opt${o.primary ? ' primary' : ''}" data-i="${i}"><b>${escapeHtml(o.label)}</b>${o.desc ? `<span>${escapeHtml(o.desc)}</span>` : ''}</button>`).join('');
            m.style.display = 'flex';
            return new Promise(resolve => {
                const finish = v => { if (smChooseDone !== finish) return; smChooseDone = null; m.style.display = 'none'; m.onclick = m.onkeydown = null; resolve(v); };
                smChooseDone = finish;
                m.onclick = e => {
                    const b = e.target.closest('.sm-ch-opt');
                    if (b) finish(opts.options[+b.dataset.i].value); else if (e.target === m || e.target.id === 'smChCancel') finish(null);
                };
                m.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } };
                const first = m.querySelector('.sm-ch-opt'); if (first) setTimeout(() => first.focus(), 30);
            });
        }

        // ---------- SHOW VIEW SHELL ----------
        // A show is split into pages so a phone only shows what you need: Floor (the map), Tables (every table and its parties),
        // Guests (guest list, waiting list, walk-in tally) and Show (details + floorplan). Wide screens show Floor and Tables side by side.
        const SM_PAGES = [['floor', '🗺️', 'Floor'], ['tables', '🪑', 'Tables'], ['guests', '📋', 'Guests'], ['show', '⚙️', 'Show']];
        function smSvgMarkup() {
            return `<svg id="smSvg" class="sm-svg" viewBox="0 0 ${SM_DEF_W} ${SM_DEF_H}" xmlns="http://www.w3.org/2000/svg">
                <defs><pattern id="smGridPat" width="${SM_GRID * 4}" height="${SM_GRID * 4}" patternUnits="userSpaceOnUse"><path d="M ${SM_GRID * 4} 0 L 0 0 0 ${SM_GRID * 4}" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1"/></pattern></defs>
                <rect id="smFloor" class="sm-floor" x="0" y="0" width="${SM_DEF_W}" height="${SM_DEF_H}" rx="18" fill="#232334"/>
                <rect id="smFloorGrid" x="0" y="0" width="${SM_DEF_W}" height="${SM_DEF_H}" rx="18" fill="url(#smGridPat)"/>
                 <rect id="smBorder" x="1.5" y="1.5" width="${SM_DEF_W - 3}" height="${SM_DEF_H - 3}" rx="18" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="3"/>
                <g id="smItems"></g>
            </svg>`;
        }
        const SM_ZOOM_HTML = `<div class="sm-zoom"><button class="btn btn-outline btn-sm" onclick="smSetZoom(smZoom-0.25)" aria-label="Zoom out">−</button><button class="btn btn-outline btn-sm" id="smZoomLbl" onclick="smSetZoom(1)" title="Fit the whole room on screen"></button><button class="btn btn-outline btn-sm" onclick="smSetZoom(smZoom+0.25)" aria-label="Zoom in">+</button></div>`;
        function smBindResize() {
            if (window._smResizeBound) return; // keep the whole room in view when the window / phone orientation changes
            window._smResizeBound = true;
            window.addEventListener('resize', () => { if (window._module === 'shows' && smShowId && smEl('smSvg')) { smFitMap(); smStickyTop(); } });
        }
        function smBuildShell() {
            try { const sp = localStorage.getItem('ss_smPage'); if (SM_PAGES.some(x => x[0] === sp)) smPage = sp; } catch (err) { /* ignore */ }
            smEl('smShowRoot').innerHTML = `
                <div class="sm-sticky" id="smSticky">
                    <div class="sm-topbar">
                        <button class="btn btn-outline btn-sm" onclick="smCloseShow()" title="Back to all shows">← Shows</button>
                        <div class="sm-searchwrap">
                            <input type="search" id="smQ" class="input-field" placeholder="🔍 Find a party or table…" oninput="smOnSearch(this.value)" onkeydown="if(event.key==='Escape')smClearSearch()" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" name="sm_find" data-1p-ignore>
                            <button class="sm-qx" id="smQx" onclick="smClearSearch()" aria-label="Clear search" style="display:none;">✕</button>
                        </div>
                        <button class="btn btn-sm sm-addtop" onclick="smOpenQuickAdd()" title="Add a purchaser and seat them at a table">＋ Add</button>
                    </div>
                    <div class="sm-tabs" id="smTabs" role="tablist">${SM_PAGES.map(([k, ic, lb]) => `<button class="sm-tab" role="tab" data-p="${k}" onclick="smSetPage('${k}')"><span>${ic}</span><span>${lb}</span><i class="sm-tabn" id="smTabN_${k}"></i></button>`).join('')}</div>
                    <div class="sm-results" id="smResults" style="display:none;"><div id="smSearchBody"></div></div>
                </div>
                <div class="sm-mini"><div id="smMiniBody"></div><span id="smSync" class="sm-sync"></span></div>
                <div class="sm-pages" id="smPages" data-page="${smPage}">
                    <div class="sm-pg sm-pg-floor">
                        <div class="glass-card sm-mapcard">
                            <div class="sm-maptop">
                                <div class="sm-seg" id="smModeToggle">
                                    <button data-m="seat" onclick="smSetMode('seat')">🪑 Seating</button>
                                    <button data-m="layout" onclick="smSetMode('layout')">✏️ Edit layout</button>
                                </div>
                                ${SM_ZOOM_HTML}
                            </div>
                            <div id="smPanel"></div>
                            <div class="sm-mapwrap" id="smMapWrap">${smSvgMarkup()}</div>
                            <div class="sm-legend">
                                <span><i class="sm-dot free"></i>Open seat</span><span><i class="sm-dot reserved"></i>Assigned</span><span><i class="sm-dot arrived"></i>Arrived</span><span><i class="sm-dot over"></i>Over capacity</span>
                            </div>
                        </div>
                    </div>
                    <div class="sm-pg sm-pg-tables">
                        <div class="glass-card sm-listcard">
                            <div id="smSummary"></div>
                            <div style="height:10px;"></div>
                            <div class="sm-filters">
                                <button class="ev-chip" id="smFPending" onclick="smToggleFilter('pending')">Still to arrive</button>
                                <button class="ev-chip" id="smFEmpty" onclick="smToggleFilter('hideEmpty')">Hide empty tables</button>
                            </div>
                            <div id="smListScroll"><div id="smListBody"></div></div>
                        </div>
                    </div>
                    <div class="sm-pg sm-pg-guests">
                        <div class="glass-card sm-gcard" id="smStanding"></div>
                        <div class="glass-card sm-gcard">
                            <h4 class="sm-gh">📋 Guest list</h4>
                            <p class="sm-gp">Type or paste your guest list — one party per line. Put the number of people after the name (<b>Maria Lopez x4</b>, <b>Sam Cho, 2</b>); no number means one person. Then seat them below as tables are sold.</p>
                            <textarea id="smBulk" class="input-field" rows="5" placeholder="Maria Lopez x4&#10;Sam Cho, 2&#10;Alex Rivera" oninput="smBulkPreview()" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" data-1p-ignore></textarea>
                            <div class="sm-bulk-prev" id="smBulkPrev"></div>
                            <button class="btn" id="smBulkBtn" style="width:100%;" onclick="smBulkAdd()" disabled>Add to guest list</button>
                        </div>
                        <div class="glass-card sm-gcard" id="smQueue"></div>
                    </div>
                    <div class="sm-pg sm-pg-show"><div id="smHead"></div></div>
                </div>`;
            smInitSvgEvents();
            smStickyTop();
            smBindResize();
            smShellId = smShowId;
            smHeadSig = ''; smPanelSig = '';
            smBulkPreview();
        }
        // The layout editor opened from the Venues page: the same map and tools, none of the show things (guests, pages, search).
        function smBuildEditorShell() {
            smEl('smShowRoot').innerHTML = `
                <div class="sm-ed-top">
                    <button class="btn btn-outline btn-sm" onclick="smCloseEditor()">← Venues</button>
                    <div class="sm-ed-title" id="smEdTitle"></div>
                    <span id="smSync" class="sm-sync"></span>
                </div>
                <div class="sm-ed-note" id="smEdNote"></div>
                <div class="glass-card sm-mapcard">
                    <div class="sm-maptop"><span class="sm-ed-lbl">✏️ Layout editor</span>${SM_ZOOM_HTML}</div>
                    <div id="smPanel"></div>
                    <div class="sm-mapwrap" id="smMapWrap">${smSvgMarkup()}</div>
                </div>`;
            smInitSvgEvents();
            smBindResize();
            smShellId = smShowId;
            smPanelSig = '';
        }

        function smRenderShow(show) {
            if (!show) { smEl('smShowRoot').innerHTML = `<button class="btn btn-outline btn-sm" style="margin-bottom:14px;" onclick="${smEditTarget ? 'smCloseEditor()' : 'smCloseShow()'}">${smEditTarget ? '← Venues' : '← All Shows'}</button><p style="color:var(--text-muted); padding:20px 4px;">${smDataError ? escapeHtml(smDataError) : (smEditTarget ? 'Loading layout…' : 'Loading show…')}</p>`; smShellId = null; return; }
            if (smEditTarget) { smRenderEditor(show); return; }
            if (smShellId !== show.id) {
                smMode = 'seat'; smSelId = null; smTableOpenId = null; smFilter = { q: '', pending: false, hideEmpty: false };
                smZoom = 1; // 1 = fit the whole room on screen
                smBuildShell();
            }
            smRenderMini(show);
            smRenderHead(show);
            smRenderChrome();
            smRenderPanel(show);
            smRenderMap(show);
            smRenderSummary(show);
            smRenderList(show);
            smRenderGuests(show);
            smRenderSearch(show);
            smRenderTableModal(show);
            smRenderQuick();
            smSyncUi();
        }
        function smRenderEditor(show) {
            if (smShellId !== show.id) { smMode = 'layout'; smSelId = null; smTableOpenId = null; smZoom = 1; smBuildEditorShell(); }
            smMode = 'layout';
            const t = smEditTarget, v = smVenues().find(x => x.id === show.venueId);
            const items = smItems(show), cv = smCV(show);
            smEl('smEdTitle').innerHTML = t.kind === 'building'
                ? `<b>🏛️ ${escapeHtml(v ? v.name : 'Venue')} — building</b><span>walls &amp; zones · ${cv.w}×${cv.h}</span>`
                : `<b>${escapeHtml(show.title || 'Layout')}</b><span>${escapeHtml(v ? v.name : '')}${v ? ' · ' : ''}${items.filter(smIsSeat).length} tables · ${cv.w}×${cv.h}</span>`;
            smEl('smEdNote').textContent = t.kind === 'building'
                ? 'This is just the venue itself: its walls, doors and zones (stage, bar, bathrooms…). Every new layout can start from it, so you only arrange the tables. Layouts you already made keep their own copy — open one and tap “Use building” to refresh it.'
                : 'Changes save as you go. Shows that already use this layout keep their own copy — in a show, pick the layout and tap Load to bring the new version in.';
            smRenderChrome();
            smRenderPanel(show);
            smRenderMap(show);
            smSyncUi();
        }
        // The search bar sticks just under the (sticky) app header, whatever height that is on this screen.
        function smStickyTop() { const h = document.querySelector('header'), st = smEl('smSticky'); if (st) st.style.top = ((h ? h.offsetHeight : 66) + 8) + 'px'; }
        // Size the map so the WHOLE room is visible without scrolling: as wide as the card allows, but never taller than
        // the screen. Zoom 1 is "fit"; the +/- buttons zoom relative to it (the frame only scrolls once you zoom in).
        function smFitMap() {
            const svg = smEl('smSvg'), wrap = smEl('smMapWrap'); if (!svg || !wrap) return;
            if (!wrap.clientWidth) { smFitKey = ''; return; } // on a page that isn't showing: no width to fit to - it is fitted when the page is shown
            const cv = smCV(), availW = wrap.clientWidth, maxH = Math.max(300, window.innerHeight - 190);
            const fitW = Math.max(200, Math.min(availW, maxH * cv.w / cv.h));
            svg.style.width = Math.round(fitW * smZoom) + 'px';
            smFitKey = cv.w + 'x' + cv.h + '|' + availW + '|' + window.innerHeight;
        }
        function smRenderChrome() {
            const pg = smEl('smPages');
            if (pg) pg.dataset.page = smPage; // first: the map can only be measured once its page is visible
            const mt = smEl('smModeToggle'); if (mt) mt.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.m === smMode));
            smEl('smSvg').classList.toggle('layout', smMode === 'layout');
            smFitMap();
            smEl('smZoomLbl').textContent = smZoom === 1 ? 'Fit' : Math.round(smZoom * 100) + '%';
            const fp = smEl('smFPending'), fe = smEl('smFEmpty');
            if (fp) fp.classList.toggle('active', smFilter.pending);
            if (fe) fe.classList.toggle('active', smFilter.hideEmpty);
            document.querySelectorAll('#smTabs .sm-tab').forEach(b => { const on = b.dataset.p === smPage; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
        }
        function smSetPage(p) {
            if (!SM_PAGES.some(x => x[0] === p)) return;
            smPage = p;
            try { localStorage.setItem('ss_smPage', p); } catch (err) { /* ignore */ }
            smClearSearch();
            smRenderChrome(); // also re-fits the map now that it is visible (a hidden map has no width to fit)
            requestAnimationFrame(() => { if (smEl('smSvg')) smFitMap(); });
            window.scrollTo({ top: 0 });
        }
        function smSetMode(m) { smMode = m; smPanelSig = ''; const s = smCurShow(); smRenderChrome(); if (s) { smRenderPanel(s); smRenderMap(s); } }
        function smSetZoom(z) { smZoom = Math.min(4, Math.max(0.5, Math.round(z * 100) / 100)); smRenderChrome(); }
        function smToggleFilter(k) { smFilter[k] = !smFilter[k]; smRenderChrome(); smRenderListNow(); }
        function smRenderListNow() { const s = smCurShow(); if (s) smRenderList(s); }

        // The slim strip under the tabs, on every page: which show, how many people are in, and the "new week" nudge.
        function smRenderMini(show) {
            const body = smEl('smMiniBody'); if (!body) return;
            const gs = smGuests(show), total = gs.reduce((n, g) => n + g.size, 0), arr = gs.reduce((n, g) => n + g.arrived, 0), standing = Math.max(0, +show.standing || 0);
            const waiting = smTableStats(show).unseated;
            const dp = evDateParts(show);
            body.innerHTML = `
                <div class="sm-mini-main"><b>${escapeHtml(show.title)}</b><span>${dp ? `${escapeHtml(dp.wk)} ${escapeHtml(dp.mon)} ${escapeHtml(dp.day)}` : escapeHtml(show.date || '')}${show.venueName ? ' · ' + escapeHtml(show.venueName) : ''}</span></div>
                <div class="sm-mini-stats"><span><b>${arr}</b>/${total} arrived</span>${standing ? `<span>🧍 <b>${standing}</b> standing</span>` : ''}${waiting.length ? `<span class="warn">⏳ <b>${waiting.reduce((n, g) => n + g.size, 0)}</b> waiting</span>` : ''}</div>
                ${show.layoutPending ? `<div class="sm-mini-new">🔁 New week — layout copied from last week. <button class="btn btn-outline btn-sm" onclick="smKeepLayout()">Keep it</button> <button class="btn btn-outline btn-sm" onclick="smSetPage('show')">Change…</button></div>` : ''}`;
            const wn = waiting.length;
            const gn = smEl('smTabN_guests'); if (gn) { gn.textContent = wn ? String(wn) : ''; gn.style.display = wn ? 'inline-block' : 'none'; }
            const sn = smEl('smTabN_show'); if (sn) { sn.textContent = '!'; sn.style.display = show.layoutPending ? 'inline-block' : 'none'; }
        }

        function smRenderHead(show) {
            const plans = smPlans().filter(p => p.venueId && p.venueId === show.venueId).sort((a, b) => smNatural(a.name, b.name));
            const based = plans.find(p => p.id === show.floorplanId);
            const sig = JSON.stringify([show.title, show.date, show.startTime, show.endTime, show.venueName, show.image, show.desc, show.tags, show.floorplanId, show.repeat, !!show.layoutPending, plans.map(p => p.id + p.name)]);
            if (sig === smHeadSig) return;
            smHeadSig = sig;
            const dp = evDateParts(show), hours = shiftHoursLabel(show);
            smEl('smHead').innerHTML = `
                <div class="glass-card sm-head">
                    <div class="sm-head-img" style="background-image:url(&quot;${escapeHtml(evCssUrl(show.image || SM_DEFAULT_IMG))}&quot;)"></div>
                    <div class="sm-head-main">
                        <h2 class="sm-head-title">${escapeHtml(show.title)}</h2>
                        <div class="sm-head-meta">🗓️ ${dp ? `${dp.wk} ${dp.mon} ${dp.day}` : escapeHtml(show.date || '')} &middot; 🕘 ${escapeHtml(shiftTimeLabel(show))}${hours ? ' &middot; ' + escapeHtml(hours) : ''}${show.venueName ? ' &middot; 📍 ' + escapeHtml(show.venueName) : ''}</div>
                        ${show.desc ? `<div class="sm-head-desc">${escapeHtml(show.desc)}</div>` : ''}
                    </div>
                    <div class="sm-head-actions">
                        <button class="btn btn-outline btn-sm" onclick="smOpenShowModal('${escapeHtml(jsStr(show.id))}')">✎ Edit details</button>
                        <button class="btn btn-sm btn-magenta" onclick="smDeleteShow()">Delete</button>
                    </div>
                </div>
                <div class="glass-card sm-planbar">
                    ${show.layoutPending ? `
                    <div class="sm-newweek">
                        <span>🔁 <b>New week.</b> This room is copied from last week${show.floorplanName ? ` (“${escapeHtml(show.floorplanName)}” base)` : ''}. Pick this week's layout below, or keep it as is.</span>
                        <button class="btn btn-outline btn-sm" onclick="smKeepLayout()">Keep this layout</button>
                    </div>` : ''}
                    <label>Floorplan</label>
                    ${show.venueId ? `
                    <select id="smPlanSel" class="input-field">
                        <option value="">${plans.length ? 'Choose a saved floorplan…' : 'No saved floorplans for this venue yet'}</option>
                        ${plans.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.id === show.floorplanId ? ' (current base)' : ''}</option>`).join('')}
                    </select>
                    <button class="btn btn-outline btn-sm" onclick="smLoadPlan()">Load</button>
                    ${plans.length ? `<button class="btn btn-outline btn-sm" title="Delete the floorplan chosen in the list (shows keep their own copy)" onclick="smDeleteSelectedPlan()">🗑 Delete</button>` : ''}
                    <button class="btn btn-sm" onclick="smSavePlanNew()">💾 Save as new</button>
                    ${based ? `<button class="btn btn-outline btn-sm" onclick="smUpdatePlan()">↻ Update “${escapeHtml(based.name)}”</button>` : ''}`
                    : `<span style="font-size:0.85rem; color:var(--text-muted);">Pick a venue (Edit details) to save and reuse floorplans.</span>`}
                </div>`;
        }

        // ---------- FLOORPLANS (saved layouts per venue) ----------
        function smLoadPlan() {
            const show = smCurShow(); if (!show) return;
            const plan = smPlans().find(p => p.id === (smEl('smPlanSel') || {}).value);
            if (!plan) { alert('Choose a saved floorplan first.'); return; }
            const n = smGuests(show).length;
            if (!confirm(`Replace this show's room with "${plan.name}"?${n ? `\n\nGuests are kept — anyone at a table number that exists in the new layout stays at that number; the rest go to the waiting list so you can seat them again.` : ''}`)) return;
            const items = smClone(plan.items || []);
            const upd = { 'layout.items': cleanData(items), 'layout.w': plan.w || SM_DEF_W, 'layout.h': plan.h || SM_DEF_H, floorplanId: plan.id, floorplanName: plan.name, layoutPending: false };
            // Keep people at the same table NUMBER when the new room has it.
            const oldById = {}; smItems(show).forEach(i => { oldById[i.id] = i; });
            smGuests(show).forEach(g => {
                if (items.some(i => i.id === g.tableId)) return;
                const old = oldById[g.tableId];
                const match = old && items.find(i => smIsSeat(i) && (i.type === 'bar') === (old.type === 'bar') && String(i.num).toLowerCase() === String(old.num).toLowerCase());
                if (match) upd['guests.' + g.id + '.tableId'] = match.id;
            });
            smSelId = null;
            smWrite(smShowRef().update(upd));
        }
        // A new weekly show starts with last week's room; this dismisses the "pick this week's layout" nudge.
        function smKeepLayout() { if (smShowId) smWrite(smShowRef().update({ layoutPending: false })); }
        async function smSavePlanNew() {
            const show = smCurShow(); if (!show) return;
            if (!show.venueId) { alert('Pick a venue for this show first (Edit details).'); return; }
            const existing = smPlans().filter(p => p.venueId === show.venueId).length;
            const name = await askText({ title: '💾 Save floorplan', message: 'Name this floorplan (e.g. "Runway night", "Square stage"):', value: 'Layout ' + (existing + 1), okText: 'Save' });
            if (!name || !name.trim()) return;
            const plan = { id: smUid('f'), venueId: show.venueId, name: name.trim(), items: smClone(smItems(show)), w: smCV(show).w, h: smCV(show).h, updatedAt: Date.now() };
            smSyncCount++; smSyncUi();
            saveDoc('floorplans', plan.id, plan).then(() => smWrite(smShowRef().update({ floorplanId: plan.id, floorplanName: plan.name })))
                .catch(() => {}).finally(() => { smSyncCount--; smSyncUi(); });
        }
        function smUpdatePlan() {
            const show = smCurShow(); if (!show) return;
            const plan = smPlans().find(p => p.id === show.floorplanId); if (!plan) return;
            if (!confirm(`Overwrite the saved floorplan "${plan.name}" with this show's current layout? Other shows keep their own copies.`)) return;
            smWrite(db.collection('floorplans').doc(plan.id).update({ items: cleanData(smItems(show)), w: smCV(show).w, h: smCV(show).h, updatedAt: Date.now() }));
        }

        // ---------- MAP (SVG) ----------
        function smDims(it) {
            if (it.type === 't2') return { w: 56, h: 56 };
            if (it.type === 't4') return { w: 72, h: 72 };
            if (it.type === 't6') return { w: 120, h: 72 };
            if (it.type === 'bar') return { w: Math.max(1, +it.seats || 6) * 34, h: 34 };
            if (it.type === 'line') { const k = SM_LINES[it.kind] || SM_LINES.wall; return { w: +it.w || k.len, h: +it.h || k.thick }; }
            if (it.type === 'zone') { const z = SM_ZONES[it.kind] || SM_ZONES.area; return { w: +it.w || z.w, h: +it.h || z.h }; }
            if (it.type === 'stage') {
                if (+it.w && +it.h) return { w: +it.w, h: +it.h };
                return SM_STAGE_PRESETS[it.shape] || SM_STAGE_PRESETS.runway; // older saved stages only have a shape
            }
            return { w: 60, h: 60 };
        }
        // Half the on-canvas width/height of an item at any rotation, chairs included - keeps it inside the room.
        function smHalfExtent(it) {
            const d = smDims(it), pad = smIsSeat(it) ? 22 : 0, w = d.w + pad * 2, h = d.h + pad * 2;
            const th = (it.rot || 0) * Math.PI / 180, c = Math.abs(Math.cos(th)), sn = Math.abs(Math.sin(th));
            return { hw: (c * w + sn * h) / 2, hh: (sn * w + c * h) / 2 };
        }
        function smClampTo(it, x, y, cw, ch, noSnap) {
            const e = smHalfExtent(it), hw = Math.min(e.hw, cw / 2), hh = Math.min(e.hh, ch / 2), sn = v => noSnap ? v : Math.round(v / SM_GRID) * SM_GRID;
            return { x: Math.min(cw - hw, Math.max(hw, sn(x))), y: Math.min(ch - hh, Math.max(hh, sn(y))) };
        }
        function smClamp(it, x, y) { const cv = smCV(); return smClampTo(it, x, y, cv.w, cv.h); }
        function smChairs(it) {
            const d = smDims(it), out = [];
            if (it.type === 't2') { out.push({ x: 0, y: -(d.h / 2 + 10) }, { x: 0, y: d.h / 2 + 10 }); }
            else if (it.type === 't4') { const r = d.w / 2 + 10; out.push({ x: 0, y: -r }, { x: r, y: 0 }, { x: 0, y: r }, { x: -r, y: 0 }); }
            else if (it.type === 't6') {
                // An oval's edge curves in toward its ends, so the end chairs tuck in with it; a square-cornered table is flat.
                const edge = x => smShape(it) === 'square' ? d.h / 2 : (d.h / 2) * Math.sqrt(Math.max(0, 1 - Math.pow(x / (d.w / 2), 2)));
                [-36, 0, 36].forEach(x => out.push({ x, y: -(edge(x) + 10) })); [-36, 0, 36].forEach(x => out.push({ x, y: edge(x) + 10 }));
            }
            else if (it.type === 'bar') { for (let k = 0; k < Math.max(1, it.seats || 6); k++) out.push({ x: -d.w / 2 + 17 + k * 34, y: d.h / 2 + 13 }); }
            return out;
        }
        function smTableStats(show) {
            const stats = {};
            smItems(show).forEach(i => { if (smIsSeat(i)) stats[i.id] = { total: 0, arrived: 0, parties: 0 }; });
            const unseated = [];
            smGuests(show).forEach(g => {
                const s = stats[g.tableId];
                if (!s) { unseated.push(g); return; }
                s.total += g.size; s.arrived += g.arrived; s.parties++;
            });
            return { stats, unseated };
        }
        // Amber handle on a stem: drag it around the piece to rotate to any angle (snaps to 5 degrees).
        function smRotHandle(id, x, y, x0, y0, rot) {
            if (smMode !== 'layout') return '';
            const tip = smDrag && smDrag.rotate && smDrag.id === id ? `<text transform="rotate(${-rot} ${x} ${y})" x="${x}" y="${y - 20}" text-anchor="middle" fill="#ffb020" font-size="18" font-weight="800" pointer-events="none">${Math.round(rot)}°</text>` : '';
            return `<g class="sm-rot"><line x1="${x0}" y1="${y0}" x2="${x}" y2="${y}" stroke="#ffb020" stroke-width="2"/><circle cx="${x}" cy="${y}" r="13" fill="#ffb020" stroke="#08080c" stroke-width="2"/><path d="M ${x - 4.5} ${y - 1} A 5 5 0 1 1 ${x - 1} ${y + 4.5}" stroke="#08080c" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M ${x - 6.5} ${y - 2.5} L ${x - 4.5} ${y + 1.5} L ${x - 1.5} ${y - 1.5} Z" fill="#08080c"/></g>${tip}`;
        }
        // Teal handle on an edge ('l' | 'r' | 't' | 'b') of a room area, or on an end ('l' | 'r') of a wall / opening.
        function smEdgeHandle(edge, x, y) {
            const h = edge === 'l' || edge === 'r';
            const a = h ? `M ${x - 5} ${y} L ${x + 5} ${y} M ${x - 2} ${y - 3.5} L ${x - 5} ${y} L ${x - 2} ${y + 3.5} M ${x + 2} ${y - 3.5} L ${x + 5} ${y} L ${x + 2} ${y + 3.5}`
                : `M ${x} ${y - 5} L ${x} ${y + 5} M ${x - 3.5} ${y - 2} L ${x} ${y - 5} L ${x + 3.5} ${y - 2} M ${x - 3.5} ${y + 2} L ${x} ${y + 5} L ${x + 3.5} ${y + 2}`;
            return `<g class="sm-rh" data-edge="${edge}" style="cursor:${h ? 'ew-resize' : 'ns-resize'}"><circle cx="${x}" cy="${y}" r="12" fill="#00f5d4" stroke="#08080c" stroke-width="2"/><path d="${a}" stroke="#08080c" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`;
        }
        // Walls, doorways, garage doors and curtains: a line of length d.w and thickness d.h, centred on the item.
        function smLineSvg(it, d, tf, selected) {
            const w = d.w, t = d.h, hw = w / 2, kind = it.kind;
            const hitH = Math.max(t, 26);
            let body = '', hit;
            if (kind === 'door') {
                hit = `<rect class="sm-hit" fill="none" pointer-events="all" x="${-hw}" y="${-w}" width="${w}" height="${w + hitH / 2}"/>`;
                body = `<rect fill="#232334" x="${-hw}" y="${-t / 2 - 1}" width="${w}" height="${t + 2}"/>
                    <rect fill="#d6d9e8" x="${-hw - 2}" y="${-t / 2}" width="4" height="${t}"/><rect fill="#d6d9e8" x="${hw - 2}" y="${-t / 2}" width="4" height="${t}"/>
                    <path d="M ${-hw} 0 L ${-hw} ${-w}" stroke="#00f5d4" stroke-width="3" fill="none" stroke-linecap="round"/>
                    <path d="M ${-hw} ${-w} A ${w} ${w} 0 0 1 ${hw} 0" stroke="#00f5d4" stroke-width="1.5" stroke-dasharray="4 3" fill="none"/>`;
            } else {
                hit = `<rect class="sm-hit" fill="none" pointer-events="all" x="${-hw}" y="${-hitH / 2}" width="${w}" height="${hitH}"/>`;
                if (kind === 'curtain') {
                    const n = Math.max(1, Math.round(w / 16)), p = w / n;
                    body = `<path d="M ${-hw} 0 q ${p / 4} ${-p * 0.45} ${p / 2} 0${' t ' + (p / 2) + ' 0'}${(' q ' + (p / 4) + ' ' + (-p * 0.45) + ' ' + (p / 2) + ' 0 t ' + (p / 2) + ' 0').repeat(n - 1)}" stroke="#ff2a85" stroke-width="${Math.max(3, t / 2)}" fill="none" stroke-linecap="round"/>`;
                } else if (kind === 'garage') {
                    let ticks = ''; for (let x = -hw + 20; x < hw - 1; x += 20) ticks += `M ${x} ${-t / 2} L ${x} ${t / 2} `;
                    body = `<rect fill="rgba(255,176,32,0.28)" stroke="#ffb020" stroke-width="2" x="${-hw}" y="${-t / 2}" width="${w}" height="${t}"/><path d="${ticks}" stroke="#ffb020" stroke-width="1.5" fill="none"/>`;
                } else {
                    body = `<rect fill="#d6d9e8" stroke="#8b8fa6" stroke-width="1" x="${-hw}" y="${-t / 2}" width="${w}" height="${t}" rx="1.5"/>`;
                }
            }
            const box = kind === 'door' ? { y: -w - 6, h: w + t / 2 + 12 } : { y: -hitH / 2 - 4, h: hitH + 8 };
            // One handle on each end: pulling an end moves only that end, the other stays put.
            const handle = selected && smMode === 'layout' ? smEdgeHandle('l', -hw, 0) + smEdgeHandle('r', hw, 0) : '';
            // flip = swing the other way (in/out); flipH = hinge on the other side (mirror left/right).
            return `<g class="sm-it sm-line${selected ? ' sel' : ''}" data-id="${escapeHtml(it.id)}" transform="${tf}">
                <g transform="scale(${it.flipH ? -1 : 1} ${it.flip ? -1 : 1})">${hit}${body}</g>
                ${selected ? `<rect class="sm-selbox" fill="none" stroke="#00f5d4" stroke-width="2.5" stroke-dasharray="8 6" pointer-events="none" x="${-hw - 6}" y="${it.flip && kind === 'door' ? -(box.y + box.h) : box.y}" width="${w + 12}" height="${box.h}" rx="10"/>` : ''}
                ${handle}
                ${selected ? smRotHandle(it.id, -hw - 34, 0, -hw - 6, 0, +it.rot || 0) : ''}
            </g>`;
        }
        function smItemSvg(it, st, selected) {
            // Position and angle are forced to plain numbers before they go into the SVG, whatever was saved in the layout.
            const d = smDims(it), rot = +it.rot || 0;
            const tf = `translate(${+it.x || 0} ${+it.y || 0}) rotate(${rot})`;
            if (smIsZone(it)) {
                const kind = smKind(it), z = SM_ZONES[kind] || SM_ZONES.area;
                const label = String(it.label != null && it.label !== '' ? it.label : (kind === 'stage' && (it.shape === 'runway' || (!it.w && !it.shape)) ? 'RUNWAY' : z.label)).toUpperCase();
                // The label runs along the piece's long side (so a tall room reads vertically), is never upside-down,
                // and wraps onto two lines when that lets it be bigger.
                const longSide = Math.max(d.w, d.h), shortSide = Math.min(d.w, d.h), base = d.h > d.w ? 90 : 0;
                let ang = (((rot + base) % 360) + 360) % 360; if (ang > 90 && ang <= 270) ang -= 180; else if (ang > 270) ang -= 360;
                const lblRot = ang - rot;
                const fit1 = Math.max(8, Math.min(20, shortSide / 3.5, (longSide - 14) / (label.length * 1.2)));
                const words = label.split(' ');
                let lines = [label], fs = fit1;
                if (words.length > 1) {
                    let best = 0, bestD = 1e9; for (let i = 1; i < words.length; i++) { const dd = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length); if (dd < bestD) { bestD = dd; best = i; } }
                    const l1 = words.slice(0, best).join(' '), l2 = words.slice(best).join(' ');
                    const fit2 = Math.max(8, Math.min(20, shortSide / 2.9, (longSide - 14) / (Math.max(l1.length, l2.length) * 1.2)));
                    if (fit2 > fit1 * 1.15) { lines = [l1, l2]; fs = fit2; }
                }
                const textEl = lines.length === 1
                    ? `<text class="sm-stage-lbl" fill="#fff" font-size="${fs}" font-weight="800" letter-spacing="${Math.round(fs * 0.2)}" pointer-events="none" transform="rotate(${lblRot})" text-anchor="middle" dy=".35em">${escapeHtml(lines[0])}</text>`
                    : `<text class="sm-stage-lbl" fill="#fff" font-size="${fs}" font-weight="800" letter-spacing="${Math.round(fs * 0.2)}" pointer-events="none" transform="rotate(${lblRot})" text-anchor="middle"><tspan x="0" dy="-0.25em">${escapeHtml(lines[0])}</tspan><tspan x="0" dy="1.2em">${escapeHtml(lines[1])}</tspan></text>`;
                // A handle on each of the four edges: pulling one moves only that edge, the opposite edge stays where it is.
                const handle = selected && smMode === 'layout'
                    ? smEdgeHandle('l', -d.w / 2, 0) + smEdgeHandle('r', d.w / 2, 0) + smEdgeHandle('t', 0, -d.h / 2) + smEdgeHandle('b', 0, d.h / 2) : '';
                return `<g class="sm-it sm-stage${selected ? ' sel' : ''}" data-id="${escapeHtml(it.id)}" transform="${tf}">
                    <rect ${kind === 'stage' ? 'class="sm-stage-body" ' : ''}fill="${z.fill}" stroke="${z.stroke}" stroke-width="2.5"${z.dash ? ` stroke-dasharray="${z.dash}"` : ''} x="${-d.w / 2}" y="${-d.h / 2}" width="${d.w}" height="${d.h}" rx="${Math.min(14, d.h / 3)}"/>
                    ${textEl}
                    ${selected ? `<rect class="sm-selbox" fill="none" stroke="#00f5d4" stroke-width="2.5" stroke-dasharray="8 6" pointer-events="none" x="${-d.w / 2 - 6}" y="${-d.h / 2 - 6}" width="${d.w + 12}" height="${d.h + 12}" rx="18"/>` : ''}
                    ${handle}
                    ${selected ? smRotHandle(it.id, 0, -d.h / 2 - 32, 0, -d.h / 2 - 6, rot) : ''}
                </g>`;
            }
            if (smIsLine(it)) return smLineSvg(it, d, tf, selected);
            const cap = smCap(it);
            const status = st.total === 0 && st.arrived === 0 ? 'empty' : st.arrived >= st.total ? 'done' : st.arrived > 0 ? 'partial' : 'reserved';
            const over = st.total > cap || st.arrived > cap;
            // Literal colours are only a fallback (SVG paints black by default if the stylesheet is stale or blocked);
            // the .sm-* CSS classes override them and carry the app theme.
            const FB = { free: '#4a4a5c', reserved: '#ff2a85', arrived: '#00ff87' };
            const chairs = smChairs(it).map((c, k) => { const cs = k < st.arrived ? 'arrived' : k < st.total ? 'reserved' : 'free'; return `<circle class="sm-ch ${cs}" fill="${FB[cs]}" cx="${c.x}" cy="${c.y}" r="8"/>`; }).join('');
            const bodyAttr = `fill="${{ empty: '#2c2c3e', reserved: '#5a1f3d', partial: '#5a4416', done: '#14573a' }[status]}" stroke="${over ? '#ff3366' : { empty: '#9a9ab0', reserved: '#ff2a85', partial: '#ffb020', done: '#00ff87' }[status]}" stroke-width="2.5"`;
            // Tables are round (a circle, or an oval for a 6-top) or square (square corners); bar sections are always a bar. 6-tops saved before shapes existed keep their rounded-rectangle look.
            const tcls = `sm-tb ${status}${over ? ' over' : ''}`;
            const body = it.type === 'bar'
                ? `<rect class="${tcls}" ${bodyAttr} x="${-d.w / 2}" y="${-d.h / 2}" width="${d.w}" height="${d.h}" rx="8"/>`
                : smShape(it) === 'round'
                    ? `<ellipse class="${tcls}" ${bodyAttr} rx="${d.w / 2}" ry="${d.h / 2}"/>`
                    : `<rect class="${tcls}" ${bodyAttr} x="${-d.w / 2}" y="${-d.h / 2}" width="${d.w}" height="${d.h}" rx="${it.type === 't6' && !it.shape ? 22 : 8}"/>`;
            const label = it.type === 'bar' ? 'Bar ' + (it.num || '?') : (it.num || '?');
            const subTxt = st.total > 0 ? `${st.arrived}/${st.total} in` : '';
            // Labels sit at the item's centre and are counter-rotated so they stay upright on a rotated table.
            const texts = it.type === 'bar'
                ? `<text class="sm-num sm-num-bar" fill="#fff" font-size="15" font-weight="800" pointer-events="none" transform="rotate(${-rot})" text-anchor="middle" dy=".35em">${escapeHtml(label)}${subTxt ? ` <tspan class="sm-sub-in" fill="#ddd" font-size="12">· ${subTxt}</tspan>` : ''}</text>`
                : `<text class="sm-num" fill="#fff" font-size="22" font-weight="800" pointer-events="none" transform="rotate(${-rot})" text-anchor="middle" y="${subTxt ? -5 : 0}" dy=".35em">${escapeHtml(label)}</text>`
                  + (subTxt ? `<text class="sm-sub" fill="#ddd" font-size="12" font-weight="700" pointer-events="none" transform="rotate(${-rot})" text-anchor="middle" y="14">${subTxt}</text>` : '');
            const ext = smIsSeat(it) ? 22 : 0;
            return `<g class="sm-it sm-tbl${selected ? ' sel' : ''}" data-id="${escapeHtml(it.id)}" transform="${tf}">
                <rect class="sm-hit" fill="none" pointer-events="all" x="${-d.w / 2 - ext}" y="${-d.h / 2 - ext}" width="${d.w + ext * 2}" height="${d.h + ext * 2}"/>
                ${chairs}${body}${texts}
                ${selected ? `<rect class="sm-selbox" fill="none" stroke="#00f5d4" stroke-width="2.5" stroke-dasharray="8 6" pointer-events="none" x="${-d.w / 2 - ext - 4}" y="${-d.h / 2 - ext - 4}" width="${d.w + ext * 2 + 8}" height="${d.h + ext * 2 + 8}" rx="16"/>` : ''}
                ${selected ? smRotHandle(it.id, 0, -d.h / 2 - ext - 30, 0, -d.h / 2 - ext - 4, rot) : ''}
            </g>`;
        }
        function smApplyCanvas(show) {
            const svg = smEl('smSvg'); if (!svg) return;
            const cv = smCV(show);
            svg.setAttribute('viewBox', `0 0 ${cv.w} ${cv.h}`);
            ['smFloor', 'smFloorGrid'].forEach(id => { const e = smEl(id); if (e) { e.setAttribute('width', cv.w); e.setAttribute('height', cv.h); } });
            const b = smEl('smBorder'); if (b) { b.setAttribute('width', cv.w - 3); b.setAttribute('height', cv.h - 3); }
            const wrap = smEl('smMapWrap');
            if (wrap && smFitKey !== cv.w + 'x' + cv.h + '|' + wrap.clientWidth + '|' + window.innerHeight) smFitMap(); // room size changed
        }
        function smRenderMap(show) {
            const layer = smEl('smItems'); if (!layer) return;
            smApplyCanvas(show);
            const items = smItems(show), cv = smCV(show), { stats } = smTableStats(show);
            // Room areas at the back, then walls and openings, then tables and bar seats on top.
            const ordered = [...items.filter(smIsZone), ...items.filter(smIsLine), ...items.filter(smIsSeat)];
            layer.innerHTML = ordered.map(i => smItemSvg(i, stats[i.id] || { total: 0, arrived: 0 }, i.id === smSelId)).join('')
                || `<text x="${cv.w / 2}" y="${cv.h / 2 - 8}" text-anchor="middle" fill="#fff" font-size="26" font-weight="700">The room is empty</text>
                    <text x="${cv.w / 2}" y="${cv.h / 2 + 28}" text-anchor="middle" fill="#c8c8d8" font-size="20">${smMode === 'layout' ? 'Add walls, features and tables with the buttons above.' : 'Tap “Edit layout” to build the room, or load a saved floorplan.'}</text>`;
        }

        // Drag + tap handling, delegated on the <svg>. Pointer events cover mouse, touch and pen.
        function smSvgPoint(svg, ev) {
            const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
            const m = svg.getScreenCTM();
            return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
        }
        function smInitSvgEvents() {
            const svg = smEl('smSvg');
            svg.addEventListener('pointerdown', ev => {
                const g = ev.target.closest('.sm-it');
                const show = smCurShow(); if (!show) return;
                if (!g) { if (smSelId) { smSelId = null; smPanelSig = ''; smRenderPanel(show); smRenderMap(show); smRenderList(show); } return; }
                const it = smItems(show).find(i => i.id === g.dataset.id); if (!it) return;
                if (smMode !== 'layout' && !smIsSeat(it)) return; // the stage is only selectable while editing the layout
                const p = smSvgPoint(svg, ev);
                const dm0 = smDims(it);
                smDrag = { id: it.id, g, rot: it.rot || 0, cx: ev.clientX, cy: ev.clientY, ox: p.x - it.x, oy: p.y - it.y, x: it.x, y: it.y, moved: false, canDrag: smMode === 'layout', item: it,
                    rotate: smMode === 'layout' && !!ev.target.closest('.sm-rot'), rotOff: smIsLine(it) ? 180 : 90, ang: it.rot || 0,
                    resize: smMode === 'layout' && (smIsZone(it) || smIsLine(it)) && !!ev.target.closest('.sm-rh') && !ev.target.closest('.sm-rot'), w: dm0.w, h: dm0.h,
                    w0: dm0.w, h0: dm0.h, x0: it.x, y0: it.y, edge: ((ev.target.closest('.sm-rh') || document.body).getAttribute('data-edge')) || 'r' };
                try { svg.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
                if (smDrag.canDrag) ev.preventDefault();
            });
            svg.addEventListener('pointermove', ev => {
                const d = smDrag; if (!d || !d.canDrag) return;
                if (!d.moved && Math.hypot(ev.clientX - d.cx, ev.clientY - d.cy) < 5) return;
                d.moved = true;
                const p = smSvgPoint(svg, ev);
                if (d.rotate) {
                    // The handle sits off one side of the piece; the angle is wherever the pointer is around the centre.
                    const live = smItems(smCurShow()).find(i => i.id === d.id); if (!live) return;
                    let ang = Math.atan2(p.y - live.y, p.x - live.x) * 180 / Math.PI + d.rotOff;
                    ang = ((Math.round(ang / 5) * 5) % 360 + 360) % 360;
                    d.ang = ang; live.rot = ang;
                    smRenderMap(smCurShow());
                    return;
                }
                if (d.resize) {
                    // Pull an edge handle: only that edge moves; the opposite edge stays where it was when the drag began.
                    // Measured in the piece's own (rotated) frame, relative to where its centre started.
                    const live = smItems(smCurShow()).find(i => i.id === d.id); if (!live) return;
                    const th = (live.rot || 0) * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
                    const dx = p.x - d.x0, dy = p.y - d.y0;
                    const lx = dx * cs + dy * sn, ly = -dx * sn + dy * cs;
                    const cv = smCV(), line = smIsLine(live), snap = v => Math.round(v / SM_GRID) * SM_GRID;
                    const minL = line ? 20 : SM_ZONE_MIN, maxW = line ? Math.max(cv.w, cv.h) : cv.w, maxH = cv.h;
                    // Where the piece ends up if the pulled edge sits at size `want` (the other edge never moves).
                    const place = want => {
                        let w = d.w0, h = d.h0, lox = 0, loy = 0;      // lox/loy: how far the centre slides in the piece's own frame
                        if (d.edge === 'r' || d.edge === 'l') { w = want; lox = (d.edge === 'r' ? 1 : -1) * (w - d.w0) / 2; }
                        else { h = want; loy = (d.edge === 'b' ? 1 : -1) * (h - d.h0) / 2; }
                        const x = d.x0 + lox * cs - loy * sn, y = d.y0 + lox * sn + loy * cs, e = smHalfExtent({ ...live, w, h, x, y });
                        return { w, h, x, y, fits: x - e.hw >= -0.5 && x + e.hw <= cv.w + 0.5 && y - e.hh >= -0.5 && y + e.hh <= cv.h + 0.5 };
                    };
                    const horiz = d.edge === 'r' || d.edge === 'l';
                    if (!horiz && (line || (d.edge !== 'b' && d.edge !== 't'))) return;
                    const raw = horiz ? (d.edge === 'r' ? lx + d.w0 / 2 : d.w0 / 2 - lx) : (d.edge === 'b' ? ly + d.h0 / 2 : d.h0 / 2 - ly);
                    let want = Math.min(horiz ? maxW : maxH, Math.max(horiz ? minL : SM_ZONE_MIN, snap(raw)));
                    let r = place(want);
                    // Pulled past a wall of the room: stop where the piece meets it instead of refusing the move.
                    for (let guard = 0; !r.fits && guard < 400 && want > (horiz ? d.w0 : d.h0); guard++) { want -= SM_GRID; r = place(want); }
                    if (!r.fits) r = place(horiz ? d.w0 : d.h0);
                    const w = r.w, h = r.h, nx = r.x, ny = r.y;
                    d.w = w; d.h = h; d.x = nx; d.y = ny;
                    live.w = w; live.h = h; live.x = nx; live.y = ny;
                    smRenderMap(smCurShow());
                    return;
                }
                const c = smClamp(d.item, p.x - d.ox, p.y - d.oy);
                d.x = c.x; d.y = c.y;
                d.g.setAttribute('transform', `translate(${c.x} ${c.y}) rotate(${d.rot})`);
            });
            const finish = ev => {
                const d = smDrag; if (!d) return;
                smDrag = null;
                try { svg.releasePointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
                if (ev.type === 'pointercancel') { smOnData(); return; }
                const show = smCurShow(); if (!show) return;
                if (d.rotate) {
                    if (d.moved) {
                        const items = smClone(smItems(show));
                        const it = items.find(i => i.id === d.id);
                        if (it) { it.rot = d.ang; const c = smClamp(it, it.x, it.y); it.x = c.x; it.y = c.y; smSelId = d.id; smSaveItems(items); }
                    }
                    smPanelSig = ''; smRenderPanel(show); smRenderMap(show);
                    return;
                }
                if (d.resize) {
                    if (d.moved) {
                        const items = smClone(smItems(show));
                        const it = items.find(i => i.id === d.id);
                        if (it) { it.w = d.w; it.h = d.h; it.x = d.x; it.y = d.y; smSelId = d.id; smPanelSig = ''; smSaveItems(items); } // already kept inside the room by the drag, so no re-snapping (that would nudge the fixed edge)
                    }
                    smPanelSig = ''; smRenderPanel(show); smRenderMap(show);
                    return;
                }
                if (d.moved) {
                    const items = smClone(smItems(show));
                    const it = items.find(i => i.id === d.id);
                    if (it) {
                        it.x = d.x; it.y = d.y; smSelId = d.id; smPanelSig = '';
                        d.item.x = d.x; d.item.y = d.y; // optimistic: show it where it was dropped until the listener echoes the write
                        smSaveItems(items);
                    }
                    smRenderPanel(show); smRenderMap(show); smRenderList(show);
                } else {
                    smTapItem(d.id);
                }
            };
            svg.addEventListener('pointerup', finish);
            svg.addEventListener('pointercancel', finish);
        }
        function smTapItem(id) {
            const show = smCurShow(); if (!show) return;
            const it = smItems(show).find(i => i.id === id); if (!it) return;
            if (smMode === 'seat' && smIsSeat(it)) { smOpenTable(id); return; } // seating mode: tap a table to edit its bookings
            smSelId = id; smPanelSig = '';
            smRenderPanel(show); smRenderMap(show); smRenderList(show);
        }

        // ---------- LAYOUT EDITING PANEL ----------
        function smNextNum(items, family) {
            const used = new Set(items.filter(i => (i.type === 'bar') === (family === 'bar') && smIsSeat(i)).map(i => String(i.num).toLowerCase()));
            let n = 1; while (used.has(String(n))) n++;
            return String(n);
        }
        function smFreeSpot(items, it) {
            const cv = smCV();
            for (let k = 0; k < 80; k++) {
                const x = cv.w / 2 - 240 + (k % 9) * 60, y = cv.h / 2 - 60 + Math.floor(k / 9) * 70;
                if (!items.some(o => Math.hypot(o.x - x, o.y - y) < 70)) return smClamp(it, x, y);
            }
            return smClamp(it, cv.w / 2, cv.h / 2);
        }
        // type: t2 / t4 / t6 / bar / stage / zone / line;  kind: which zone or line (see SM_ZONES / SM_LINES)
        function smAddItem(type, kind) {
            const show = smCurShow(); if (!show) return;
            const items = smClone(smItems(show)), cv = smCV(show);
            const it = { id: smUid('i'), type, x: 0, y: 0, rot: 0 };
            if (type === 'bar') { it.seats = 6; it.num = smNextNum(items, 'bar'); }
            else if (type === 'stage') { const pr = SM_STAGE_PRESETS.wide; it.w = pr.w; it.h = pr.h; it.label = pr.label; }
            else if (type === 'zone') { const z = SM_ZONES[kind] || SM_ZONES.area; it.kind = SM_ZONES[kind] ? kind : 'area'; it.w = z.w; it.h = z.h; it.label = z.label; }
            else if (type === 'line') { const k = SM_LINES[kind] || SM_LINES.wall; it.kind = SM_LINES[kind] ? kind : 'wall'; it.w = Math.min(k.len, Math.max(cv.w, cv.h)); it.h = k.thick; }
            else { it.num = smNextNum(items, 'table'); it.shape = smNewShape; }
            const firstStage = type === 'stage' && !items.some(i => i.type === 'stage');
            const pos = firstStage ? smClamp(it, cv.w / 2, 90) : smFreeSpot(items, it);
            it.x = pos.x; it.y = pos.y;
            items.push(it);
            smSelId = it.id; smPanelSig = '';
            smSaveItems(items);
        }
        // The two "+ Room feature…" / "+ Wall / opening…" pickers: value is "type:kind".
        function smAddKind(v) { if (!v) return; const [type, kind] = v.split(':'); smAddItem(type, kind); }
        // Four walls around the whole room - the usual first step for a new venue.
        function smAddOuterWalls() {
            const show = smCurShow(); if (!show) return;
            const items = smClone(smItems(show)), cv = smCV(show), t = 10, mk = (x, y, w, rot) => ({ id: smUid('i'), type: 'line', kind: 'wall', x, y, w, h: t, rot });
            items.push(mk(cv.w / 2, t, cv.w - t * 2, 0), mk(cv.w / 2, cv.h - t, cv.w - t * 2, 0), mk(t, cv.h / 2, cv.h - t * 2, 90), mk(cv.w - t, cv.h / 2, cv.h - t * 2, 90));
            smSelId = null; smPanelSig = '';
            smSaveItems(items);
        }
        function smSetNewShape(v) {
            smNewShape = v === 'square' ? 'square' : 'round';
            try { localStorage.setItem('ss_smShape', smNewShape); } catch (err) { /* ignore */ }
            smPanelSig = ''; const s = smCurShow(); if (s) smRenderPanel(s);
        }
        function smSetShape(id, v) { smPatchItem(id, { shape: v === 'square' ? 'square' : 'round' }); }
        function smSetGrow(axis, v) { if (axis === 'x') smGrowX = v; else smGrowY = v; }
        function smSetCanvas(w, h) {
            const show = smCurShow(); if (!show) return;
            const cv = smCV(show), snap = (v, cur) => Math.min(SM_CANVAS_MAX, Math.max(SM_CANVAS_MIN, Math.round((parseInt(v, 10) || cur) / SM_GRID) * SM_GRID));
            const nw = snap(w, cv.w), nh = snap(h, cv.h);
            // Which edge(s) the change happens at. Growing the left/top (or both) slides everything over so the pieces keep
            // their place relative to the opposite wall; shrinking from there takes the room off that side instead.
            const dw = nw - cv.w, dh = nh - cv.h;
            const sx = smGrowX === 'left' ? dw : smGrowX === 'both' ? dw / 2 : 0;
            const sy = smGrowY === 'top' ? dh : smGrowY === 'both' ? dh / 2 : 0;
            const items = smClone(smItems(show));
            let moved = 0;
            items.forEach(it => {
                let changed = false;
                it.x += sx; it.y += sy; // a plain slide - only counts as "moved" below if the new room can't hold it there
                if (!smIsSeat(it)) {
                    // A wall or area longer than the new room (e.g. an outer wall) shrinks with it instead of hanging over the edge.
                    const e = smHalfExtent(it), f = Math.min(nw / (2 * e.hw), nh / (2 * e.hh));
                    if (f < 1) {
                        const d = smDims(it);
                        it.w = Math.max(20, Math.floor(d.w * f / SM_GRID) * SM_GRID);
                        it.h = smIsLine(it) ? d.h : Math.max(SM_ZONE_MIN, Math.floor(d.h * f / SM_GRID) * SM_GRID);
                        changed = true;
                    }
                }
                const c = smClampTo(it, it.x, it.y, nw, nh);
                if (c.x !== it.x || c.y !== it.y) { changed = true; it.x = c.x; it.y = c.y; }
                if (changed) moved++;
            });
            if ((nw < cv.w || nh < cv.h) && moved && !confirm(`${moved} piece${moved === 1 ? '' : 's'} won't fit the smaller room and will be pulled in or shrunk to fit. Continue?`)) { smPanelSig = ''; smRenderPanel(show); return; }
            show.layout = show.layout || {}; show.layout.w = nw; show.layout.h = nh; show.layout.items = smClone(items); // optimistic
            smPanelSig = '';
            smWrite(smLayoutUpdate({ 'layout.w': nw, 'layout.h': nh, 'layout.items': cleanData(items) }));
            smRenderPanel(show); smRenderMap(show);
        }
        function smPatchItem(id, patch, noSnap) {
            const show = smCurShow(); if (!show) return;
            const items = smClone(smItems(show));
            const it = items.find(i => i.id === id); if (!it) return;
            Object.assign(it, patch);
            const cv = smCV(show), c = smClampTo(it, it.x, it.y, cv.w, cv.h, noSnap); it.x = c.x; it.y = c.y; // a rotation or bigger piece must not push it off the room
            smPanelSig = '';
            smSaveItems(items);
        }
        function smRotate(id, deg) {
            const it = smItems(smCurShow()).find(i => i.id === id); if (!it) return;
            smPatchItem(id, { rot: (((it.rot || 0) + (deg || 90)) % 360 + 360) % 360 });
        }
        function smSetAngle(id, val) {
            const a = parseInt(val, 10); if (isNaN(a)) { smPanelSig = ''; smRenderPanel(smCurShow()); return; }
            smPatchItem(id, { rot: ((a % 360) + 360) % 360 });
        }
        function smFlipH(id) { const it = smItems(smCurShow()).find(i => i.id === id); if (it) smPatchItem(id, { flipH: !it.flipH }); }
        function smFlip(id) { const it = smItems(smCurShow()).find(i => i.id === id); if (it) smPatchItem(id, { flip: !it.flip }); }
        function smSetPreset(id, key) {
            const it = smItems(smCurShow()).find(i => i.id === id), pr = SM_STAGE_PRESETS[key]; if (!it || !pr) return;
            const keepLabel = it.label && !Object.values(SM_STAGE_PRESETS).some(x => x.label === String(it.label).toUpperCase());
            smPatchItem(id, { w: pr.w, h: pr.h, shape: key, label: keepLabel ? it.label : pr.label });
        }
        // Width / height of a room area, or length (w) / thickness (h) of a wall or opening.
        function smSetDim(id, dim, val) {
            const it = smItems(smCurShow()).find(i => i.id === id); if (!it) return;
            const d = smDims(it), cv = smCV();
            let v;
            if (smIsLine(it)) v = dim === 'w' ? Math.min(Math.max(cv.w, cv.h), Math.max(20, Math.round((parseInt(val, 10) || d.w) / SM_GRID) * SM_GRID)) : Math.min(40, Math.max(4, Math.round((parseInt(val, 10) || d.h) / 2) * 2));
            else v = Math.min(dim === 'w' ? cv.w : cv.h, Math.max(SM_ZONE_MIN, Math.round((parseInt(val, 10) || d[dim]) / SM_GRID) * SM_GRID));
            // Which side takes the change: 'both' grows around the centre; 'left'/'top' or 'right'/'bottom' keep the opposite edge fixed.
            // The slide is along the piece's OWN axes, so it holds for rotated pieces too.
            const a = dim === 'w' ? smPieceGrowX : (smIsLine(it) ? 'both' : smPieceGrowY), delta = v - d[dim];
            const s = (a === 'right' || a === 'bottom') ? delta / 2 : (a === 'left' || a === 'top') ? -delta / 2 : 0;
            const th = (it.rot || 0) * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
            const patch = { w: d.w, h: d.h, [dim]: v };
            if (s) { patch.x = it.x + (dim === 'w' ? s * cs : -s * sn); patch.y = it.y + (dim === 'w' ? s * sn : s * cs); }
            smPatchItem(id, patch, true);
        }
        function smSetPieceGrow(axis, v) { if (axis === 'x') smPieceGrowX = v; else smPieceGrowY = v; }
        function smSetZoneLabel(id, val) { smPatchItem(id, { label: String(val).trim().slice(0, 18) }); }
        function smSetSeats(id, n) { n = Math.max(1, Math.min(20, parseInt(n, 10) || 1)); smPatchItem(id, { seats: n }); }
        // Renumber a table or bar section. The old number simply goes away - nothing is swapped. If another table of the same kind
        // already has the new number, that table is left without a number (shown as "?") so you can number it next.
        // If the table has bookings, the host chooses: they stay at the table (and show under its new number), or they go to
        // the waiting list so they can be seated again. Bookings are tied to the table itself, not its number.
        async function smChangeNumber(id, raw) {
            let show = smCurShow(); if (!show) return;
            const val = String(raw == null ? '' : raw).trim().slice(0, 8);
            const redraw = () => { smPanelSig = ''; const s = smCurShow(); if (s) { smRenderPanel(s); smRenderTableModal(s); } };
            let it = smItems(show).find(i => i.id === id);
            if (!it || !smIsSeat(it)) { redraw(); return; }
            if (!val) { smToast('Type the new number first.'); redraw(); return; }
            if (String(it.num == null ? '' : it.num) === val) { redraw(); return; }
            const bar = it.type === 'bar', kind = bar ? 'Bar' : 'Table', oldName = smItemName(it);
            const sameNum = o => o.id !== id && smIsSeat(o) && (o.type === 'bar') === bar && String(o.num == null ? '' : o.num).toLowerCase() === val.toLowerCase();
            const other = smItems(show).find(sameNum);
            const mine = smGuests(show).filter(g => g.tableId === id);
            let queue = false;
            if (mine.length || other) {
                const n = mine.length;
                const msg = (other ? `${kind} ${other.num} is already in use. It will be left without a number until you give it a new one (its bookings stay with it). ` : '')
                    + (n ? `${oldName} has ${n} booking${n === 1 ? '' : 's'}. What should happen ${n === 1 ? 'to it' : 'to them'}?` : '');
                const options = n
                    ? [{ value: 'stay', label: `Keep ${n === 1 ? 'it' : 'them'} at this ${kind.toLowerCase()}`, desc: `Stays in the same seats and shows under ${kind} ${val}.`, primary: true },
                       { value: 'queue', label: 'Send to the waiting list', desc: 'Takes them off this table so you can seat them again (Guests page).' }]
                    : [{ value: 'stay', label: `Use ${val} for this ${kind.toLowerCase()}`, primary: true }];
                const pick = await smChoose({ title: `Change ${oldName} to ${kind} ${val}?`, message: msg, options });
                if (pick === null) { redraw(); return; }
                queue = pick === 'queue';
            }
            show = smCurShow(); if (!show) return; // use the room as it is now, not as it was when the box opened
            const items = smClone(smItems(show)), me = items.find(i => i.id === id); if (!me) return;
            const clash = items.find(sameNum);
            me.num = val; if (clash) clash.num = '';
            const upd = { 'layout.items': cleanData(items) };
            const live = smCurShow();
            live.layout = live.layout || {}; live.layout.items = smClone(items); // optimistic
            if (queue) smGuests(show).filter(g => g.tableId === id).forEach(g => {
                upd['guests.' + g.id + '.tableId'] = ''; upd['guests.' + g.id + '.wasTable'] = oldName;
                if (live.guests && live.guests[g.id]) { live.guests[g.id].tableId = ''; live.guests[g.id].wasTable = oldName; }
            });
            smPanelSig = '';
            smWrite(smLayoutUpdate(upd));
            smRenderShow(live);
            smToast(`${oldName} is now ${smItemName(me)}${queue && mine.length ? ' — bookings are on the waiting list' : ''}`);
        }
        function smSetLabel(id, val) { smChangeNumber(id, val); }
        // The "Edit table" button in the layout editor: ask for the new number in a dialog.
        async function smEditTable(id) {
            const show = smCurShow(); if (!show) return;
            const it = smItems(show).find(i => i.id === id); if (!it || !smIsSeat(it)) return;
            const v = await askText({
                title: it.type === 'bar' ? '✎ Edit bar section' : '✎ Edit table',
                message: `New number for ${smItemName(it)}. The old number just goes away.`,
                value: it.num || '', okText: 'Save',
                validate: x => !String(x).trim() ? 'Enter a number or a short label.' : String(x).trim().length > 8 ? 'Keep it to 8 characters or fewer.' : ''
            });
            if (v === null) return;
            smChangeNumber(id, v);
        }
        // Change from the table's own popup (seating mode) - the box next to where you add a purchaser.
        function smSaveTableNum(id) { const el = smEl('smTmNum'); if (el) smChangeNumber(id, el.value); }
        function smDuplicate(id) {
            const show = smCurShow(); if (!show) return;
            const items = smClone(smItems(show)), src = items.find(i => i.id === id); if (!src) return;
            const copy = { ...src, id: smUid('i') };
            if (smIsSeat(src)) copy.num = smNextNum(items, src.type === 'bar' ? 'bar' : 'table');
            const c = smClamp(copy, src.x + 40, src.y + 40); copy.x = c.x; copy.y = c.y;
            items.push(copy); smSelId = copy.id; smPanelSig = '';
            smSaveItems(items);
        }
        function smDeleteItem(id) {
            const show = smCurShow(); if (!show) return;
            const it = smItems(show).find(i => i.id === id); if (!it) return;
            const n = smGuests(show).filter(g => g.tableId === id).length;
            if (!confirm(`Remove ${smIsSeat(it) ? smItemName(it) : 'this ' + smPieceName(it).toLowerCase()}?${n ? `\n\n${n} booking${n === 1 ? ' is' : 's are'} assigned here — they'll move to the waiting list so you can seat them again.` : ''}`)) return;
            smSelId = null; smPanelSig = '';
            smSaveItems(smClone(smItems(show)).filter(i => i.id !== id));
        }
        function smRenderPanel(show) {
            const panel = smEl('smPanel'); if (!panel) return;
            if (smMode !== 'layout') { if (panel.innerHTML) panel.innerHTML = ''; smPanelSig = ''; return; }
            const it = smItems(show).find(i => i.id === smSelId), cv = smCV(show);
            const sig = JSON.stringify([smMode, it, cv, smGrowX, smGrowY, smPieceGrowX, smPieceGrowY, smNewShape, smEditTarget, smEditTarget ? !!(smVenues().find(v => v.id === show.venueId) || {}).building : 0]);
            const sideSel = (axis, cur, opts) => `<select class="sm-pick" aria-label="Which side changes" title="Which side of the piece gets the change (the opposite side stays put)" onchange="smSetPieceGrow('${escapeHtml(jsStr(axis))}', this.value)">${opts.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
            if (sig === smPanelSig) return;
            smPanelSig = sig;
            const numIn = (v, min, max, step, fn) => `<input type="number" class="input-field" value="${v}" min="${min}" max="${max}" step="${step}" onchange="${fn}(this.value)">`;
            let sel = `<div class="sm-hint">Drag any piece to move it. Tap one to rename, resize, rotate (any angle) or remove it.</div>`;
            if (smEditTarget && smEditTarget.kind === 'building') sel = `<div class="sm-hint">Add the walls, doors and zones that never change. Tables are added per layout.</div>`;
            if (it) {
                // Every piece rotates to any angle: drag the amber handle on the map, nudge in steps, or type an exact angle.
                const rotBtns = `<span class="sm-step"><button class="btn btn-outline btn-sm" title="Rotate left 15°" onclick="smRotate('${escapeHtml(jsStr(it.id))}', -15)">↺ 15°</button><button class="btn btn-outline btn-sm" title="Rotate right 15°" onclick="smRotate('${escapeHtml(jsStr(it.id))}', 15)">↻ 15°</button><button class="btn btn-outline btn-sm" title="Rotate 45°" onclick="smRotate('${escapeHtml(jsStr(it.id))}', 45)">⟳ 45°</button><button class="btn btn-outline btn-sm" title="Rotate 90°" onclick="smRotate('${escapeHtml(jsStr(it.id))}', 90)">⟳ 90°</button></span>
                    <label>Angle <input type="number" class="input-field" style="width:78px;" value="${Math.round(it.rot || 0)}" min="0" max="359" step="5" onchange="smSetAngle('${escapeHtml(jsStr(it.id))}', this.value)">°</label>`;
                let fields = '';
                const d = smDims(it);
                if (smIsSeat(it)) {
                    const shp = smShape(it), sid = escapeHtml(jsStr(it.id));
                    fields = `<label>Label <input id="smLblInput" class="input-field" value="${escapeHtml(it.num || '')}" maxlength="8" onchange="smSetLabel('${sid}', this.value)" data-1p-ignore></label>`
                        + (it.type === 'bar' ? '' : `<span class="sm-shapes" role="group" aria-label="Table shape"><button class="ev-chip${shp === 'round' ? ' active' : ''}" onclick="smSetShape('${sid}','round')">◯ Round</button><button class="ev-chip${shp === 'square' ? ' active' : ''}" onclick="smSetShape('${sid}','square')">▢ Square</button></span>`)
                        + (it.type === 'bar' ? `<label>Seats <span class="sm-step"><button class="btn btn-outline btn-sm" onclick="smSetSeats('${escapeHtml(jsStr(it.id))}', ${(it.seats || 6) - 1})">−</button><b>${it.seats || 6}</b><button class="btn btn-outline btn-sm" onclick="smSetSeats('${escapeHtml(jsStr(it.id))}', ${(it.seats || 6) + 1})">+</button></span></label>` : '');
                } else if (smIsZone(it)) {
                    const kind = smKind(it), z = SM_ZONES[kind] || SM_ZONES.area;
                    fields = `<label>Label <input id="smLblInput" class="input-field" style="width:120px;" value="${escapeHtml(it.label != null ? it.label : (kind === 'stage' && d.w > d.h * 3 ? 'RUNWAY' : z.label))}" maxlength="18" onchange="smSetZoneLabel('${escapeHtml(jsStr(it.id))}', this.value)" data-1p-ignore></label>
                        <label>Width ${numIn(d.w, SM_ZONE_MIN, cv.w, SM_GRID, `smSetDim.bind(null,'${it.id}','w')`)} ${sideSel('x', smPieceGrowX, [['both', 'both sides'], ['left', 'left edge'], ['right', 'right edge']])}</label>
                        <label>Height ${numIn(d.h, SM_ZONE_MIN, cv.h, SM_GRID, `smSetDim.bind(null,'${it.id}','h')`)} ${sideSel('y', smPieceGrowY, [['both', 'top & bottom'], ['top', 'top edge'], ['bottom', 'bottom edge']])}</label>`
                        + (kind === 'stage' ? `<span class="sm-shapes">${[['runway', 'Runway'], ['square', 'Large square'], ['wide', 'Standard']].map(([k, l]) => `<button class="ev-chip${d.w === SM_STAGE_PRESETS[k].w && d.h === SM_STAGE_PRESETS[k].h ? ' active' : ''}" onclick="smSetPreset('${escapeHtml(jsStr(it.id))}','${escapeHtml(jsStr(k))}')">${l}</button>`).join('')}</span>` : '')
                        + `<span class="sm-hint" style="flex-basis:100%; margin:0;">Drag a teal handle on any edge to move just that edge (the opposite edge stays put); the amber handle rotates. Left / right / top / bottom refer to the piece itself.</span>`;
                } else {
                    fields = `<label>Length ${numIn(d.w, 20, Math.max(cv.w, cv.h), SM_GRID, `smSetDim.bind(null,'${it.id}','w')`)} ${sideSel('x', smPieceGrowX, [['both', 'both ends'], ['left', 'left end'], ['right', 'right end']])}</label>
                        <label>Thickness ${numIn(d.h, 4, 40, 2, `smSetDim.bind(null,'${it.id}','h')`)}</label>`
                        + (it.kind === 'door' ? `<button class="btn btn-outline btn-sm" title="Swing the door the other way (in / out)" onclick="smFlip('${escapeHtml(jsStr(it.id))}')">⇅ Swing other way</button><button class="btn btn-outline btn-sm" title="Mirror the door: hinge on the other side" onclick="smFlipH('${escapeHtml(jsStr(it.id))}')">⇄ Mirror hinge</button>` : '')
                        + `<span class="sm-hint" style="flex-basis:100%; margin:0;">Drag a teal handle on either end to move just that end, and the amber handle to rotate it.</span>`;
                }
                // Name + Duplicate / Remove on a header line, the piece's settings underneath (ui-2030.css docks this under the map so selecting a piece never moves the map).
                sel = `<div class="sm-sel-row">
                    <div class="sm-sel-head">
                        <b>${escapeHtml(smIsSeat(it) ? smItemName(it) : smPieceName(it))}</b>
                        <span class="sm-sel-actions">
                            ${smIsSeat(it) ? `<button class="btn btn-sm" title="Change this ${it.type === 'bar' ? "bar section's" : "table's"} number" onclick="smEditTable('${escapeHtml(jsStr(it.id))}')">✎ Edit ${it.type === 'bar' ? 'bar' : 'table'}</button>` : ''}
                            <button class="btn btn-outline btn-sm" onclick="smDuplicate('${escapeHtml(jsStr(it.id))}')">⧉ Duplicate</button>
                            <button class="btn btn-sm btn-magenta" onclick="smDeleteItem('${escapeHtml(jsStr(it.id))}')">Remove</button>
                        </span>
                    </div>
                    <div class="sm-sel-fields">
                        ${fields}
                        ${rotBtns}
                    </div>
                </div>`;
            }
            const opt = (v, l) => `<option value="${v}">${l}</option>`;
            const isBuilding = !!smEditTarget && smEditTarget.kind === 'building';
            const venueOfPlan = smEditTarget && smEditTarget.kind === 'plan' ? smVenues().find(v => v.id === show.venueId) : null;
            const hasBuilding = !!(venueOfPlan && venueOfPlan.building);
            panel.innerHTML = `
                <div class="sm-addbar">
                    <span>Add</span>
                    ${isBuilding ? '' : `<button class="btn btn-sm" onclick="smAddItem('t2')">2-top</button>
                    <button class="btn btn-sm" onclick="smAddItem('t4')">4-top</button>
                    <button class="btn btn-sm" onclick="smAddItem('t6')">6-top</button>
                    <button class="btn btn-sm" onclick="smAddItem('bar')">Bar seats</button>
                    <span class="sm-newshape" role="group" aria-label="Shape for new tables"><button class="ev-chip${smNewShape === 'round' ? ' active' : ''}" title="New tables are round" onclick="smSetNewShape('round')">◯</button><button class="ev-chip${smNewShape === 'square' ? ' active' : ''}" title="New tables are square" onclick="smSetNewShape('square')">▢</button></span>`}
                    <select class="sm-pick" aria-label="Add a room feature" onchange="smAddKind(this.value); this.selectedIndex = 0;">
                        ${opt('', '+ Room feature…')}${opt('stage:', 'Stage')}${Object.keys(SM_ZONES).filter(k => k !== 'stage').map(k => opt('zone:' + k, SM_ZONES[k].label)).join('')}
                    </select>
                    <select class="sm-pick" aria-label="Add a wall or opening" onchange="smAddKind(this.value); this.selectedIndex = 0;">
                        ${opt('', '+ Wall / opening…')}${Object.keys(SM_LINES).map(k => opt('line:' + k, SM_LINES[k].label)).join('')}
                    </select>
                </div>
                <div class="sm-roomrow">
                    <span>Room</span>
                    <label>Width <input type="number" class="input-field" id="smCW" value="${cv.w}" min="${SM_CANVAS_MIN}" max="${SM_CANVAS_MAX}" step="${SM_GRID}" onchange="smSetCanvas(this.value, ${cv.h})">
                        <select class="sm-pick" aria-label="Which side the width changes on" title="Which side of the room gets the extra (or loses) width" onchange="smSetGrow('x', this.value)">${[['right', 'at right edge'], ['left', 'at left edge'], ['both', 'both sides']].map(([v, l]) => `<option value="${v}"${smGrowX === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
                    <label>Depth <input type="number" class="input-field" id="smCH" value="${cv.h}" min="${SM_CANVAS_MIN}" max="${SM_CANVAS_MAX}" step="${SM_GRID}" onchange="smSetCanvas(${cv.w}, this.value)">
                        <select class="sm-pick" aria-label="Which side the depth changes on" title="Which side of the room gets the extra (or loses) depth" onchange="smSetGrow('y', this.value)">${[['bottom', 'at bottom edge'], ['top', 'at top edge'], ['both', 'top & bottom']].map(([v, l]) => `<option value="${v}"${smGrowY === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
                    <button class="btn btn-outline btn-sm" title="Add a wall along each edge of the room" onclick="smAddOuterWalls()">▭ Outer walls</button>
                    ${hasBuilding ? `<button class="btn btn-outline btn-sm" title="Replace this layout's walls &amp; zones with the venue's building (tables are kept)" onclick="smApplyBuilding()">🏛️ Use building</button>` : ''}
                </div>${sel}`;
        }

        // ---------- GUEST LIST (table numbers + names, check people in one by one) ----------
        // Re-rendering on every live update must not eat what someone is typing.
        function smPreserve(container, fn) {
            const act = document.activeElement;
            const vals = {};
            container.querySelectorAll('input[id]:not([type=checkbox]), textarea[id]').forEach(el => { if (el.value !== el.defaultValue) vals[el.id] = el.value; }); // only what someone typed - untouched defaults refresh
            const focus = act && container.contains(act) && act.id ? { id: act.id, s: act.selectionStart, e: act.selectionEnd } : null;
            fn();
            Object.keys(vals).forEach(id => { const el = smEl(id); if (el && vals[id] !== '') el.value = vals[id]; });
            if (focus) { const el = smEl(focus.id); if (el) { el.focus(); try { el.setSelectionRange(focus.s, focus.e); } catch (err) { /* not a text input */ } } }
        }
        function smRenderSummary(show) {
            const el = smEl('smSummary'); if (!el) return;
            const gs = smGuests(show), total = gs.reduce((n, g) => n + g.size, 0), arr = gs.reduce((n, g) => n + g.arrived, 0);
            const seats = smItems(show).filter(smIsSeat).reduce((n, i) => n + smCap(i), 0);
            const used = new Set(gs.filter(g => smItems(show).some(i => i.id === g.tableId)).map(g => g.tableId)).size;
            const standing = Math.max(0, +show.standing || 0);
            el.innerHTML = `
                <div class="sm-sum-top"><div><span class="sm-sum-big">${arr}</span><span class="sm-sum-of"> / ${total} people arrived</span></div><div class="sm-sum-sub">${Math.max(0, total - arr)} still to come</div></div>
                <div class="ev2-bar" style="height:7px; margin:8px 0 6px;"><i style="width:${total ? Math.min(100, Math.round(arr / total * 100)) : 0}%"></i></div>
                <div class="sm-sum-sub">${gs.length} booking${gs.length === 1 ? '' : 's'} · ${used} table${used === 1 ? '' : 's'} · ${seats} seats in this layout</div>
                ${standing ? `<div class="sm-sum-sub" style="margin-top:3px;">🧍 ${standing} standing (walk-ins) · <b style="color:var(--text-primary);">${arr + standing}</b> people in the room</div>` : ''}`;
        }
        // One row per purchaser: name, party size, and a counter for how many of the party are here.
        // opt.waiting: this party is on the waiting list, so the row gets a "Seat at a table" button.
        function smBookingRow(g, opt) {
            opt = opt || {};
            const full = g.arrived >= g.size, gid = escapeHtml(jsStr(g.id));
            const when = g.arrived > 0 && g.arrivedAt ? new Date(g.arrivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
            return `<div class="sm-g${full ? ' here' : g.arrived > 0 ? ' some' : ''}">
                <div class="sm-g-main"><span class="nm">${escapeHtml(g.name)}</span><button class="sm-size" title="Change the party size" onclick="smEditSize('${gid}')">party of ${g.size}</button>${opt.waiting && g.wasTable ? `<span class="sm-was">was ${escapeHtml(g.wasTable)}</span>` : ''}${when ? `<span class="tm">${when}</span>` : ''}</div>
                <div class="sm-count">
                    <button class="sm-cb" aria-label="One fewer here" ${g.arrived <= 0 ? 'disabled' : ''} onclick="smArrive('${gid}', -1)">−</button>
                    <span class="sm-cn"><b>${g.arrived}</b> of ${g.size} here</span>
                    <button class="sm-cb plus" aria-label="One more here" onclick="smArrive('${gid}', 1)">+</button>
                    <button class="sm-cb all" title="Everyone in this party is here" ${full ? 'disabled' : ''} onclick="smArriveAll('${gid}')">✓ all</button>
                </div>
                <div class="sm-g-tools">
                    <button class="sm-ib" title="Rename" onclick="smRenameGuest('${gid}')">✎</button>
                    <button class="sm-ib" title="${opt.waiting ? 'Seat at a table' : 'Move to another table'}" onclick="smMoveGuest('${gid}')">⇄</button>
                    <button class="sm-ib danger" title="Remove" onclick="smRemoveGuest('${gid}')">✕</button>
                </div>
                ${opt.waiting ? `<button class="sm-seatbtn" onclick="smMoveGuest('${gid}')">🪑 Seat at a table…</button>` : ''}
            </div>`;
        }
        // Table cards for the list (all tables) and for the search results (only matches). opts: q, pending, hideEmpty.
        function smTableCardsHtml(show, opts) {
            const items = smItems(show).filter(smIsSeat).sort((a, b) => ((a.type === 'bar') - (b.type === 'bar')) || smNatural(a.num, b.num));
            const { stats, unseated } = smTableStats(show);
            const byTable = {};
            smGuests(show).forEach(g => { (byTable[g.tableId] = byTable[g.tableId] || []).push(g); });
            const q = opts.q || '';
            const visible = list => (list || []).filter(g => (!opts.pending || g.arrived < g.size) && (!q || g.name.toLowerCase().includes(q))).sort((a, b) => smNatural(a.name, b.name));
            let html = '';
            if (unseated.length) {
                const vg = visible(unseated);
                if (vg.length) html += `<div class="sm-tcard warn"><div class="sm-tc-head"><b>⏳ Waiting for a table</b><span class="sm-tc-type">${vg.reduce((n, g) => n + g.size, 0)} people</span></div>${vg.map(g => smBookingRow(g, { waiting: true })).join('')}<div class="sm-tc-note">Tap “Seat at a table…” to put each party at a table.</div></div>`;
            }
            items.forEach(it => {
                const st = stats[it.id], all = byTable[it.id] || [], vg = visible(all);
                const nameHit = q && smItemName(it).toLowerCase().includes(q);
                if (q && !vg.length && !nameHit) return;
                if (!q && opts.pending && !vg.length && all.length) return; // everyone here already - nothing left to check off
                if (!q && opts.hideEmpty && !all.length && it.id !== smSelId) return;
                const cap = smCap(it), extra = Math.max(0, st.arrived - cap), overbooked = Math.max(0, st.total - cap);
                const done = st.total > 0 && st.arrived >= st.total;
                html += `<div class="sm-tcard${it.id === smSelId ? ' sel' : ''}${done ? ' done' : ''}${extra || overbooked ? ' over' : ''}" id="smT_${escapeHtml(it.id)}">
                    <div class="sm-tc-head" onclick="smOpenTable('${escapeHtml(jsStr(it.id))}')" title="Open this table">
                        <b>${escapeHtml(smItemName(it))}</b><span class="sm-tc-type">${it.type === 'bar' ? cap + ' bar seats' : SM_TYPES[it.type].label}</span>
                        <span class="sm-tc-count">${st.total || st.arrived ? `${st.arrived} of ${cap} seats filled` : 'empty'}</span>
                        ${extra ? `<span class="sm-tc-over">${extra} extra — charge</span>` : overbooked ? `<span class="sm-tc-over soft">${overbooked} over seats</span>` : ''}
                    </div>
                    ${vg.map(g => smBookingRow(g)).join('')}
                    <button class="sm-addbtn" onclick="smOpenTable('${escapeHtml(jsStr(it.id))}')">+ Add purchaser</button>
                </div>`;
            });
            return html;
        }
        function smRenderList(show) {
            const el = smEl('smListBody'); if (!el) return;
            const html = smTableCardsHtml(show, { q: '', pending: smFilter.pending, hideEmpty: smFilter.hideEmpty });
            const hasTables = smItems(show).some(smIsSeat);
            el.innerHTML = html || `<p style="color:var(--text-muted); text-align:center; padding:24px 8px; font-size:0.9rem;">${hasTables ? 'Nothing matches that filter.' : 'No tables yet. Switch to “Edit layout” on the Floor page to add tables, or load a saved floorplan.'}</p>`;
        }

        // ---------- GUESTS PAGE: walk-in tally, guest list entry, waiting list ----------
        function smRenderGuests(show) {
            smRenderStanding(show);
            smRenderQueue(show);
        }
        // Walk-ins without a table (general admission): no names, just a tally. Written with increment() so two phones at the door both count.
        function smRenderStanding(show) {
            const el = smEl('smStanding'); if (!el) return;
            const n = Math.max(0, +show.standing || 0);
            el.innerHTML = `
                <h4 class="sm-gh">🧍 Walk-ins · standing room</h4>
                <p class="sm-gp">General admission with no table — no names needed, just tap for each person who comes in.</p>
                <div class="sm-stand"><div class="sm-stand-n" aria-live="polite">${n}</div><div class="sm-stand-l">standing</div></div>
                <div class="sm-stand-btns">
                    <button class="sm-cb" aria-label="One fewer standing" ${n <= 0 ? 'disabled' : ''} onclick="smStanding(-1)">−1</button>
                    <button class="sm-cb plus big" aria-label="One more standing" onclick="smStanding(1)">+1</button>
                    <button class="sm-cb" onclick="smStanding(2)">+2</button>
                    <button class="sm-cb" onclick="smStanding(5)">+5</button>
                    <button class="sm-cb all" onclick="smSetStanding()">Set…</button>
                </div>`;
        }
        function smStanding(delta) {
            const show = smCurShow(); if (!show) return;
            const cur = Math.max(0, +show.standing || 0);
            if (cur + delta < 0) return;
            smWrite(smShowRef().update({ standing: firebase.firestore.FieldValue.increment(delta) }));
        }
        async function smSetStanding() {
            const show = smCurShow(); if (!show) return;
            const v = await askText({ title: '🧍 Standing room', message: 'How many walk-ins are standing right now?', value: String(Math.max(0, +show.standing || 0)), inputmode: 'numeric', okText: 'Save', validate: x => /^\d{1,4}$/.test(String(x).trim()) ? '' : 'Enter a number from 0 to 9999.' });
            if (v === null) return;
            smWrite(smShowRef().update({ standing: parseInt(v, 10) }));
        }
        // Waiting list: everyone with no table yet (typed in as a guest list, added with no table, taken off a renumbered table, or whose table was removed).
        function smRenderQueue(show) {
            const el = smEl('smQueue'); if (!el) return;
            const waiting = smTableStats(show).unseated.sort((a, b) => smNatural(a.name, b.name));
            const people = waiting.reduce((n, g) => n + g.size, 0);
            el.innerHTML = `<h4 class="sm-gh">⏳ Waiting for a table <small>${waiting.length} part${waiting.length === 1 ? 'y' : 'ies'} · ${people} ${people === 1 ? 'person' : 'people'}</small></h4>`
                + (waiting.length ? waiting.map(g => smBookingRow(g, { waiting: true })).join('') : `<p class="sm-gp" style="margin:6px 0 0;">No one is waiting. Add a guest list above, or tap <b>＋ Add</b> at the top to add a purchaser and seat them.</p>`);
        }
        // "Name x4", "Name, 4", "Name (4)", "Name - 4", "Name 4" (or a spreadsheet paste: name, tab, number). No number = 1 person.
        function smParseBulk(text) {
            const out = [];
            String(text || '').split(/\r?\n/).forEach(line => {
                const t = line.replace(/\t+/g, ', ').replace(/\s+/g, ' ').trim(); if (!t) return;
                let m, name = t, size = 1;
                if ((m = t.match(/^(.*\S)\s+[x×]\s*(\d{1,2})$/i)) || (m = t.match(/^(.*\S)\s*\((\d{1,2})\)$/)) || (m = t.match(/^(.*\S)\s*[,;:]\s*(\d{1,2})$/))
                    || (m = t.match(/^(.*\S)\s+[-–—]\s*(\d{1,2})$/)) || (m = t.match(/^(.*\S)\s+(\d{1,2})$/))) { name = m[1].replace(/[\s,;:\-–—]+$/, ''); size = Math.max(1, Math.min(99, parseInt(m[2], 10) || 1)); }
                if (name) out.push({ name: name.slice(0, 80), size });
            });
            return out.slice(0, 300);
        }
        function smBulkPreview() {
            const ta = smEl('smBulk'), prev = smEl('smBulkPrev'), btn = smEl('smBulkBtn'); if (!ta || !prev) return;
            const rows = smParseBulk(ta.value), people = rows.reduce((n, r) => n + r.size, 0);
            btn.disabled = !rows.length;
            btn.textContent = rows.length ? `Add ${rows.length} part${rows.length === 1 ? 'y' : 'ies'} (${people} ${people === 1 ? 'person' : 'people'}) to the list` : 'Add to guest list';
            prev.innerHTML = rows.length ? rows.slice(0, 8).map(r => `<span class="sm-bp">${escapeHtml(r.name)} <b>${r.size}</b></span>`).join('') + (rows.length > 8 ? `<span class="sm-bp more">+${rows.length - 8} more</span>` : '') : '';
        }
        function smBulkAdd() {
            const ta = smEl('smBulk'); if (!ta || !smShowId) return;
            const rows = smParseBulk(ta.value); if (!rows.length) return;
            const upd = {}, now = Date.now();
            rows.forEach((r, i) => { const id = smUid('g') + i.toString(36); upd['guests.' + id] = { id, name: r.name, tableId: '', size: r.size, arrived: 0, arrivedAt: null, addedAt: now + i }; });
            ta.value = ''; smBulkPreview();
            smWrite(smShowRef().update(upd));
            smToast(`Added ${rows.length} part${rows.length === 1 ? 'y' : 'ies'} to the waiting list`);
        }
        // ---- search bar at the top of the show: results appear right under it, with the check-in buttons ----
        function smOnSearch(v) {
            smFilter.q = v;
            const x = smEl('smQx'); if (x) x.style.display = v ? 'block' : 'none';
            const s = smCurShow(); if (s) smRenderSearch(s);
        }
        function smClearSearch() { const i = smEl('smQ'); if (i) i.value = ''; smOnSearch(''); }
        function smRenderSearch(show) {
            const box = smEl('smResults'), body = smEl('smSearchBody'); if (!box || !body) return;
            const q = smFilter.q.trim();
            if (!q) { box.style.display = 'none'; body.innerHTML = ''; return; }
            body.innerHTML = smTableCardsHtml(show, { q: q.toLowerCase(), pending: false, hideEmpty: true }) || `<p class="sm-noresult">Nothing matches “${escapeHtml(q)}”.</p>`;
            box.style.display = 'block';
        }
        // ---- table popup: tap a table (on the map or in the list) to edit everything about it ----
        function smOpenTable(id) {
            const show = smCurShow(); if (!show || !smItems(show).some(i => i.id === id && smIsSeat(i))) return;
            smTableOpenId = id; smSelId = id; smPanelSig = '';
            smRenderMap(show); smRenderList(show); smRenderTableModal(show);
            smEl('smTableModal').style.display = 'flex';
            const empty = !smGuests(show).some(g => g.tableId === id);
            if (empty) { const inp = smEl('smAdd_' + id); if (inp) try { inp.focus(); } catch (err) { /* ignore */ } } // an empty table is for adding someone
        }
        function smCloseTable() {
            smTableOpenId = null; smSelId = null;
            smEl('smTableModal').style.display = 'none';
            const s = smCurShow(); if (s) { smPanelSig = ''; smRenderPanel(s); smRenderMap(s); smRenderList(s); smRenderSearch(s); }
        }
        function smRenderTableModal(show) {
            if (!smTableOpenId) return;
            const it = smItems(show).find(i => i.id === smTableOpenId);
            if (!it) { smCloseTable(); return; } // the table was removed while its popup was open
            const st = smTableStats(show).stats[it.id] || { total: 0, arrived: 0 }, cap = smCap(it), id = it.id, sid = escapeHtml(jsStr(id));
            const extra = Math.max(0, st.arrived - cap), overbooked = Math.max(0, st.total - cap);
            const rows = smGuests(show).filter(g => g.tableId === id).sort((a, b) => smNatural(a.name, b.name));
            const waiting = smTableStats(show).unseated.sort((a, b) => smNatural(a.name, b.name));
            smEl('smTmTitle').textContent = smItemName(it);
            smEl('smTmSub').innerHTML = `${it.type === 'bar' ? cap + ' bar seats' : SM_TYPES[it.type].label} · <b>${st.arrived}</b> of ${cap} seats filled${extra ? ` <span class="sm-tc-over">${extra} extra — charge</span>` : overbooked ? ` <span class="sm-tc-over soft">${overbooked} over seats</span>` : ''}`;
            smPreserve(smEl('smTmBody'), () => {
                smEl('smTmBody').innerHTML = `
                    <div class="sm-tm-num">
                        <label class="sm-tm-f1"><span>${it.type === 'bar' ? 'Bar section' : 'Table'} number</span><input id="smTmNum" class="input-field" value="${escapeHtml(it.num || '')}" maxlength="8" onkeydown="if(event.key==='Enter'){event.preventDefault();smSaveTableNum('${sid}');}" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done" name="sm_tblnum" data-1p-ignore></label>
                        <button class="btn btn-outline" onclick="smSaveTableNum('${sid}')">Change</button>
                    </div>
                    <div class="sm-tm-hint">Changing the number just renames this table — the old number is gone, nothing else moves.</div>
                    ${waiting.length ? `<div class="sm-tm-label">⏳ Waiting for a table (${waiting.length}) — tap to seat here</div>
                    <div class="sm-wchips">${waiting.map(g => `<button class="sm-wchip" onclick="smSeatHere('${escapeHtml(jsStr(g.id))}', '${sid}')"><b>${escapeHtml(g.name)}</b><span>party of ${g.size}</span></button>`).join('')}</div>` : ''}
                    <div class="sm-tm-label">New purchaser</div>
                    <div class="sm-tm-add">
                        <label class="sm-tm-f1"><span>Purchaser name</span><input id="smAdd_${escapeHtml(id)}" class="input-field" placeholder="Who bought this table?" onkeydown="if(event.key==='Enter'){event.preventDefault();smAddBooking('${sid}');}" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="done" name="sm_buyer" data-1p-ignore></label>
                        <label class="sm-tm-f2"><span>People</span><input id="smSz_${escapeHtml(id)}" class="input-field sm-sz" type="number" inputmode="numeric" min="1" max="99" value="${Math.max(1, cap - st.total)}" aria-label="People in the party" onkeydown="if(event.key==='Enter'){event.preventDefault();smAddBooking('${sid}');}"></label>
                        <button class="btn" onclick="smAddBooking('${sid}')">Add</button>
                    </div>
                    <div class="sm-tm-label">${rows.length ? `Bookings at this table (${rows.length})` : 'No one booked at this table yet'}</div>
                    ${rows.map(g => smBookingRow(g)).join('')}`;
            });
        }
        // Seat a waiting party at this table (from the table's popup).
        function smSeatHere(gid, tableId) {
            const show = smCurShow(); if (!show) return;
            const g = smGuests(show).find(x => x.id === gid), it = smItems(show).find(i => i.id === tableId); if (!g || !it) return;
            smWrite(smShowRef().update({ ['guests.' + gid + '.tableId']: tableId, ['guests.' + gid + '.wasTable']: firebase.firestore.FieldValue.delete() }));
            smToast(`${g.name} → ${smItemName(it)}`);
        }

        // ---------- QUICK ADD / SEAT PICKER ----------
        // One dialog, two jobs. "＋ Add" (top of a show): type a purchaser, then tap the table to seat them - best-fitting open tables first.
        // "Seat at a table…" on a waiting party (or ⇄ on a seated one): no typing, just tap the table.
        function smOpenQuickAdd() {
            if (!smCurShow() || smEditTarget) return;
            smQa = { mode: 'add' };
            smEl('smQaName').value = ''; smEl('smQaSize').value = '2'; smEl('smQaHere').checked = true;
            smEl('smQaForm').style.display = 'block';
            smEl('smQaTitle').textContent = '＋ Add a purchaser';
            smEl('smQaSub').textContent = 'Type who bought, then tap the table to seat them.';
            smEl('smQuickModal').style.display = 'flex';
            smRenderQuick();
            setTimeout(() => { try { smEl('smQaName').focus(); } catch (err) { /* ignore */ } }, 40);
        }
        function smMoveGuest(gid) {
            const show = smCurShow(); if (!show) return;
            const g = smGuests(show).find(x => x.id === gid); if (!g) return;
            smQa = { mode: 'seat', gid };
            smEl('smQaForm').style.display = 'none';
            smEl('smQuickModal').style.display = 'flex';
            smRenderQuick();
        }
        function smCloseQuick() { smQa = null; const m = smEl('smQuickModal'); if (m) m.style.display = 'none'; }
        function smRenderQuick() {
            const m = smEl('smQuickModal'); if (!m || !smQa || m.style.display !== 'flex') return;
            const show = smCurShow(); if (!show) { smCloseQuick(); return; }
            let g = null, size;
            if (smQa.mode === 'seat') {
                g = smGuests(show).find(x => x.id === smQa.gid);
                if (!g) { smCloseQuick(); return; }
                size = g.size;
                smEl('smQaTitle').textContent = `Seat ${g.name}`;
                smEl('smQaSub').textContent = `Party of ${g.size} — tap a table.`;
            } else size = Math.max(1, Math.min(99, parseInt(smEl('smQaSize').value, 10) || 1));
            const { stats } = smTableStats(show);
            const rows = smItems(show).filter(smIsSeat).map(it => {
                const st = stats[it.id] || { total: 0, parties: 0 }, own = g && g.tableId === it.id;
                const used = st.total - (own ? g.size : 0), parties = st.parties - (own ? 1 : 0), cap = smCap(it), free = cap - used;
                return { it, free, cap, fits: free >= size, empty: parties <= 0, own };
            });
            rows.sort((a, b) => (b.fits - a.fits) || (a.fits ? ((b.empty - a.empty) || ((a.free - size) - (b.free - size))) : (b.free - a.free)) || ((a.it.type === 'bar') - (b.it.type === 'bar')) || smNatural(a.it.num, b.it.num));
            const bestId = rows.length && rows[0].fits ? rows[0].it.id : null;
            smEl('smQaLbl').textContent = rows.length ? (g ? 'Tap a table' : `Tap a table to seat a party of ${size}`) : 'This room has no tables yet';
            smEl('smQaTables').innerHTML = rows.map(r => {
                const t = r.it, label = t.type === 'bar' ? r.cap + ' bar seats' : SM_TYPES[t.type].label + (smShape(t) === 'square' ? ' · square' : '');
                const note = r.empty && r.fits ? `Open · ${r.cap} seats` : r.fits ? `${r.free} seat${r.free === 1 ? '' : 's'} free` : r.free > 0 ? `Only ${r.free} free` : 'Full';
                return `<button class="sm-opt${r.fits ? '' : ' tight'}${r.own ? ' cur' : ''}" onclick="smQuickPick('${escapeHtml(jsStr(t.id))}')"><b>${escapeHtml(smItemName(t))}</b><span>${escapeHtml(label)}</span><em>${escapeHtml(note)}</em>${r.own ? '<i class="sm-opt-tag">current</i>' : t.id === bestId ? '<i class="sm-opt-tag best">best fit</i>' : ''}</button>`;
            }).join('');
            const wait = smEl('smQaWait');
            const alreadyWaiting = g && !smItems(show).some(i => i.id === g.tableId && smIsSeat(i));
            wait.style.display = alreadyWaiting ? 'none' : 'block';
            wait.textContent = g ? '⏳ Move to the waiting list' : '⏳ Add to the waiting list — no table yet';
        }
        // Tap a table (or '' = waiting list).
        function smQuickPick(tableId) {
            const show = smCurShow(); if (!show || !smQa) return;
            const tbl = tableId ? smItems(show).find(i => i.id === tableId && smIsSeat(i)) : null;
            if (tableId && !tbl) { smRenderQuick(); return; } // the table was removed while the box was open
            if (smQa.mode === 'seat') {
                const g = smGuests(show).find(x => x.id === smQa.gid); if (!g) { smCloseQuick(); return; }
                const FV = firebase.firestore.FieldValue;
                smWrite(smShowRef().update({ ['guests.' + g.id + '.tableId']: tableId, ['guests.' + g.id + '.wasTable']: FV.delete() }));
                smCloseQuick();
                smToast(`${g.name} → ${tbl ? smItemName(tbl) : 'waiting list'}`);
                return;
            }
            const nameEl = smEl('smQaName'), name = nameEl.value.trim();
            if (!name) { nameEl.focus(); smToast('Type the purchaser’s name first.'); return; }
            const size = Math.max(1, Math.min(99, parseInt(smEl('smQaSize').value, 10) || 1)), here = smEl('smQaHere').checked, id = smUid('g');
            const g = { id, name: name.slice(0, 80), tableId: tableId || '', size, arrived: here ? size : 0, arrivedAt: here ? Date.now() : null, addedAt: Date.now(), walkin: true };
            let over = null;
            if (tbl && here) {
                const before = (smTableStats(show).stats[tbl.id] || { arrived: 0 }).arrived, cap = smCap(tbl);
                if (before + size > cap) over = { tableName: smItemName(tbl), cap, after: before + size, name: g.name, gid: id, prevArrived: 0, prevSize: size };
            }
            smWrite(smShowRef().update({ ['guests.' + id]: g }));
            smCloseQuick();
            smToast(`${g.name} (${size}) → ${tbl ? smItemName(tbl) : 'waiting list'}`);
            if (over) smShowOverCapacity(over);
        }

        // Add one booking: the purchaser's name and how many people are in the party (defaults to the seats still free).
        function smAddBooking(tableId) {
            const input = smEl('smAdd_' + tableId); if (!input) return;
            const name = input.value.trim(); if (!name) { input.focus(); return; }
            const size = Math.max(1, Math.min(99, parseInt((smEl('smSz_' + tableId) || {}).value, 10) || 1));
            const id = smUid('g');
            input.value = '';
            const szEl = smEl('smSz_' + tableId); if (szEl) szEl.value = szEl.defaultValue; // next purchaser starts from the seats still free
            smWrite(smShowRef().update({ ['guests.' + id]: { id, name: name.slice(0, 80), tableId, size, arrived: 0, arrivedAt: null, addedAt: Date.now() } }));
            input.focus(); // ready for the next purchaser
        }
        // +1 / -1 person arrived. Uses an atomic increment so two hosts checking in at once both count.
        function smArrive(gid, delta) {
            const show = smCurShow(); if (!show) return;
            const g = smGuests(show).find(x => x.id === gid); if (!g) return;
            const next = Math.max(0, g.arrived + delta); if (next === g.arrived) return;
            smSetArrived(g, next, g.rawNum ? firebase.firestore.FieldValue.increment(next - g.arrived) : next);
        }
        function smArriveAll(gid) {
            const show = smCurShow(); if (!show) return;
            const g = smGuests(show).find(x => x.id === gid); if (!g || g.arrived >= g.size) return;
            smSetArrived(g, g.size, g.size);
        }
        function smSetArrived(g, next, value) {
            const show = smCurShow(); if (!show) return;
            const upd = { ['guests.' + g.id + '.arrived']: value, ['guests.' + g.id + '.arrivedAt']: next > 0 ? Date.now() : null };
            if (next > g.size) upd['guests.' + g.id + '.size'] = next; // more people showed up than were booked - the party grows
            // Will this arrival put more people at the table than it has seats?
            const it = smItems(show).find(i => i.id === g.tableId);
            let alertInfo = null;
            if (it && next > g.arrived) {
                const before = (smTableStats(show).stats[it.id] || { arrived: 0 }).arrived, after = before + (next - g.arrived), cap = smCap(it);
                if (after > cap) alertInfo = { tableName: smItemName(it), cap, after, name: g.name, gid: g.id, prevArrived: g.arrived, prevSize: g.size };
            }
            smWrite(smShowRef().update(upd));
            if (alertInfo) smShowOverCapacity(alertInfo);
        }
        async function smEditSize(gid) {
            let g = smGuests(smCurShow()).find(x => x.id === gid); if (!g) return;
            const v = await askText({ title: 'Party size', message: `How many people are in ${g.name}'s party?`, value: String(g.size), inputmode: 'numeric', okText: 'Save' });
            if (v === null) return;
            g = smGuests(smCurShow()).find(x => x.id === gid); if (!g) return; // the booking may have changed (or gone) while the box was open
            const n = Math.max(1, Math.min(99, parseInt(v, 10) || g.size));
            const upd = { ['guests.' + gid + '.size']: n };
            if (g.arrived > n) upd['guests.' + gid + '.arrived'] = n;
            smWrite(smShowRef().update(upd));
        }
        // ---- "table is full" popup: the host has to charge the purchaser ----
        let smOverCtx = null;
        function smShowOverCapacity(info) {
            smOverCtx = info;
            const extra = info.after - info.cap;
            smEl('smOverTitle').textContent = `${info.tableName} is full`;
            smEl('smOverMsg').innerHTML = `All <b>${info.cap}</b> seat${info.cap === 1 ? '' : 's'} at ${escapeHtml(info.tableName)} are taken, and <b>${info.after}</b> people have now arrived.<div class="sm-over-charge">Charge <b>${escapeHtml(info.name)}</b> for ${extra === 1 ? 'the extra guest' : `${extra} extra guests`}.</div>`;
            smEl('smOverModal').style.display = 'flex';
            try { if (navigator.vibrate) navigator.vibrate([150, 80, 150]); } catch (err) { /* not supported */ }
        }
        function smOverAck() { smOverCtx = null; closeModal('smOverModal'); }
        function smOverUndo() {
            const c = smOverCtx; smOverCtx = null; closeModal('smOverModal');
            if (!c) return;
            const g = smGuests(smCurShow()).find(x => x.id === c.gid); if (!g) return;
            smWrite(smShowRef().update({ ['guests.' + c.gid + '.arrived']: c.prevArrived, ['guests.' + c.gid + '.size']: c.prevSize }));
        }
        async function smRenameGuest(gid) {
            const g = smGuests(smCurShow()).find(x => x.id === gid); if (!g) return;
            const name = await askText({ title: 'Rename booking', message: 'Purchaser name:', value: g.name, okText: 'Save' });
            if (name === null || !name.trim()) return;
            smWrite(smShowRef().update({ ['guests.' + gid + '.name']: name.trim().slice(0, 80) }));
        }
        function smRemoveGuest(gid) {
            const g = smGuests(smCurShow()).find(x => x.id === gid); if (!g) return;
            if (!confirm(`Remove ${g.name}'s booking${g.size > 1 ? ` (party of ${g.size})` : ''}?`)) return;
            smWrite(smShowRef().update({ ['guests.' + gid]: firebase.firestore.FieldValue.delete() }));
        }

        // ---------- VENUES TAB ----------
        async function smAddVenue() {
            smEnsureListeners();
            const name = await askText({ title: '📍 New venue', message: 'Venue name:', okText: 'Add venue' });
            if (!name || !name.trim()) return;
            const v = { id: smUid('v'), name: name.trim(), address: '' };
            saveDoc('venues', v.id, v).catch(() => {});
        }
        async function smRenameVenue(id) {
            const v = smVenues().find(x => x.id === id); if (!v) return;
            const name = await askText({ title: 'Rename venue', message: 'Venue name:', value: v.name, okText: 'Rename' });
            if (!name || !name.trim()) return;
            smWrite(db.collection('venues').doc(id).update({ name: name.trim() }));
            // Shows keep a copy of the name for the tiles - keep those in step.
            smShows().filter(s => s.venueId === id).forEach(s => smWrite(db.collection('shows').doc(s.id).update({ venueName: name.trim() })));
        }
        async function smVenueAddress(id) {
            const v = smVenues().find(x => x.id === id); if (!v) return;
            const a = await askText({ title: 'Venue address', message: v.name, value: v.address || '', okText: 'Save' });
            if (a === null) return;
            smWrite(db.collection('venues').doc(id).update({ address: a.trim() }));
        }
        function smDeleteVenue(id) {
            const v = smVenues().find(x => x.id === id); if (!v) return;
            const plans = smPlans().filter(p => p.venueId === id), n = smShows().filter(s => s.venueId === id).length;
            if (!confirm(`Delete venue "${v.name}" and its ${plans.length} saved floorplan${plans.length === 1 ? '' : 's'}?${n ? `\n\n${n} show${n === 1 ? '' : 's'} at this venue keep their own layout and guests.` : ''}`)) return;
            const batch = db.batch();
            plans.forEach(p => batch.delete(db.collection('floorplans').doc(p.id)));
            batch.delete(db.collection('venues').doc(id));
            smWrite(batch.commit());
        }
        async function smRenamePlan(id) {
            const p = smPlans().find(x => x.id === id); if (!p) return;
            const name = await askText({ title: 'Rename floorplan', message: 'Floorplan name:', value: p.name, okText: 'Rename' });
            if (!name || !name.trim()) return;
            smWrite(db.collection('floorplans').doc(id).update({ name: name.trim() }));
            smShows().filter(s => s.floorplanId === id).forEach(s => smWrite(db.collection('shows').doc(s.id).update({ floorplanName: name.trim() })));
        }
        // Delete button in a show's floorplan bar: removes the saved layout picked in the list (never touches any show's own room).
        function smDeleteSelectedPlan() {
            const id = (smEl('smPlanSel') || {}).value;
            if (!id) { alert('Choose the saved floorplan you want to delete from the list first.'); return; }
            smDeletePlan(id);
        }
        function smDeletePlan(id) {
            const p = smPlans().find(x => x.id === id); if (!p) return;
            if (!confirm(`Delete the saved floorplan "${p.name}"? Shows already using it keep their own copy.`)) return;
            smWrite(db.collection('floorplans').doc(id).delete());
        }
        // ---- layouts & the venue "building" (its walls and zones), edited from the Venues page - no show needed ----
        const smStructure = items => (items || []).filter(i => !smIsSeat(i)); // walls, doors, stage, bar counter, bathrooms... (everything but tables)
        function smEditPlan(id) { if (smPlans().some(p => p.id === id)) smOpenLayoutEditor('plan', id); }
        // The building starts as the walls & zones of the venue's most recently edited layout (if it has one), then you adjust it.
        async function smEditBuilding(venueId) {
            const v = smVenues().find(x => x.id === venueId); if (!v) return;
            if (!v.building) {
                const last = smPlans().filter(p => p.venueId === venueId).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
                const building = { items: last ? smClone(smStructure(last.items)) : [], w: last ? (last.w || SM_DEF_W) : SM_DEF_W, h: last ? (last.h || SM_DEF_H) : SM_DEF_H };
                v.building = building; // optimistic: the editor opens before the listener echoes the write back
                try { await withTimeout(db.collection('venues').doc(venueId).update({ building: cleanData(building) }), 15000, 'saving the building'); }
                catch (err) { delete v.building; alert('⚠️ Could not save: ' + err.message); return; }
            }
            smOpenLayoutEditor('building', venueId);
        }
        // New layout: start from the venue's building, a copy of an existing layout, or a blank room.
        async function smNewPlan(venueId) {
            const v = smVenues().find(x => x.id === venueId); if (!v) return;
            const plans = smPlans().filter(p => p.venueId === venueId).sort((a, b) => smNatural(a.name, b.name));
            const options = [];
            if (v.building) options.push({ value: 'building', label: '🏛️ The building (walls & zones)', desc: 'Starts with the venue’s walls, doors and zones — you just add the tables.', primary: true });
            plans.slice(0, 8).forEach(p => options.push({ value: 'plan:' + p.id, label: `Copy of “${p.name}”`, desc: 'Everything in that layout, tables included.' }));
            options.push({ value: 'blank', label: 'Blank room', desc: 'Start from nothing.' });
            const how = options.length === 1 ? 'blank' : await smChoose({ title: `New layout at ${v.name}`, message: 'What should it start with?', options });
            if (how === null) return;
            let items = [], w = SM_DEF_W, h = SM_DEF_H;
            if (how === 'building' && v.building) { items = smClone(v.building.items || []); w = v.building.w || SM_DEF_W; h = v.building.h || SM_DEF_H; }
            else if (how.indexOf('plan:') === 0) { const p = smPlans().find(x => x.id === how.slice(5)); if (p) { items = smClone(p.items || []); w = p.w || SM_DEF_W; h = p.h || SM_DEF_H; } }
            const name = await askText({ title: '🗺️ New layout', message: 'Name this layout (e.g. "Runway night", "Square stage"):', value: 'Layout ' + (plans.length + 1), okText: 'Create' });
            if (!name || !name.trim()) return;
            const plan = { id: smUid('f'), venueId, name: name.trim(), items, w, h, updatedAt: Date.now() };
            try { await saveDoc('floorplans', plan.id, plan); } catch (err) { return; }
            smOpenLayoutEditor('plan', plan.id);
        }
        async function smDuplicatePlan(id) {
            const p = smPlans().find(x => x.id === id); if (!p) return;
            const name = await askText({ title: 'Duplicate layout', message: 'Name for the copy:', value: p.name + ' copy', okText: 'Duplicate' });
            if (!name || !name.trim()) return;
            const copy = { id: smUid('f'), venueId: p.venueId, name: name.trim(), items: smClone(p.items || []), w: p.w || SM_DEF_W, h: p.h || SM_DEF_H, updatedAt: Date.now() };
            saveDoc('floorplans', copy.id, copy).then(() => smToast('Copy made — tap Edit to change it')).catch(() => {});
        }
        // In a layout's editor: swap its walls & zones for the venue's current building (tables stay, pulled inside the room if needed).
        async function smApplyBuilding() {
            const show = smCurShow(); if (!show || !smEditTarget || smEditTarget.kind !== 'plan') return;
            const v = smVenues().find(x => x.id === show.venueId); if (!v || !v.building) return;
            const ok = await smChoose({ title: 'Use the venue’s building?', message: 'This layout’s walls, doors and zones are replaced by the building’s. Its tables stay where they are (moved inside the room if needed).', options: [{ value: 'go', label: 'Replace walls & zones', primary: true }] });
            if (ok === null) return;
            const w = v.building.w || SM_DEF_W, h = v.building.h || SM_DEF_H;
            const items = smClone(smItems(smCurShow())).filter(smIsSeat).map(it => { const c = smClampTo(it, it.x, it.y, w, h); it.x = c.x; it.y = c.y; return it; }).concat(smClone(v.building.items || []));
            const live = smCurShow(); live.layout.items = items; live.layout.w = w; live.layout.h = h; // optimistic
            smSelId = null; smPanelSig = '';
            smWrite(smLayoutUpdate({ 'layout.items': cleanData(items), 'layout.w': w, 'layout.h': h }));
            smRenderShow(smCurShow());
        }
        function smRenderVenues() {
            const el = smEl('smVenuesBody');
            if (smDataError) { el.innerHTML = `<p style="color:var(--danger-glow);">Couldn't load venues: ${escapeHtml(smDataError)}</p>`; return; }
            if (!smLoaded.venues) { el.innerHTML = `<p style="color:var(--text-muted);">Loading venues…</p>`; return; }
            const venues = [...smVenues()].sort((a, b) => smNatural(a.name, b.name));
            el.innerHTML = venues.map(v => {
                const plans = smPlans().filter(p => p.venueId === v.id).sort((a, b) => smNatural(a.name, b.name));
                const nShows = smShows().filter(s => s.venueId === v.id).length;
                return `<div class="glass-card sm-venue">
                    <div class="sm-venue-head">
                        <div style="min-width:0;"><div class="sm-venue-name">${escapeHtml(v.name)}</div>
                        <div class="sm-venue-sub">${v.address ? '📍 ' + escapeHtml(v.address) + ' · ' : ''}${nShows} show${nShows === 1 ? '' : 's'}</div></div>
                        <div class="sm-venue-btns"><button class="btn btn-outline btn-sm" onclick="smRenameVenue('${escapeHtml(jsStr(v.id))}')">Rename</button><button class="btn btn-outline btn-sm" onclick="smVenueAddress('${escapeHtml(jsStr(v.id))}')">Address</button><button class="btn btn-sm btn-magenta" onclick="smDeleteVenue('${escapeHtml(jsStr(v.id))}')">Delete</button></div>
                    </div>
                    <div class="sm-bldg">
                        <div style="min-width:0;"><b>🏛️ Building</b><span>${v.building ? `${smStructure(v.building.items).length} wall / zone piece${smStructure(v.building.items).length === 1 ? '' : 's'} · ${v.building.w || SM_DEF_W}×${v.building.h || SM_DEF_H} — new layouts can start from it` : 'Set up the walls and zones that never change, so each new layout only needs its tables.'}</span></div>
                        <div class="sm-venue-btns"><button class="btn btn-sm" onclick="smEditBuilding('${escapeHtml(jsStr(v.id))}')">${v.building ? '✏️ Edit building' : '＋ Set up building'}</button></div>
                    </div>
                    <div class="sm-plans-head"><span>Layouts</span><button class="btn btn-sm" onclick="smNewPlan('${escapeHtml(jsStr(v.id))}')">＋ New layout</button></div>
                    <div class="sm-plans">${plans.map(p => {
                        const it = p.items || [], tables = it.filter(i => i.type === 't2' || i.type === 't4' || i.type === 't6'), barSeats = it.filter(i => i.type === 'bar').reduce((n, i) => n + (i.seats || 6), 0);
                        const seats = tables.reduce((n, i) => n + smCap(i), 0) + barSeats, pieces = it.filter(i => !smIsSeat(i)).length;
                        return `<div class="sm-plan"><div style="min-width:0;"><b>${escapeHtml(p.name)}</b><span>${tables.length} tables${barSeats ? ' + ' + barSeats + ' bar seats' : ''} · ${seats} seats${pieces ? ' · ' + pieces + ' room piece' + (pieces === 1 ? '' : 's') : ''} · ${p.w || SM_DEF_W}×${p.h || SM_DEF_H}</span></div>
                            <div class="sm-venue-btns"><button class="btn btn-sm" onclick="smEditPlan('${escapeHtml(jsStr(p.id))}')">✏️ Edit</button><button class="btn btn-outline btn-sm" onclick="smDuplicatePlan('${escapeHtml(jsStr(p.id))}')">Duplicate</button><button class="btn btn-outline btn-sm" onclick="smRenamePlan('${escapeHtml(jsStr(p.id))}')">Rename</button><button class="btn btn-sm btn-magenta" onclick="smDeletePlan('${escapeHtml(jsStr(p.id))}')">Delete</button></div></div>`;
                    }).join('') || `<div class="sm-plan-empty">No saved layouts yet. Tap “New layout” above, or open a show at this venue, lay out the room, then tap “Save as new”.</div>`}</div>
                </div>`;
            }).join('') || `<p style="color:var(--text-muted); text-align:center; padding:30px 10px;">No venues yet. Add one here, or pick “New venue…” when creating a show.</p>`;
        }
