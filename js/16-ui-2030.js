        // ============ UI 2030 LAYER (pairs with ui-2030.css) ============
        // Presentation only. Nothing here reads or writes app data, and no existing function is
        // replaced or wrapped: every action below works by clicking the same buttons a person would,
        // so permissions, the PIN gate and the module switch all behave exactly as they always have.
        //   - line icons in the dock / header (swapped in for the emoji)
        //   - a sliding indicator behind the dock's active tab
        //   - an initial avatar in the name pill
        //   - a soft light that follows the pointer across cards
        //   - Quick Find (Ctrl/Cmd + K, or the magnifier): jump to any screen, menu item or shift
        //   - scrolling tab strips (Command Center): edge fades, wheel scrolls sideways, the open tab stays in view
        // Top-level statements only register DOM listeners/observers (see docs/FILE_GUIDE.md load-order rules).
        (function ui2030() {
            const svg = (body) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
            const ICONS = {
                events: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 11v2M13 17v2"/>',
                calendar: '<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/>',
                comms: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
                ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
                scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
                admin: '<rect x="3" y="11" width="18" height="11" rx="3"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
                dash: '<path d="M3 3v16a2 2 0 0 0 2 2h16M8 16v-5M13 16V8M18 16v-3"/>',
                shows: '<path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z"/>',
                venues: '<path d="M20 10c0 5-8 12-8 12s-8-7-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
                plus: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/>',
                search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
                info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
            };
            const $ = (id) => document.getElementById(id);
            const signedIn = () => { try { return !!currUser(); } catch (e) { return false; } };

            // ---- Dock + header icons (emoji text node -> inline SVG; badges and ids are left alone) ----
            function dockIconFor(btn) {
                const v = btn.dataset.view, t = btn.dataset.smtab, oc = btn.getAttribute('onclick') || '';
                if (v === 'eventsFeed') return 'events'; if (v === 'calendarView') return 'calendar'; if (v === 'teamChatView') return 'comms';
                if (v === 'banListView') return 'ban'; if (v === 'adminConsoleView') return 'admin'; if (v === 'dashboardView') return 'dash';
                if (btn.id === 'dockIdScanBtn') return 'scan'; if (t === 'shows') return 'shows'; if (t === 'venues') return 'venues';
                if (oc.includes('smOpenShowModal')) return 'plus';
                return null;
            }
            function swapIcons() {
                document.querySelectorAll('.dock-nav .dock-item').forEach(btn => {
                    const name = dockIconFor(btn), holder = btn.firstElementChild;
                    if (!name || !holder || holder.querySelector('svg')) return;
                    const txt = [...holder.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
                    if (!txt) return;
                    const tmp = document.createElement('span'); tmp.innerHTML = svg(ICONS[name]);
                    holder.replaceChild(tmp.firstChild, txt);
                });
                const info = document.querySelector('header button[onclick*="aboutModal"]');
                if (info && !info.querySelector('svg')) {
                    info.className = 'ui-icon-btn'; info.removeAttribute('style'); info.setAttribute('aria-label', 'Info and help'); info.title = 'Info & help';
                    info.innerHTML = svg(ICONS.info);
                }
            }

            // ---- Sliding indicator behind the active dock tab ----
            function placeIndicator(nav) {
                let ind = nav.querySelector('.ui-dock-ind');
                if (!ind) { ind = document.createElement('i'); ind.className = 'ui-dock-ind'; ind.setAttribute('aria-hidden', 'true'); nav.appendChild(ind); nav.classList.add('ui-ind'); }
                const a = nav.querySelector('.dock-item.active');
                if (!a || !a.offsetWidth) { ind.classList.remove('on'); return; }
                ind.style.width = a.offsetWidth + 'px'; ind.style.height = a.offsetHeight + 'px';
                ind.style.transform = `translate(${a.offsetLeft}px, ${a.offsetTop}px)`;
                ind.classList.add('on');
            }
            let indQueued = false;
            function queueIndicators() {
                if (indQueued) return; indQueued = true;
                // Next frame normally; the timer covers a backgrounded tab, where frames are paused.
                const go = () => { if (!indQueued) return; indQueued = false; document.querySelectorAll('.dock-nav').forEach(placeIndicator); };
                requestAnimationFrame(go); setTimeout(go, 80);
            }

            // ---- Name pill avatar + signed-in flag ----
            function syncIdentity() {
                const on = signedIn();
                if (document.body.classList.contains('ui-signed-in') !== on) document.body.classList.toggle('ui-signed-in', on);
                const pill = $('userPill'), g = $('userGreeting'); if (!pill || !g) return;
                const av = pill.firstElementChild; if (!av || av === g) return;
                const initial = (g.textContent || '').trim().charAt(0).toUpperCase();
                if (on && initial) { if (av.textContent !== initial) av.textContent = initial; av.classList.add('ui-avatar'); }
            }

            // ---- Quick Find ----
            let palOpen = false, palItems = [], palSel = 0, palReturnFocus = null;
            function buildPalette() {
                if ($('uiPalette')) return;
                const wrap = document.createElement('div');
                wrap.id = 'uiPalette'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', 'Quick Find');
                wrap.innerHTML = `<div class="ui-pal"><div class="ui-pal-top">${svg(ICONS.search)}<input id="uiPalInput" type="text" placeholder="Jump to a screen or a shift…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-controls="uiPalList"><kbd>esc</kbd></div><div id="uiPalList" role="listbox"></div><div class="ui-pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span></div></div>`;
                document.body.appendChild(wrap);
                wrap.addEventListener('pointerdown', e => { if (e.target === wrap) closePalette(); });
                $('uiPalInput').addEventListener('input', renderPalette);
                $('uiPalList').addEventListener('click', e => { const b = e.target.closest('.ui-pal-item'); if (b) runPalette(+b.dataset.i); });
                $('uiPalList').addEventListener('pointermove', e => { const b = e.target.closest('.ui-pal-item'); if (b && +b.dataset.i !== palSel) { palSel = +b.dataset.i; markSel(false); } });
            }
            const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
            const shown = (el) => getComputedStyle(el).display !== 'none';
            function collectPalette() {
                const out = [];
                // Screens: whatever dock this person can currently see (so Admin / Dashboard only appear for those users).
                document.querySelectorAll('.dock-nav').forEach(nav => {
                    if (!shown(nav)) return;
                    nav.querySelectorAll('.dock-item').forEach(btn => {
                        if (!shown(btn)) return;
                        const label = (btn.lastElementChild?.textContent || '').trim(), ic = btn.querySelector('svg.ic');
                        if (label) out.push({ group: 'Go to', label, icon: ic ? ic.outerHTML : '', run: () => btn.click() });
                    });
                });
                // Everything in the name menu that is visible for the current module.
                document.querySelectorAll('#userMenuDropdown .user-menu-item').forEach(btn => {
                    if (!shown(btn) || btn.dataset.uiFind) return;
                    const spans = btn.querySelectorAll('span'); if (spans.length < 2) return;
                    const isModule = btn.id === 'modItemSecurity' || btn.id === 'modItemShows';
                    out.push({ group: isModule ? 'Module' : 'Menu', label: spans[1].textContent.trim(), icon: esc(spans[0].textContent.trim()), hint: isModule && btn.classList.contains('mod-current') ? 'current' : '', run: () => btn.click() });
                });
                const info = document.querySelector('header button[onclick*="aboutModal"]');
                if (info) out.push({ group: 'Menu', label: 'Info & help', icon: svg(ICONS.info), run: () => info.click() });
                // Shifts: the same ones the Events feed lists, opened the same way a tile does.
                try {
                    getDB('events').filter(e => !e.archived && !e.hidden).sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(e => {
                        let when = ''; try { const d = new Date(e.date + 'T12:00:00'); if (!isNaN(d)) when = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch (x) { /* no date */ }
                        out.push({ group: 'Shifts', label: e.title || 'Untitled shift', icon: svg(ICONS.events), hint: when, run: () => openEventDetail(e.id) });
                    });
                } catch (x) { /* data not loaded yet */ }
                return out;
            }
            function renderPalette() {
                const q = ($('uiPalInput').value || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
                const all = collectPalette();
                palItems = all.filter(it => { const hay = (it.label + ' ' + it.group + ' ' + (it.hint || '')).toLowerCase(); return q.every(t => hay.includes(t)); });
                if (!q.length) { let n = 0; palItems = palItems.filter(it => it.group !== 'Shifts' || n++ < 5); }
                palSel = 0;
                let html = '', last = null;
                palItems.forEach((it, i) => {
                    if (it.group !== last) { last = it.group; html += `<div class="ui-pal-group">${esc(it.group)}</div>`; }
                    html += `<button type="button" class="ui-pal-item" role="option" data-i="${i}"><span class="ui-pal-ic">${it.icon || ''}</span><span class="ui-pal-txt">${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`;
                });
                $('uiPalList').innerHTML = html || '<div class="ui-pal-empty">Nothing matches that.</div>';
                markSel(false);
            }
            function markSel(scroll) {
                $('uiPalList').querySelectorAll('.ui-pal-item').forEach(b => { const on = +b.dataset.i === palSel; b.classList.toggle('sel', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); if (on && scroll) b.scrollIntoView({ block: 'nearest' }); });
            }
            function runPalette(i) { const it = palItems[i]; if (!it) return; closePalette(); it.run(); }
            function openPalette() {
                if (palOpen || !signedIn() || ($('tourLayer') && shown($('tourLayer')))) return;
                // Stay out of the way of any open dialog (sign-in, PIN, scanner, editors...).
                if ([...document.querySelectorAll('.modal')].some(m => shown(m))) return;
                buildPalette();
                if (typeof closeUserMenu === 'function') closeUserMenu();
                palReturnFocus = document.activeElement;
                palOpen = true; $('uiPalette').classList.add('open');
                const inp = $('uiPalInput'); inp.value = ''; renderPalette(); inp.focus();
            }
            function closePalette() {
                if (!palOpen) return; palOpen = false; $('uiPalette').classList.remove('open');
                if (palReturnFocus && palReturnFocus.focus) { try { palReturnFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
            }
            function addFindTriggers() {
                const info = document.querySelector('header button[onclick*="aboutModal"]');
                if (info && !$('uiFindBtn')) {
                    const b = document.createElement('button');
                    b.id = 'uiFindBtn'; b.type = 'button'; b.className = 'ui-icon-btn'; b.title = 'Quick Find'; b.setAttribute('aria-label', 'Quick Find'); b.innerHTML = svg(ICONS.search);
                    b.addEventListener('click', openPalette);
                    info.parentNode.insertBefore(b, info);
                }
                // Same thing in the name menu, so it is reachable on phones where the header has no room for it.
                const dd = $('userMenuDropdown'), sep = dd && dd.querySelector('.user-menu-sep');
                if (dd && sep && !dd.querySelector('[data-ui-find]')) {
                    const m = document.createElement('button');
                    m.className = 'user-menu-item'; m.type = 'button'; m.dataset.uiFind = '1';
                    m.innerHTML = '<span>🔎</span><span>Quick Find</span>';
                    m.addEventListener('click', () => { closeUserMenu(); openPalette(); });
                    sep.parentNode.insertBefore(m, sep.nextSibling);
                }
            }

            // ---- Pointer-following light on cards (mouse / trackpad only) ----
            let spotEl = null, spotX = 0, spotY = 0, spotQueued = false;
            function onPointerMove(e) {
                if (e.pointerType && e.pointerType !== 'mouse') return;
                const el = e.target.closest ? e.target.closest('.glass-card, .ev2') : null; if (!el) return;
                spotEl = el; spotX = e.clientX; spotY = e.clientY;
                if (spotQueued) return; spotQueued = true;
                requestAnimationFrame(() => {
                    spotQueued = false; if (!spotEl || !spotEl.isConnected) return;
                    const r = spotEl.getBoundingClientRect();
                    spotEl.style.setProperty('--mx', (spotX - r.left) + 'px'); spotEl.style.setProperty('--my', (spotY - r.top) + 'px');
                });
            }

            // ---- Scrolling tab strips (Command Center has ten tabs): fade the edge that has more, wheel scrolls sideways, the open tab stays in view ----
            function stripFades(ctl) {
                const more = ctl.scrollWidth - ctl.clientWidth > 2;
                const l = more && ctl.scrollLeft > 4, r = more && ctl.scrollLeft < ctl.scrollWidth - ctl.clientWidth - 4;
                if (ctl.classList.contains('ui-more-l') !== l) ctl.classList.toggle('ui-more-l', l);
                if (ctl.classList.contains('ui-more-r') !== r) ctl.classList.toggle('ui-more-r', r);
            }
            function stripReveal(ctl, smooth) {
                const a = ctl.querySelector('.segment-btn.active, .segment-btn.active-mode');
                if (a && ctl.scrollWidth > ctl.clientWidth) ctl.scrollTo({ left: a.offsetLeft - (ctl.clientWidth - a.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'auto' });
                stripFades(ctl);
            }
            function initStrips() {
                document.querySelectorAll('.segmented-control').forEach(ctl => {
                    ctl.addEventListener('scroll', () => stripFades(ctl), { passive: true });
                    ctl.addEventListener('wheel', e => {
                        if (ctl.scrollWidth <= ctl.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
                        const before = ctl.scrollLeft; ctl.scrollLeft += e.deltaY;
                        if (ctl.scrollLeft !== before) e.preventDefault(); // at either end the page scrolls as usual
                    }, { passive: false });
                    ctl.addEventListener('click', e => { if (e.target.closest('.segment-btn')) setTimeout(() => stripReveal(ctl, true), 0); });
                    if (window.ResizeObserver) new ResizeObserver(() => stripReveal(ctl, false)).observe(ctl); // also fires when its screen is first shown
                    stripFades(ctl);
                });
            }
            // The header's real height, for things that stick just beneath it.
            function trackHeader() {
                const h = document.querySelector('header'); if (!h) return;
                const set = () => { if (h.offsetHeight) document.documentElement.style.setProperty('--hdr-h', h.offsetHeight + 'px'); };
                set(); if (window.ResizeObserver) new ResizeObserver(set).observe(h); else window.addEventListener('resize', set);
            }

            // ---- Wire up ----
            initStrips(); trackHeader();
            swapIcons(); addFindTriggers(); syncIdentity(); queueIndicators();
            const dockObs = new MutationObserver(muts => { if (muts.some(m => m.target.classList && m.target.classList.contains('dock-item'))) queueIndicators(); });
            document.querySelectorAll('.dock-nav').forEach(nav => dockObs.observe(nav, { attributes: true, attributeFilter: ['class', 'style'], subtree: true }));
            new MutationObserver(queueIndicators).observe(document.body, { attributes: true, attributeFilter: ['class'] }); // module switch swaps docks
            const idObs = new MutationObserver(syncIdentity);
            if ($('userGreeting')) idObs.observe($('userGreeting'), { childList: true, characterData: true, subtree: true });
            if ($('authModal')) idObs.observe($('authModal'), { attributes: true, attributeFilter: ['style'] });
            window.addEventListener('resize', queueIndicators);
            if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueIndicators);
            window.addEventListener('scroll', () => { const s = window.scrollY > 8; if (document.body.classList.contains('ui-scrolled') !== s) document.body.classList.toggle('ui-scrolled', s); }, { passive: true });
            if (window.matchMedia && window.matchMedia('(hover: hover)').matches) document.addEventListener('pointermove', onPointerMove, { passive: true });
            document.addEventListener('keydown', e => {
                if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); palOpen ? closePalette() : openPalette(); return; }
                if (!palOpen) return;
                if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); if (palItems.length) { palSel = (palSel + 1) % palItems.length; markSel(true); } }
                else if (e.key === 'ArrowUp') { e.preventDefault(); if (palItems.length) { palSel = (palSel - 1 + palItems.length) % palItems.length; markSel(true); } }
                else if (e.key === 'Enter') { e.preventDefault(); runPalette(palSel); }
            });
        })();
