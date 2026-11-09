        /* SHOW MANAGER — the second module of the app.
           Switched to from the name dropdown (Show Manager / Security). It has its own list of
           shows (same flyer-tile look as the security Events feed, but a separate collection),
           and inside each show a floorplan of the venue where tables can be dragged around,
           guests are typed in per table, and each person is checked off as they arrive.

           DATA (all plain Firestore collections, covered by the signed-in catch-all rule):
             venues/{id}      { id, name, address }
             floorplans/{id}  { id, venueId, name, items[], updatedAt }   <- saved layouts, several per venue
             shows/{id}       { id, title, date, startTime, endTime, venueId, venueName, image, ticketLink,
                                desc, tags[], floorplanId, floorplanName,
                                layout: { items[] },          <- this show's own copy of the room
                                guests: { [guestId]: { id, name, tableId, arrived, arrivedAt } } }
           Layout items: { id, type: 't2'|'t4'|'t6'|'bar'|'stage', x, y, rot, num (label), seats (bar), shape (stage) }.
           x/y are the item's centre on a fixed 1000 x 640 canvas.

           Guests are a MAP on the show doc and are written with dotted field paths
           ('guests.<id>.arrived'), so two phones checking people in at once never overwrite each other,
           and moving a table (which only writes 'layout.items') never touches the guest list.

           These three collections are deliberately NOT in allCollections (js/03): they are loaded by
           their own listeners the first time someone opens the module, so security-only users pay nothing. */

        const SM_W = 1000, SM_H = 640, SM_GRID = 10;
        const SM_DEFAULT_IMG = 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=700';
        // Every top-level view of the security module - hidden while the Show Manager is open.
        const SM_SECURITY_VIEWS = ['eventsFeedView', 'eventDetailView', 'calendarView', 'teamChatView', 'banListView', 'myShiftsView', 'contactsDirectoryView', 'licensesView', 'dashboardView', 'settingsView', 'adminConsoleView'];
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
        let smSelId = null;           // selected layout item
        let smZoom = 1;
        let smFilter = { q: '', pending: false, hideEmpty: false };
        let smDrag = null;
        let smListening = false;
        const smLoaded = { shows: false, venues: false, floorplans: false };
        let smDataError = '';
        let smSyncCount = 0, smSyncErr = '';
        let smHeadSig = '', smPanelSig = '';
        let smFormTags = [], smFormEditId = null;

        const smEl = id => document.getElementById(id);
        const smClone = o => JSON.parse(JSON.stringify(o));
        const smShows = () => getDB('shows');
        const smVenues = () => getDB('venues');
        const smPlans = () => getDB('floorplans');
        const smCurShow = () => smShows().find(s => s.id === smShowId);
        const smItems = show => (show && show.layout && show.layout.items) || [];
        const smGuests = show => Object.values((show && show.guests) || {}).filter(g => g && g.name);
        const smUid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const smIsSeat = it => it.type !== 'stage';
        const smCap = it => it.type === 'bar' ? Math.max(1, it.seats || 6) : (SM_TYPES[it.type] ? SM_TYPES[it.type].cap : 0);
        const smNatural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
        const smItemName = it => (it.type === 'bar' ? 'Bar ' : 'Table ') + (it.num || '?');
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
        function smOnData() { if (window._module === 'shows' && !smDrag) smRender(); }

        // ---------- ROUTER ----------
        function smGoTab(t) {
            smTab = t; smShowId = null; smShellId = null;
            try { localStorage.removeItem('ss_smShow'); } catch (err) { /* ignore */ }
            smRender();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        function smOpenShow(id) {
            smShowId = id; smShellId = null; smSeenShow = false; smOpenedAt = Date.now();
            try { localStorage.setItem('ss_smShow', id); } catch (err) { /* ignore */ }
            smRender();
            window.scrollTo({ top: 0 });
        }
        function smCloseShow() { smGoTab('shows'); }

        function smRender() {
            if (window._module !== 'shows') return;
            let show = null;
            if (smShowId) {
                show = smCurShow();
                if (show) smSeenShow = true;
                else if (smLoaded.shows) {
                    // Gone (deleted elsewhere / stale remembered id) - but give a show we just created a few seconds to arrive.
                    if (smSeenShow || Date.now() - smOpenedAt > 4000) { smShowId = null; try { localStorage.removeItem('ss_smShow'); } catch (err) { /* ignore */ } }
                    else setTimeout(smRender, 4200);
                }
            }
            const showOpen = !!smShowId;
            smEl('smShowsView').style.display = (!showOpen && smTab === 'shows') ? 'block' : 'none';
            smEl('smVenuesView').style.display = (!showOpen && smTab === 'venues') ? 'block' : 'none';
            smEl('smShowView').style.display = showOpen ? 'block' : 'none';
            document.querySelectorAll('#smDock .dock-item').forEach(b => b.classList.toggle('active', b.dataset.smtab === (showOpen ? 'shows' : smTab)));
            if (showOpen) smRenderShow(show);
            else if (smTab === 'shows') smRenderShowList();
            else smRenderVenues();
        }

        // ---------- SHOW LIST (same flyer tiles as the security Events feed) ----------
        function smGuestStats(show) {
            const gs = smGuests(show);
            return { total: gs.length, arrived: gs.filter(g => g.arrived).length };
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
                const status = st.total === 0 ? ['full', 'NO GUESTS YET'] : st.arrived === st.total ? ['in', `ALL ${st.total} HERE`] : ['open', `${st.arrived} / ${st.total} HERE`];
                const titleHtml = `<h3 class="ev2-name">${escapeHtml(s.title)}</h3>`;
                const hours = shiftHoursLabel(s);
                const cls = ['ev2', 'event-tile', mode === 'poster' ? 'is-poster' : '', isPast ? 'is-full' : '', group === 'TONIGHT' ? 'is-tonight' : ''].filter(Boolean).join(' ');
                html += `
                <div class="${cls}" style="animation-delay:${Math.min(idx++, 8) * 45}ms" role="button" tabindex="0" onclick="smOpenShow('${s.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();smOpenShow('${s.id}');}">
                    <div class="ev2-in">
                        <div class="ev2-media">
                            <div class="ev2-bg" style="background-image:url(&quot;${escapeHtml(evCssUrl(s.image || SM_DEFAULT_IMG))}&quot;)"></div>
                            <img src="${escapeHtml(s.image || SM_DEFAULT_IMG)}" alt="" loading="lazy" onload="smImgLoaded(this)" onerror="this.onerror=null;this.src='${SM_DEFAULT_IMG}'">
                            ${dp ? `<div class="ev2-date"><span class="w">${dp.wk}</span><span class="d">${dp.day}</span><span class="m">${dp.mon}</span></div>` : ''}
                            <div class="ev2-status ${status[0]}"><i></i>${status[1]}</div>
                            ${mode === 'poster' ? '' : titleHtml}
                        </div>
                        <div class="ev2-body">
                            ${mode === 'poster' ? titleHtml : ''}
                            <div class="ev2-meta"><span>🕘 ${escapeHtml(shiftTimeLabel(s))}${hours ? ' &middot; ' + escapeHtml(hours) : ''}</span><span class="go">Seating ›</span></div>
                            ${s.venueName ? `<div style="font-size:0.8rem; color:var(--text-secondary);">📍 ${escapeHtml(s.venueName)}</div>` : ''}
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
        function smVenueChanged() {
            const sel = smEl('smfVenue');
            if (sel.value === '__new') {
                const name = prompt('Name of the new venue:');
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
            smEl('smfTags').innerHTML = getTagCatalog().map(t => `<span class="neon-tag ${smFormTags.includes(t) ? 'tag-active' : 'tag-inactive'}" style="cursor:pointer;" onclick="smToggleFormTag('${jsStr(t)}')">${smFormTags.includes(t) ? '✓ ' : ''}${escapeHtml(t)}</span>`).join('') || '<span style="color:var(--text-muted); font-size:0.8rem;">No tags in the catalog yet.</span>';
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
            let job;
            if (smFormEditId) {
                // Merge only the details so a check-in landing at the same moment isn't overwritten.
                job = withTimeout(db.collection('shows').doc(smFormEditId).update(cleanData(fields)), 15000, 'saving the show');
            } else {
                const plan = smPlans().find(p => p.id === smEl('smfPlan').value);
                const show = {
                    id: smUid('s'), ...fields, createdAt: Date.now(), createdBy: (currUser() || {}).name || '',
                    floorplanId: plan ? plan.id : '', floorplanName: plan ? plan.name : '',
                    layout: { items: plan ? smClone(plan.items || []) : [] }, guests: {}
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
            if (!confirm(`Delete "${show.title}"${n ? ` and its ${n} guest${n === 1 ? '' : 's'}` : ''}? This can't be undone.`)) return;
            deleteDoc('shows', show.id).then(() => { logAction('Deleted show: ' + show.title); smCloseShow(); }).catch(() => {});
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
        function smSaveItems(items) {
            return smWrite(smShowRef().update({ 'layout.items': cleanData(items) }));
        }

        // ---------- SHOW VIEW SHELL ----------
        function smBuildShell() {
            smEl('smShowRoot').innerHTML = `
                <button class="btn btn-outline btn-sm" style="margin-bottom:14px;" onclick="smCloseShow()">← All Shows</button>
                <div id="smHead"></div>
                <div class="sm-grid">
                    <div class="sm-left">
                        <div class="glass-card sm-mapcard">
                            <div class="sm-maptop">
                                <div class="sm-seg" id="smModeToggle">
                                    <button data-m="seat" onclick="smSetMode('seat')">🪑 Seating</button>
                                    <button data-m="layout" onclick="smSetMode('layout')">✏️ Edit layout</button>
                                </div>
                                <div class="sm-zoom"><button class="btn btn-outline btn-sm" onclick="smSetZoom(smZoom-0.25)" aria-label="Zoom out">−</button><span id="smZoomLbl"></span><button class="btn btn-outline btn-sm" onclick="smSetZoom(smZoom+0.25)" aria-label="Zoom in">+</button></div>
                            </div>
                            <div id="smPanel"></div>
                            <div class="sm-mapwrap" id="smMapWrap">
                                <svg id="smSvg" class="sm-svg" viewBox="0 0 ${SM_W} ${SM_H}" xmlns="http://www.w3.org/2000/svg">
                                    <defs><pattern id="smGridPat" width="${SM_GRID * 4}" height="${SM_GRID * 4}" patternUnits="userSpaceOnUse"><path d="M ${SM_GRID * 4} 0 L 0 0 0 ${SM_GRID * 4}" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1"/></pattern></defs>
                                    <rect class="sm-floor" x="0" y="0" width="${SM_W}" height="${SM_H}" rx="18" fill="#232334"/>
                                    <rect x="0" y="0" width="${SM_W}" height="${SM_H}" rx="18" fill="url(#smGridPat)"/>
                                    <rect x="1.5" y="1.5" width="${SM_W - 3}" height="${SM_H - 3}" rx="18" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="3"/>
                                    <g id="smItems"></g>
                                </svg>
                            </div>
                            <div class="sm-legend">
                                <span><i class="sm-dot free"></i>Open seat</span><span><i class="sm-dot reserved"></i>Assigned</span><span><i class="sm-dot arrived"></i>Arrived</span><span><i class="sm-dot over"></i>Over capacity</span>
                            </div>
                        </div>
                    </div>
                    <div class="sm-right">
                        <div class="glass-card sm-listcard">
                            <div id="smSummary"></div>
                            <input type="search" id="smQ" class="input-field" style="margin:10px 0 8px;" placeholder="Find a guest or table…" oninput="smFilter.q=this.value; smRenderListNow()" data-1p-ignore>
                            <div class="sm-filters">
                                <button class="ev-chip" id="smFPending" onclick="smToggleFilter('pending')">Still to arrive</button>
                                <button class="ev-chip" id="smFEmpty" onclick="smToggleFilter('hideEmpty')">Hide empty tables</button>
                            </div>
                            <div id="smListScroll"><div id="smListBody"></div></div>
                        </div>
                    </div>
                </div>`;
            smInitSvgEvents();
            smShellId = smShowId;
            smHeadSig = ''; smPanelSig = '';
        }

        function smRenderShow(show) {
            if (!show) { smEl('smShowRoot').innerHTML = `<button class="btn btn-outline btn-sm" style="margin-bottom:14px;" onclick="smCloseShow()">← All Shows</button><p style="color:var(--text-muted); padding:20px 4px;">${smDataError ? escapeHtml(smDataError) : 'Loading show…'}</p>`; smShellId = null; return; }
            if (smShellId !== show.id) {
                smMode = 'seat'; smSelId = null; smFilter = { q: '', pending: false, hideEmpty: false };
                smZoom = window.innerWidth < 700 ? 1.8 : 1;
                smBuildShell();
            }
            smRenderHead(show);
            smRenderChrome();
            smRenderPanel(show);
            smRenderMap(show);
            smRenderSummary(show);
            smRenderList(show);
            smSyncUi();
        }
        function smRenderChrome() {
            smEl('smModeToggle').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.m === smMode));
            smEl('smSvg').classList.toggle('layout', smMode === 'layout');
            smEl('smSvg').style.width = (smZoom * 100) + '%';
            smEl('smZoomLbl').textContent = Math.round(smZoom * 100) + '%';
            smEl('smFPending').classList.toggle('active', smFilter.pending);
            smEl('smFEmpty').classList.toggle('active', smFilter.hideEmpty);
        }
        function smSetMode(m) { smMode = m; smPanelSig = ''; const s = smCurShow(); smRenderChrome(); if (s) { smRenderPanel(s); smRenderMap(s); } }
        function smSetZoom(z) { smZoom = Math.min(2.5, Math.max(0.5, Math.round(z * 100) / 100)); smRenderChrome(); }
        function smToggleFilter(k) { smFilter[k] = !smFilter[k]; smRenderChrome(); smRenderListNow(); }
        function smRenderListNow() { const s = smCurShow(); if (s) smRenderList(s); }

        function smRenderHead(show) {
            const plans = smPlans().filter(p => p.venueId && p.venueId === show.venueId).sort((a, b) => smNatural(a.name, b.name));
            const based = plans.find(p => p.id === show.floorplanId);
            const sig = JSON.stringify([show.title, show.date, show.startTime, show.endTime, show.venueName, show.image, show.desc, show.tags, show.floorplanId, plans.map(p => p.id + p.name)]);
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
                        <button class="btn btn-outline btn-sm" onclick="smOpenShowModal('${show.id}')">✎ Edit details</button>
                        <button class="btn btn-sm btn-magenta" onclick="smDeleteShow()">Delete</button>
                    </div>
                </div>
                <div class="glass-card sm-planbar">
                    <label>Floorplan</label>
                    ${show.venueId ? `
                    <select id="smPlanSel" class="input-field">
                        <option value="">${plans.length ? 'Choose a saved floorplan…' : 'No saved floorplans for this venue yet'}</option>
                        ${plans.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.id === show.floorplanId ? ' (current base)' : ''}</option>`).join('')}
                    </select>
                    <button class="btn btn-outline btn-sm" onclick="smLoadPlan()">Load</button>
                    <button class="btn btn-sm" onclick="smSavePlanNew()">💾 Save as new</button>
                    ${based ? `<button class="btn btn-outline btn-sm" onclick="smUpdatePlan()">↻ Update “${escapeHtml(based.name)}”</button>` : ''}`
                    : `<span style="font-size:0.85rem; color:var(--text-muted);">Pick a venue (Edit details) to save and reuse floorplans.</span>`}
                    <span id="smSync" class="sm-sync"></span>
                </div>`;
        }

        // ---------- FLOORPLANS (saved layouts per venue) ----------
        function smLoadPlan() {
            const show = smCurShow(); if (!show) return;
            const plan = smPlans().find(p => p.id === (smEl('smPlanSel') || {}).value);
            if (!plan) { alert('Choose a saved floorplan first.'); return; }
            const n = smGuests(show).length;
            if (!confirm(`Replace this show's room with "${plan.name}"?${n ? `\n\nGuests are kept — anyone at a table number that exists in the new layout stays at that number; the rest show up as "Not seated" so you can move them.` : ''}`)) return;
            const items = smClone(plan.items || []);
            const upd = { 'layout.items': cleanData(items), floorplanId: plan.id, floorplanName: plan.name };
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
        function smSavePlanNew() {
            const show = smCurShow(); if (!show) return;
            if (!show.venueId) { alert('Pick a venue for this show first (Edit details).'); return; }
            const existing = smPlans().filter(p => p.venueId === show.venueId).length;
            const name = prompt('Name this floorplan (e.g. "Runway night", "Square stage"):', 'Layout ' + (existing + 1));
            if (!name || !name.trim()) return;
            const plan = { id: smUid('f'), venueId: show.venueId, name: name.trim(), items: smClone(smItems(show)), updatedAt: Date.now() };
            smSyncCount++; smSyncUi();
            saveDoc('floorplans', plan.id, plan).then(() => smWrite(smShowRef().update({ floorplanId: plan.id, floorplanName: plan.name })))
                .catch(() => {}).finally(() => { smSyncCount--; smSyncUi(); });
        }
        function smUpdatePlan() {
            const show = smCurShow(); if (!show) return;
            const plan = smPlans().find(p => p.id === show.floorplanId); if (!plan) return;
            if (!confirm(`Overwrite the saved floorplan "${plan.name}" with this show's current layout? Other shows keep their own copies.`)) return;
            smWrite(db.collection('floorplans').doc(plan.id).update({ items: cleanData(smItems(show)), updatedAt: Date.now() }));
        }

        // ---------- MAP (SVG) ----------
        function smDims(it) {
            if (it.type === 't2') return { w: 56, h: 56 };
            if (it.type === 't4') return { w: 72, h: 72 };
            if (it.type === 't6') return { w: 120, h: 72 };
            if (it.type === 'bar') return { w: Math.max(1, it.seats || 6) * 34, h: 34 };
            if (it.type === 'stage') return it.shape === 'square' ? { w: 240, h: 240 } : it.shape === 'wide' ? { w: 320, h: 110 } : { w: 440, h: 70 };
            return { w: 60, h: 60 };
        }
        // Half the on-canvas width/height once rotated, chairs included - used to keep an item inside the room.
        function smHalfExtent(it) {
            const d = smDims(it), pad = smIsSeat(it) ? 22 : 0;
            const w = (d.w + pad * 2) / 2, h = (d.h + pad * 2) / 2;
            return (it.rot || 0) % 180 === 90 ? { hw: h, hh: w } : { hw: w, hh: h };
        }
        function smClamp(it, x, y) {
            const e = smHalfExtent(it);
            return {
                x: Math.min(SM_W - e.hw, Math.max(e.hw, Math.round(x / SM_GRID) * SM_GRID)),
                y: Math.min(SM_H - e.hh, Math.max(e.hh, Math.round(y / SM_GRID) * SM_GRID))
            };
        }
        function smChairs(it) {
            const d = smDims(it), out = [];
            if (it.type === 't2') { out.push({ x: 0, y: -(d.h / 2 + 10) }, { x: 0, y: d.h / 2 + 10 }); }
            else if (it.type === 't4') { const r = d.w / 2 + 10; out.push({ x: 0, y: -r }, { x: r, y: 0 }, { x: 0, y: r }, { x: -r, y: 0 }); }
            else if (it.type === 't6') { [-36, 0, 36].forEach(x => out.push({ x, y: -(d.h / 2 + 10) })); [-36, 0, 36].forEach(x => out.push({ x, y: d.h / 2 + 10 })); }
            else if (it.type === 'bar') { for (let k = 0; k < Math.max(1, it.seats || 6); k++) out.push({ x: -d.w / 2 + 17 + k * 34, y: d.h / 2 + 13 }); }
            return out;
        }
        function smTableStats(show) {
            const stats = {};
            smItems(show).forEach(i => { if (smIsSeat(i)) stats[i.id] = { total: 0, arrived: 0 }; });
            const unseated = [];
            smGuests(show).forEach(g => {
                const s = stats[g.tableId];
                if (!s) { unseated.push(g); return; }
                s.total++; if (g.arrived) s.arrived++;
            });
            return { stats, unseated };
        }
        function smItemSvg(it, st, selected) {
            const d = smDims(it), rot = it.rot || 0;
            const tf = `translate(${it.x} ${it.y}) rotate(${rot})`;
            if (it.type === 'stage') {
                const label = it.shape === 'square' ? 'STAGE' : it.shape === 'wide' ? 'STAGE' : 'RUNWAY';
                return `<g class="sm-it sm-stage${selected ? ' sel' : ''}" data-id="${it.id}" transform="${tf}">
                    <rect class="sm-stage-body" fill="rgba(121,40,202,0.45)" stroke="#be78ff" stroke-width="2.5" x="${-d.w / 2}" y="${-d.h / 2}" width="${d.w}" height="${d.h}" rx="14"/>
                    <text class="sm-stage-lbl" fill="#fff" font-size="20" font-weight="800" letter-spacing="6" pointer-events="none" transform="rotate(${-rot})" text-anchor="middle" dy=".35em">${label}</text>
                    ${selected ? `<rect class="sm-selbox" fill="none" stroke="#00f5d4" stroke-width="2.5" stroke-dasharray="8 6" pointer-events="none" x="${-d.w / 2 - 6}" y="${-d.h / 2 - 6}" width="${d.w + 12}" height="${d.h + 12}" rx="18"/>` : ''}
                </g>`;
            }
            const cap = smCap(it);
            const status = st.total === 0 ? 'empty' : st.arrived >= st.total ? 'done' : st.arrived > 0 ? 'partial' : 'reserved';
            const over = st.total > cap;
            // Literal colours are only a fallback (SVG paints black by default if the stylesheet is stale or blocked);
            // the .sm-* CSS classes override them and carry the app theme.
            const FB = { free: '#4a4a5c', reserved: '#ff2a85', arrived: '#00ff87' };
            const chairs = smChairs(it).map((c, k) => { const cs = k < st.arrived ? 'arrived' : k < st.total ? 'reserved' : 'free'; return `<circle class="sm-ch ${cs}" fill="${FB[cs]}" cx="${c.x}" cy="${c.y}" r="8"/>`; }).join('');
            const bodyAttr = `fill="${{ empty: '#2c2c3e', reserved: '#5a1f3d', partial: '#5a4416', done: '#14573a' }[status]}" stroke="${over ? '#ff3366' : { empty: '#9a9ab0', reserved: '#ff2a85', partial: '#ffb020', done: '#00ff87' }[status]}" stroke-width="2.5"`;
            const body = it.type === 't2' || it.type === 't4'
                ? `<circle class="sm-tb ${status}${over ? ' over' : ''}" ${bodyAttr} r="${d.w / 2}"/>`
                : `<rect class="sm-tb ${status}${over ? ' over' : ''}" ${bodyAttr} x="${-d.w / 2}" y="${-d.h / 2}" width="${d.w}" height="${d.h}" rx="${it.type === 'bar' ? 8 : 22}"/>`;
            const label = it.type === 'bar' ? 'Bar ' + (it.num || '?') : (it.num || '?');
            const subTxt = st.total > 0 ? `${st.arrived}/${st.total} in` : '';
            // Labels sit at the item's centre and are counter-rotated so they stay upright on a rotated table.
            const texts = it.type === 'bar'
                ? `<text class="sm-num sm-num-bar" fill="#fff" font-size="15" font-weight="800" pointer-events="none" transform="rotate(${-rot})" text-anchor="middle" dy=".35em">${escapeHtml(label)}${subTxt ? ` <tspan class="sm-sub-in" fill="#ddd" font-size="12">· ${subTxt}</tspan>` : ''}</text>`
                : `<text class="sm-num" fill="#fff" font-size="22" font-weight="800" pointer-events="none" transform="rotate(${-rot})" text-anchor="middle" y="${subTxt ? -5 : 0}" dy=".35em">${escapeHtml(label)}</text>`
                  + (subTxt ? `<text class="sm-sub" fill="#ddd" font-size="12" font-weight="700" pointer-events="none" transform="rotate(${-rot})" text-anchor="middle" y="14">${subTxt}</text>` : '');
            const ext = smIsSeat(it) ? 22 : 0;
            return `<g class="sm-it sm-tbl${selected ? ' sel' : ''}" data-id="${it.id}" transform="${tf}">
                <rect class="sm-hit" fill="none" pointer-events="all" x="${-d.w / 2 - ext}" y="${-d.h / 2 - ext}" width="${d.w + ext * 2}" height="${d.h + ext * 2}"/>
                ${chairs}${body}${texts}
                ${selected ? `<rect class="sm-selbox" fill="none" stroke="#00f5d4" stroke-width="2.5" stroke-dasharray="8 6" pointer-events="none" x="${-d.w / 2 - ext - 4}" y="${-d.h / 2 - ext - 4}" width="${d.w + ext * 2 + 8}" height="${d.h + ext * 2 + 8}" rx="16"/>` : ''}
            </g>`;
        }
        function smRenderMap(show) {
            const layer = smEl('smItems'); if (!layer) return;
            const items = smItems(show), { stats } = smTableStats(show);
            const ordered = [...items.filter(i => i.type === 'stage'), ...items.filter(smIsSeat)];
            layer.innerHTML = ordered.map(i => smItemSvg(i, stats[i.id] || { total: 0, arrived: 0 }, i.id === smSelId)).join('')
                || `<text x="${SM_W / 2}" y="${SM_H / 2 - 8}" text-anchor="middle" fill="#fff" font-size="26" font-weight="700">The room is empty</text>
                    <text x="${SM_W / 2}" y="${SM_H / 2 + 28}" text-anchor="middle" fill="#c8c8d8" font-size="20">${smMode === 'layout' ? 'Use the Add buttons above to place tables, bar seats and the stage.' : 'Tap “Edit layout” to add tables, or load a saved floorplan.'}</text>`;
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
                smDrag = { id: it.id, g, rot: it.rot || 0, cx: ev.clientX, cy: ev.clientY, ox: p.x - it.x, oy: p.y - it.y, x: it.x, y: it.y, moved: false, canDrag: smMode === 'layout', item: it };
                try { svg.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
                if (smDrag.canDrag) ev.preventDefault();
            });
            svg.addEventListener('pointermove', ev => {
                const d = smDrag; if (!d || !d.canDrag) return;
                if (!d.moved && Math.hypot(ev.clientX - d.cx, ev.clientY - d.cy) < 5) return;
                d.moved = true;
                const p = smSvgPoint(svg, ev);
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
            smSelId = id; smPanelSig = '';
            smRenderPanel(show); smRenderMap(show); smRenderList(show);
            const card = smEl('smT_' + id);
            if (card && smMode === 'seat') card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        // Tap a table card's header in the list to highlight it on the map.
        function smSelectTable(id) {
            const show = smCurShow(); if (!show) return;
            smSelId = smSelId === id ? null : id; smPanelSig = '';
            smRenderPanel(show); smRenderMap(show); smRenderList(show);
        }

        // ---------- LAYOUT EDITING PANEL ----------
        function smNextNum(items, family) {
            const used = new Set(items.filter(i => (i.type === 'bar') === (family === 'bar') && smIsSeat(i)).map(i => String(i.num).toLowerCase()));
            let n = 1; while (used.has(String(n))) n++;
            return String(n);
        }
        function smFreeSpot(items, it) {
            for (let k = 0; k < 80; k++) {
                const x = SM_W / 2 - 240 + (k % 9) * 60, y = SM_H / 2 - 60 + Math.floor(k / 9) * 70;
                if (!items.some(o => Math.hypot(o.x - x, o.y - y) < 70)) return smClamp(it, x, y);
            }
            return smClamp(it, SM_W / 2, SM_H / 2);
        }
        function smAddItem(type) {
            const show = smCurShow(); if (!show) return;
            const items = smClone(smItems(show));
            if (type === 'stage') {
                const existing = items.find(i => i.type === 'stage');
                if (existing) { smSelId = existing.id; smPanelSig = ''; smRenderPanel(show); smRenderMap(show); return; }
            }
            const it = { id: smUid('i'), type, x: 0, y: 0, rot: 0 };
            if (type === 'bar') { it.seats = 6; it.num = smNextNum(items, 'bar'); }
            else if (type === 'stage') { it.shape = 'runway'; }
            else it.num = smNextNum(items, 'table');
            const pos = type === 'stage' ? smClamp(it, SM_W / 2, 90) : smFreeSpot(items, it);
            it.x = pos.x; it.y = pos.y;
            items.push(it);
            smSelId = it.id; smPanelSig = '';
            smSaveItems(items);
        }
        function smPatchItem(id, patch) {
            const show = smCurShow(); if (!show) return;
            const items = smClone(smItems(show));
            const it = items.find(i => i.id === id); if (!it) return;
            Object.assign(it, patch);
            const c = smClamp(it, it.x, it.y); it.x = c.x; it.y = c.y; // a rotation or bigger stage must not push it off the room
            smPanelSig = '';
            smSaveItems(items);
        }
        function smRotate(id) {
            const it = smItems(smCurShow()).find(i => i.id === id); if (!it) return;
            smPatchItem(id, { rot: ((it.rot || 0) + 90) % 360 });
        }
        function smSetShape(id, shape) { smPatchItem(id, { shape }); }
        function smSetSeats(id, n) { n = Math.max(1, Math.min(20, parseInt(n, 10) || 1)); smPatchItem(id, { seats: n }); }
        function smSetLabel(id, val) {
            const show = smCurShow(); if (!show) return;
            val = String(val).trim();
            const items = smItems(show), it = items.find(i => i.id === id); if (!it || !val) { smPanelSig = ''; smRenderPanel(show); return; }
            if (items.some(o => o.id !== id && smIsSeat(o) && (o.type === 'bar') === (it.type === 'bar') && String(o.num).toLowerCase() === val.toLowerCase())) {
                alert(`There's already a ${it.type === 'bar' ? 'bar section' : 'table'} labelled "${val}".`);
                smPanelSig = ''; smRenderPanel(show); return;
            }
            smPatchItem(id, { num: val });
        }
        function smDuplicate(id) {
            const show = smCurShow(); if (!show) return;
            const items = smClone(smItems(show)), src = items.find(i => i.id === id); if (!src || !smIsSeat(src)) return;
            const copy = { ...src, id: smUid('i'), num: smNextNum(items, src.type === 'bar' ? 'bar' : 'table') };
            const c = smClamp(copy, src.x + 40, src.y + 40); copy.x = c.x; copy.y = c.y;
            items.push(copy); smSelId = copy.id; smPanelSig = '';
            smSaveItems(items);
        }
        function smDeleteItem(id) {
            const show = smCurShow(); if (!show) return;
            const it = smItems(show).find(i => i.id === id); if (!it) return;
            const n = smGuests(show).filter(g => g.tableId === id).length;
            if (!confirm(`Remove ${it.type === 'stage' ? 'the stage' : smItemName(it)}?${n ? `\n\n${n} guest${n === 1 ? ' is' : 's are'} assigned here — they'll move to "Not seated" in the list so you can reseat them.` : ''}`)) return;
            smSelId = null; smPanelSig = '';
            smSaveItems(smClone(smItems(show)).filter(i => i.id !== id));
        }
        function smRenderPanel(show) {
            const panel = smEl('smPanel'); if (!panel) return;
            if (smMode !== 'layout') { if (panel.innerHTML) panel.innerHTML = ''; smPanelSig = ''; return; }
            const it = smItems(show).find(i => i.id === smSelId);
            const hasStage = smItems(show).some(i => i.type === 'stage');
            const sig = JSON.stringify([smMode, it, hasStage]);
            if (sig === smPanelSig) return;
            smPanelSig = sig;
            const sel = it ? `
                <div class="sm-sel-row">
                    <b>${it.type === 'stage' ? 'Stage' : escapeHtml(smItemName(it))}</b>
                    ${smIsSeat(it) ? `<label>Label <input id="smLblInput" class="input-field" value="${escapeHtml(it.num || '')}" maxlength="8" onchange="smSetLabel('${it.id}', this.value)" data-1p-ignore></label>` : ''}
                    ${it.type === 'bar' ? `<label>Seats <span class="sm-step"><button class="btn btn-outline btn-sm" onclick="smSetSeats('${it.id}', ${(it.seats || 6) - 1})">−</button><b>${it.seats || 6}</b><button class="btn btn-outline btn-sm" onclick="smSetSeats('${it.id}', ${(it.seats || 6) + 1})">+</button></span></label>` : ''}
                    ${it.type === 'stage' ? `<span class="sm-shapes">${[['runway', 'Runway'], ['square', 'Large square'], ['wide', 'Standard']].map(([k, l]) => `<button class="ev-chip${(it.shape || 'runway') === k ? ' active' : ''}" onclick="smSetShape('${it.id}','${k}')">${l}</button>`).join('')}</span>` : ''}
                    <button class="btn btn-outline btn-sm" onclick="smRotate('${it.id}')">⟳ Rotate</button>
                    ${smIsSeat(it) ? `<button class="btn btn-outline btn-sm" onclick="smDuplicate('${it.id}')">⧉ Duplicate</button>` : ''}
                    <button class="btn btn-sm btn-magenta" onclick="smDeleteItem('${it.id}')">Remove</button>
                </div>` : `<div class="sm-hint">Drag tables to move them. Tap one to rename, rotate or remove it.</div>`;
            panel.innerHTML = `
                <div class="sm-addbar">
                    <span>Add</span>
                    <button class="btn btn-sm" onclick="smAddItem('t2')">2-top</button>
                    <button class="btn btn-sm" onclick="smAddItem('t4')">4-top</button>
                    <button class="btn btn-sm" onclick="smAddItem('t6')">6-top</button>
                    <button class="btn btn-sm" onclick="smAddItem('bar')">Bar seats</button>
                    <button class="btn btn-sm btn-outline" onclick="smAddItem('stage')">${hasStage ? 'Select stage' : 'Stage'}</button>
                </div>${sel}`;
        }

        // ---------- GUEST LIST (table numbers + names, check people in one by one) ----------
        // Re-rendering on every live update must not eat what someone is typing.
        function smPreserve(container, fn) {
            const act = document.activeElement;
            const vals = {};
            container.querySelectorAll('input[id]:not([type=checkbox])').forEach(el => { vals[el.id] = el.value; });
            const focus = act && container.contains(act) && act.id ? { id: act.id, s: act.selectionStart, e: act.selectionEnd } : null;
            fn();
            Object.keys(vals).forEach(id => { const el = smEl(id); if (el && vals[id] !== '') el.value = vals[id]; });
            if (focus) { const el = smEl(focus.id); if (el) { el.focus(); try { el.setSelectionRange(focus.s, focus.e); } catch (err) { /* not a text input */ } } }
        }
        function smRenderSummary(show) {
            const gs = smGuests(show), total = gs.length, arr = gs.filter(g => g.arrived).length;
            const seats = smItems(show).filter(smIsSeat).reduce((n, i) => n + smCap(i), 0);
            const used = new Set(gs.map(g => g.tableId)).size;
            smEl('smSummary').innerHTML = `
                <div class="sm-sum-top"><div><span class="sm-sum-big">${arr}</span><span class="sm-sum-of"> / ${total} arrived</span></div><div class="sm-sum-sub">${total - arr} still to come</div></div>
                <div class="ev2-bar" style="height:7px; margin:8px 0 6px;"><i style="width:${total ? Math.round(arr / total * 100) : 0}%"></i></div>
                <div class="sm-sum-sub">${used} table${used === 1 ? '' : 's'} with guests · ${seats} seats in this layout</div>`;
        }
        function smRenderList(show) {
            smPreserve(smEl('smListBody'), () => {
                const items = smItems(show).filter(smIsSeat).sort((a, b) => ((a.type === 'bar') - (b.type === 'bar')) || smNatural(a.num, b.num));
                const { stats, unseated } = smTableStats(show);
                const byTable = {};
                smGuests(show).forEach(g => { (byTable[g.tableId] = byTable[g.tableId] || []).push(g); });
                const q = smFilter.q.trim().toLowerCase();
                const guestRow = g => {
                    const when = g.arrived && g.arrivedAt ? new Date(g.arrivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
                    return `<div class="sm-g${g.arrived ? ' here' : ''}">
                        <label class="sm-g-main"><input type="checkbox" ${g.arrived ? 'checked' : ''} onchange="smToggleArrived('${g.id}', this.checked)"><span class="nm">${escapeHtml(g.name)}</span>${when ? `<span class="tm">${when}</span>` : ''}</label>
                        <button class="sm-ib" title="Rename" onclick="smRenameGuest('${g.id}')">✎</button>
                        <button class="sm-ib" title="Move to another table" onclick="smMoveGuest('${g.id}')">⇄</button>
                        <button class="sm-ib danger" title="Remove" onclick="smRemoveGuest('${g.id}')">✕</button>
                    </div>`;
                };
                const visibleGuests = list => (list || []).filter(g => (!smFilter.pending || !g.arrived) && (!q || g.name.toLowerCase().includes(q))).sort((a, b) => smNatural(a.name, b.name));
                let html = '';
                if (unseated.length) {
                    const vg = visibleGuests(unseated);
                    if (vg.length) html += `<div class="sm-tcard warn"><div class="sm-tc-head"><b>Not seated</b><span class="sm-tc-type">table was removed</span></div>${vg.map(guestRow).join('')}<div class="sm-tc-note">Use ⇄ to move each person to a table.</div></div>`;
                }
                items.forEach(it => {
                    const st = stats[it.id], all = byTable[it.id] || [], vg = visibleGuests(all);
                    const nameHit = q && smItemName(it).toLowerCase().includes(q);
                    if (q && !vg.length && !nameHit) return;
                    if (!q && smFilter.pending && !vg.length && all.length) return; // everyone here already - nothing left to check off
                    if (!q && smFilter.hideEmpty && !all.length && it.id !== smSelId) return;
                    const cap = smCap(it), over = st.total > cap;
                    const done = st.total > 0 && st.arrived === st.total;
                    html += `<div class="sm-tcard${it.id === smSelId ? ' sel' : ''}${done ? ' done' : ''}${over ? ' over' : ''}" id="smT_${it.id}">
                        <div class="sm-tc-head" onclick="smSelectTable('${it.id}')">
                            <b>${escapeHtml(smItemName(it))}</b><span class="sm-tc-type">${it.type === 'bar' ? cap + ' bar seats' : SM_TYPES[it.type].label}</span>
                            <span class="sm-tc-count">${st.total ? `${st.arrived}/${st.total} here` : 'empty'}</span>
                            ${over ? `<span class="sm-tc-over">${st.total - cap} over</span>` : ''}
                        </div>
                        ${vg.map(guestRow).join('')}
                        <div class="sm-add"><input id="smAdd_${it.id}" class="input-field" placeholder="+ Add name (commas add several)" onkeydown="if(event.key==='Enter'){event.preventDefault();smAddGuests('${it.id}');}" autocomplete="off" data-1p-ignore><button class="btn btn-sm" onclick="smAddGuests('${it.id}')">Add</button></div>
                    </div>`;
                });
                smEl('smListBody').innerHTML = html || `<p style="color:var(--text-muted); text-align:center; padding:24px 8px; font-size:0.9rem;">${items.length ? 'Nothing matches that filter.' : 'No tables yet. Switch to “Edit layout” to add tables, or load a saved floorplan.'}</p>`;
            });
        }

        function smAddGuests(tableId) {
            const input = smEl('smAdd_' + tableId); if (!input) return;
            const names = input.value.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
            if (!names.length) return;
            const upd = {};
            names.forEach(n => { const id = smUid('g'); upd['guests.' + id] = { id, name: n.slice(0, 80), tableId, arrived: false, arrivedAt: null, addedAt: Date.now() }; });
            input.value = '';
            smWrite(smShowRef().update(upd));
        }
        function smToggleArrived(gid, on) {
            smWrite(smShowRef().update({ ['guests.' + gid + '.arrived']: !!on, ['guests.' + gid + '.arrivedAt']: on ? Date.now() : null }));
        }
        function smRenameGuest(gid) {
            const g = smGuests(smCurShow()).find(x => x.id === gid); if (!g) return;
            const name = prompt('Guest name:', g.name);
            if (name === null || !name.trim()) return;
            smWrite(smShowRef().update({ ['guests.' + gid + '.name']: name.trim().slice(0, 80) }));
        }
        function smMoveGuest(gid) {
            const show = smCurShow(); if (!show) return;
            const g = smGuests(show).find(x => x.id === gid); if (!g) return;
            const label = prompt(`Move ${g.name} to which table? Type the table number (for a bar section, type "bar 1").`);
            if (label === null || !label.trim()) return;
            const t = label.trim().toLowerCase();
            const seats = smItems(show).filter(smIsSeat);
            const target = seats.find(i => smItemName(i).toLowerCase() === t) || seats.find(i => i.type !== 'bar' && String(i.num).toLowerCase() === t.replace(/^table\s*/, ''));
            if (!target) { alert(`No table "${label.trim()}" in this layout.`); return; }
            smWrite(smShowRef().update({ ['guests.' + gid + '.tableId']: target.id }));
        }
        function smRemoveGuest(gid) {
            const g = smGuests(smCurShow()).find(x => x.id === gid); if (!g) return;
            if (!confirm(`Remove ${g.name} from the guest list?`)) return;
            smWrite(smShowRef().update({ ['guests.' + gid]: firebase.firestore.FieldValue.delete() }));
        }

        // ---------- VENUES TAB ----------
        function smAddVenue() {
            smEnsureListeners();
            const name = prompt('Venue name:');
            if (!name || !name.trim()) return;
            const v = { id: smUid('v'), name: name.trim(), address: '' };
            saveDoc('venues', v.id, v).catch(() => {});
        }
        function smRenameVenue(id) {
            const v = smVenues().find(x => x.id === id); if (!v) return;
            const name = prompt('Venue name:', v.name);
            if (!name || !name.trim()) return;
            smWrite(db.collection('venues').doc(id).update({ name: name.trim() }));
            // Shows keep a copy of the name for the tiles - keep those in step.
            smShows().filter(s => s.venueId === id).forEach(s => smWrite(db.collection('shows').doc(s.id).update({ venueName: name.trim() })));
        }
        function smVenueAddress(id) {
            const v = smVenues().find(x => x.id === id); if (!v) return;
            const a = prompt('Venue address:', v.address || '');
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
        function smRenamePlan(id) {
            const p = smPlans().find(x => x.id === id); if (!p) return;
            const name = prompt('Floorplan name:', p.name);
            if (!name || !name.trim()) return;
            smWrite(db.collection('floorplans').doc(id).update({ name: name.trim() }));
            smShows().filter(s => s.floorplanId === id).forEach(s => smWrite(db.collection('shows').doc(s.id).update({ floorplanName: name.trim() })));
        }
        function smDeletePlan(id) {
            const p = smPlans().find(x => x.id === id); if (!p) return;
            if (!confirm(`Delete the saved floorplan "${p.name}"? Shows already using it keep their own copy.`)) return;
            smWrite(db.collection('floorplans').doc(id).delete());
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
                        <div class="sm-venue-btns"><button class="btn btn-outline btn-sm" onclick="smRenameVenue('${v.id}')">Rename</button><button class="btn btn-outline btn-sm" onclick="smVenueAddress('${v.id}')">Address</button><button class="btn btn-sm btn-magenta" onclick="smDeleteVenue('${v.id}')">Delete</button></div>
                    </div>
                    <div class="sm-plans">${plans.map(p => {
                        const it = p.items || [], tables = it.filter(i => i.type === 't2' || i.type === 't4' || i.type === 't6'), barSeats = it.filter(i => i.type === 'bar').reduce((n, i) => n + (i.seats || 6), 0);
                        const seats = tables.reduce((n, i) => n + smCap(i), 0) + barSeats, st = it.find(i => i.type === 'stage');
                        return `<div class="sm-plan"><div style="min-width:0;"><b>${escapeHtml(p.name)}</b><span>${tables.length} tables${barSeats ? ' + ' + barSeats + ' bar seats' : ''} · ${seats} seats${st ? ' · ' + (st.shape === 'square' ? 'square stage' : st.shape === 'wide' ? 'standard stage' : 'runway') : ''}</span></div>
                            <div class="sm-venue-btns"><button class="btn btn-outline btn-sm" onclick="smRenamePlan('${p.id}')">Rename</button><button class="btn btn-sm btn-magenta" onclick="smDeletePlan('${p.id}')">Delete</button></div></div>`;
                    }).join('') || `<div class="sm-plan-empty">No saved floorplans yet. Open a show at this venue, lay out the room, then tap “Save as new”.</div>`}</div>
                </div>`;
            }).join('') || `<p style="color:var(--text-muted); text-align:center; padding:30px 10px;">No venues yet. Add one here, or pick “New venue…” when creating a show.</p>`;
        }
