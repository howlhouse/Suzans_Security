        /* EVENTS FEED — compact, glanceable tiles. Tapping one opens the full
           detail view (renderEventDetail) for briefing, roster, positions,
           chat, etc. - keeping this primary list short and easy to scan was
           the whole point, so nothing actionable (claiming a shift, reading
           the brief) lives here anymore; it's all one tap away. */
        // "Hide community events" filter: remembered per device so it sticks between visits.
        function getHideCommunity() {
            try { return localStorage.getItem('ss_hideCommunity') === '1'; } catch (err) { return false; }
        }
        function setHideCommunity(on) {
            try { localStorage.setItem('ss_hideCommunity', on ? '1' : '0'); } catch (err) { /* storage blocked - applies until reload */ window._hideCommunityFallback = on; }
            renderEvents();
        }
        // Quick filter above the feed: all / shifts with open spots / shifts the user is on.
        let eventsFilter = 'all';
        function setEventsFilter(f) { eventsFilter = f; renderEvents(); }

        function evDateParts(e) {
            const [y, m, d] = String(e.date || '').split('-').map(Number);
            const dt = new Date(y, (m || 1) - 1, d);
            if (!y || isNaN(dt.getTime())) return null;
            return { day: d, mon: dt.toLocaleDateString([], { month: 'short' }).toUpperCase(), wk: dt.toLocaleDateString([], { weekday: 'short' }).toUpperCase(), full: dt.toLocaleDateString([], { month: 'long', year: 'numeric' }).toUpperCase() };
        }
        // "When" heading each tile is grouped under.
        function evGroupLabel(e) {
            const until = -daysSinceEvent(e);
            if (!isFinite(until)) return 'UPCOMING';
            if (until < 0) return 'RECENT';
            if (until === 0) return 'TONIGHT';
            if (until === 1) return 'TOMORROW';
            if (until <= 6) return 'THIS WEEK';
            if (until <= 13) return 'NEXT WEEK';
            const p = evDateParts(e);
            return p ? p.full : 'LATER';
        }
        // --- IMAGE FIT ---
        // Flyers come in every shape. Wide, sharp photos fill the banner ("cover"); portrait/square
        // flyers and low-res images are shown whole over a blurred copy of themselves ("poster"),
        // with the title moved below so it never sits on top of the flyer's own text.
        // Natural sizes are remembered per URL so later renders pick the right mode immediately.
        const evImgInfo = {};
        // Size of a tile's banner (16:9, capped at 240px tall) given the feed width - mirrors the CSS grid.
        function evBox(listW) {
            const cols = Math.max(1, Math.floor((listW + 16) / (340 + 16)));
            const w = (listW - 16 * (cols - 1)) / cols - 2;
            return { w, h: Math.min(w * 9 / 16, 240) };
        }
        function evMode(url, boxW, boxH) {
            const d = evImgInfo[url];
            if (!d || !boxW || !boxH) return 'cover';
            const cardRatio = boxW / boxH, imgRatio = d.w / d.h;
            const upscale = Math.max(boxW / d.w, boxH / d.h);
            // poster when cropping would lose too much (portrait/square, or ultra-wide) or the image would be stretched a lot
            return (imgRatio < cardRatio * 0.75 || imgRatio > cardRatio * 1.6 || upscale > 1.4) ? 'poster' : 'cover';
        }
        function evSetMode(tile, mode) {
            const poster = mode === 'poster';
            if (tile.classList.contains('is-poster') === poster) return;
            tile.classList.toggle('is-poster', poster);
            const title = tile.querySelector('.ev2-name'), media = tile.querySelector('.ev2-media'), body = tile.querySelector('.ev2-body');
            if (title && media && body) { if (poster) body.insertBefore(title, body.firstChild); else media.appendChild(title); }
        }
        function evImgLoaded(img) {
            const tile = img.closest('.ev2'), media = img.closest('.ev2-media');
            if (!tile || !img.naturalWidth) return;
            evImgInfo[img.getAttribute('src')] = { w: img.naturalWidth, h: img.naturalHeight };
            const box = evBox(document.getElementById('userEventsFeedList').clientWidth);
            evSetMode(tile, evMode(img.getAttribute('src'), box.w, box.h));
        }
        function evCssUrl(u) { return encodeURI(String(u || '')).replace(/"/g, '%22').replace(/\(/g, '%28').replace(/\)/g, '%29'); }

        function renderEvents() {
            const hideCommunity = getHideCommunity() || !!window._hideCommunityFallback;
            const toggle = document.getElementById('hideCommunityToggle');
            if (toggle) toggle.checked = hideCommunity;
            const u = currUser();
            const all = getDB('events').filter(e => !e.archived && !e.hidden && !(hideCommunity && e.communityOnly)).sort((a, b) => new Date(a.date) - new Date(b.date));
            const mine = all.filter(e => (e.guards || []).includes(u?.name));
            const openTotal = all.reduce((n, e) => n + ((e.guards || []).includes(u?.name) ? 0 : eventOpenSlots(e)), 0);
            const summary = document.getElementById('evSummary');
            if (summary) summary.innerHTML = all.length ? `<strong style="color:var(--text-primary);">${all.length}</strong> shift${all.length === 1 ? '' : 's'} &middot; you're on <strong style="color:var(--neon-saguaro);">${mine.length}</strong> &middot; <strong style="color:var(--neon-teal);">${openTotal}</strong> open spot${openTotal === 1 ? '' : 's'}` : 'Venues, circuit parties &amp; community events';
            document.querySelectorAll('#evFilters .ev-chip').forEach(c => c.classList.toggle('active', c.dataset.f === eventsFilter));
            const evs = all.filter(e => eventsFilter === 'mine' ? (e.guards || []).includes(u?.name) : (eventsFilter === 'open' ? (!(e.guards || []).includes(u?.name) && eventOpenSlots(e) > 0) : true));

            const listEl = document.getElementById('userEventsFeedList');
            const boxW = listEl ? listEl.clientWidth : 0;
            let lastGroup = null, html = '';
            evs.forEach((e, i) => {
                const group = evGroupLabel(e);
                if (group !== lastGroup) {
                    lastGroup = group;
                    const n = evs.filter(x => evGroupLabel(x) === group).length;
                    html += `<div class="ev2-group">${escapeHtml(group)} <small>${n} shift${n === 1 ? '' : 's'}</small></div>`;
                }
                const open = eventOpenSlots(e), filled = (e.guards || []).length, total = filled + open;
                const isIn = (e.guards || []).includes(u?.name);
                const unread = (isIn || u?.isAdmin) ? unreadCount('evt_' + e.id) : 0;
                const st = isIn ? ['in', "✓ YOU'RE IN"] : open === 0 ? ['full', 'FILLED'] : open === 1 ? ['last', '1 SPOT LEFT'] : ['open', `${open} OPEN`];
                const dp = evDateParts(e);
                const hours = shiftHoursLabel(e);
                const box = evBox(boxW), mode = evMode(e.image, box.w, box.h);
                const titleHtml = `<h3 class="ev2-name">${escapeHtml(e.title)}</h3>`;
                const cls = ['ev2', 'event-tile', mode === 'poster' ? 'is-poster' : '', isIn ? 'is-in' : '', !isIn && open === 0 ? 'is-full' : '', e.communityOnly ? 'is-community' : '', group === 'TONIGHT' ? 'is-tonight' : ''].filter(Boolean).join(' ');
                html += `
                <div class="${cls}" style="animation-delay:${Math.min(i, 8) * 45}ms" role="button" tabindex="0" onclick="openEventDetail('${e.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openEventDetail('${e.id}');}">
                    <div class="ev2-in">
                        <div class="ev2-media">
                            <div class="ev2-bg" style="background-image:url(&quot;${escapeHtml(evCssUrl(e.image))}&quot;)"></div>
                            <img src="${escapeHtml(e.image || '')}" alt="" loading="lazy" onload="evImgLoaded(this)" onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=700'">
                            ${dp ? `<div class="ev2-date"><span class="w">${dp.wk}</span><span class="d">${dp.day}</span><span class="m">${dp.mon}</span></div>` : ''}
                            <div class="ev2-status ${st[0]}"><i></i>${st[1]}</div>
                            ${unread > 0 ? `<div class="ev2-chat">💬 ${unread} new</div>` : ''}
                            ${mode === 'poster' ? '' : titleHtml}
                        </div>
                        <div class="ev2-body">
                            ${mode === 'poster' ? titleHtml : ''}
                            <div class="ev2-meta"><span>🕘 ${escapeHtml(shiftTimeLabel(e))}${hours ? ' &middot; ' + escapeHtml(hours) : ''}</span><span class="go">View shift ›</span></div>
                            ${total > 0 ? `<div class="ev2-fill"><div class="ev2-bar"><i style="width:${Math.round(filled / total * 100)}%"></i></div><span>${filled} of ${total} filled</span></div>` : ''}
                            ${e.communityOnly ? `<div class="ev2-community">📋 Community listing only &mdash; not a contracted event</div>` : ''}
                            ${(e.tags || []).length ? `<div class="tags-container" style="margin:0;">${(e.tags || []).map(t => `<span class="neon-tag ${t === 'NSFW' || t === 'Kink' ? 'tag-nsfw' : 'tag-active'}">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                        </div>
                    </div>
                </div>`;
            });
            const empty = eventsFilter === 'mine' ? "You haven't claimed any shifts yet - tap All to find one." : eventsFilter === 'open' ? 'No shifts with open spots right now.' : (hideCommunity ? 'No shift postings match this filter — uncheck "Hide community events" to see everything.' : 'No shift postings right now — check back soon.');
            document.getElementById('userEventsFeedList').innerHTML = html || `<p style="color:var(--text-muted); text-align:center; padding:30px 10px;">${empty}</p>`;
        }

        function toggleSignUp(id, eEvent = null) {
            if (eEvent) eEvent.stopPropagation();
            let e = getDB('events').find(x => x.id === id), u = currUser();
            e.guards = e.guards || []; e.guardPosts = e.guardPosts || {};
            if (e.guards.includes(u.name)) {
                e.guards = e.guards.filter(g => g !== u.name);
                delete e.guardPosts[u.name];
                e.openSlots++;
                logAction('Dropped shift: ' + e.title, 'shift_drop', { eventId: e.id });
            } else {
                e.guards.push(u.name);
                e.guardPosts[u.name] = 'Unassigned';
                e.openSlots--;
                logAction('Claimed shift: ' + e.title, 'shift_claim', { eventId: e.id });
            }
            saveDoc('events', e.id, e);
        }

        // Position-aware claim/cancel/reassign for events with defined position types.
        function claimPosition(eventId, positionName) {
            const e = getDB('events').find(x => x.id === eventId);
            const u = currUser();
            if (!e || !u) return;
            e.guards = e.guards || []; e.guardPosts = e.guardPosts || {};
            const currentlyOnThis = e.guardPosts[u.name] === positionName;
            if (currentlyOnThis) {
                // Cancel this position
                e.guards = e.guards.filter(g => g !== u.name);
                delete e.guardPosts[u.name];
                logAction(`Dropped ${positionName} at ${e.title}`, 'shift_drop', { eventId: e.id, position: positionName });
            } else {
                const pos = (e.positions || []).find(p => p.name === positionName);
                if (pos && pos.allowedRoles && pos.allowedRoles.length && !pos.allowedRoles.includes(u.role)) {
                    alert(`${positionName} is restricted to: ${pos.allowedRoles.join(', ')}. Your rank (${u.role || 'none set'}) isn't eligible - check with Command if this needs updating.`);
                    return;
                }
                const filled = positionFilled(e, positionName);
                if (pos && filled >= pos.slots) { alert(`${positionName} is already full.`); return; }
                if (!e.guards.includes(u.name)) e.guards.push(u.name);
                e.guardPosts[u.name] = positionName;
                logAction(`Claimed ${positionName} at ${e.title}`, 'shift_claim', { eventId: e.id, position: positionName });
            }
            saveDoc('events', e.id, e);
        }

        /* EVENT DETAIL */
        let activeDetailId = null;
        function openEventDetail(id) {
            activeDetailId = id; switchView('eventDetail'); renderEventDetail(id);
            const ev = getDB('events').find(x => x.id === id);
            if (ev) logEvent('event_view', 'Viewed shift: ' + ev.title, { eventId: id });
        }

        function renderEventDetail(id) {
            const e = getDB('events').find(x => x.id === id);
            if (!e) { switchView('eventsFeed'); return; }
            const u = currUser();
            const linkedPromoters = getEventPromoterIds(e).map(id => getDB('promoters').find(p => p.id === id)).filter(Boolean);
            const isSignedUp = u && (e.guards || []).includes(u.name);
            const hasPositions = e.positions && e.positions.length;
            const myNote = u && e.guardNotes && e.guardNotes[u.name];
            // Shift rosters are private between the team working that shift -
            // only guards who've claimed a slot on this event (plus admins)
            // can see who else is on it. Everyone else just sees slot counts.
            const canSeeRoster = (u && u.isAdmin) || isSignedUp;

            // Rank restrictions on a position only gate who can CLAIM it (see
            // positionsHtml below) - once you're on the shift roster at all
            // (canSeeRoster), you see every teammate on it, rank restrictions
            // notwithstanding.
            let rosterHtml = !canSeeRoster ? '' : (e.guards || []).map(g => {
                const isMe = g === u?.name;
                const posLabel = (e.guardPosts && e.guardPosts[g]) || 'Unassigned';
                const positionCell = (!hasPositions && isMe)
                    ? `<select class="input-field" style="width:auto; margin:0; padding:6px 12px; font-weight:600;" onchange="updateGuardPost('${e.id}', '${g}', this.value)">
                            ${LEGACY_POST_OPTIONS.map(p => `<option value="${p}" ${posLabel === p ? 'selected' : ''}>${p}</option>`).join('')}
                       </select>`
                    : `<span style="color:var(--neon-teal); font-weight:600; font-size:0.85rem;">${posLabel}</span>`;
                return `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:10px 6px;">🛡️ ${g}${isMe ? ' <span style="color:var(--neon-pink); font-size:0.75rem;">(You)</span>' : ''}</td>
                    <td style="padding:10px 6px; text-align:right;">${positionCell}</td>
                </tr>`;
            }).join('') || '';

            const positionsHtml = hasPositions ? `
                <div style="margin: 20px 0;">
                    <h4 style="color:var(--neon-teal); font-size:0.85rem; font-weight:600; text-transform:uppercase; letter-spacing:0.8px; margin-bottom:10px;">Available Positions</h4>
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        ${e.positions.map(p => {
                            const filled = positionFilled(e, p.name);
                            const full = filled >= p.slots;
                            const onThis = u && (e.guardPosts || {})[u.name] === p.name;
                            const restricted = p.allowedRoles && p.allowedRoles.length;
                            const eligible = !restricted || onThis || (u && p.allowedRoles.includes(u.role));
                            // Rank-restricted positions are simply left off the
                            // list for anyone not eligible, rather than shown
                            // at all - guards should only ever see postings
                            // that are actually theirs to claim. Admins still
                            // see everything, for oversight: instead of a
                            // "Requires rank" notice, an admin who personally
                            // doesn't hold the required rank just gets a grey,
                            // disabled "Ineligible" button in place of Claim.
                            const visible = eligible || (u && u.isAdmin);
                            if (!visible) return '';
                            let btnLabel = onThis ? 'Cancel' : (full ? 'Full' : (eligible ? 'Claim' : 'Ineligible'));
                            return `<div style="display:flex; justify-content:space-between; align-items:center; background:rgba(12,12,18,0.7); border:1px solid var(--border-glass); border-radius:12px; padding:12px 16px;">
                                <div>
                                    <strong>${p.name}</strong>
                                    <span style="color:var(--text-muted); font-size:0.82rem; margin-left:8px;">${filled}/${p.slots} filled</span>
                                </div>
                                <button class="btn btn-sm ${onThis ? 'btn-magenta' : ''} ${!eligible && !onThis ? 'btn-outline' : ''}" onclick="claimPosition('${e.id}','${p.name}')" ${(full || !eligible) && !onThis ? 'disabled' : ''}>
                                    ${btnLabel}
                                </button>
                            </div>`;
                        }).join('') || '<p style="color:var(--text-muted); font-size:0.85rem;">No positions available to your rank for this shift yet.</p>'}
                    </div>
                </div>` : '';

            const timelineSorted = [...(e.timeline || [])].sort((a, b) => (a.time || '').localeCompare(b.time || ''));

            document.getElementById('eventDetailContent').innerHTML = `
                <div class="glass-card">
                    ${e.communityOnly ? `<div class="community-banner" style="border-radius:16px 16px 0 0;">📋 Community Listing Only — Not a Contracted Event</div>` : ''}
                    <div class="event-img-wrap event-detail-img-wrap">
                        <img src="${e.image}" class="event-img event-detail-img" onerror="this.src='https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=700'">
                        <div class="date-badge">🗓️ ${e.date}</div>
                    </div>
                    <div class="event-body">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:8px;">
                            <h2 style="font-family:'Outfit'; font-size:1.6rem; font-weight:700; margin:0;">${e.title}</h2>
                            <div class="cal-menu-wrap" id="calMenuWrap" style="position:relative; flex-shrink:0;">
                                <button class="btn btn-outline btn-sm" style="white-space:nowrap;" onclick="toggleCalMenu(event)">📅 Add to Calendar</button>
                                <div class="user-menu-dropdown" id="calMenuDropdown" style="display:none; right:0;">
                                    <button class="user-menu-item" onclick="closeCalMenu(); addToGoogleCalendar('${e.id}')"><span>🟢</span><span>Google Calendar</span></button>
                                    <button class="user-menu-item" onclick="closeCalMenu(); addToAppleOutlookCalendar('${e.id}')"><span>🍎</span><span>Apple / Outlook (.ics)</span></button>
                                </div>
                            </div>
                        </div>
                        <div class="tags-container">
                            ${(e.tags || []).map(t => `<span class="neon-tag ${t === 'NSFW' || t === 'Kink' ? 'tag-nsfw' : 'tag-active'}">${t}</span>`).join('')}
                        </div>
                        ${e.ticketLink ? `<a href="${e.ticketLink}" target="_blank" class="btn btn-outline" style="width:100%; text-decoration:none; margin:10px 0 16px;">🎟️ Event Tickets / Portal</a>` : ''}

                        ${myNote ? `
                        <div style="background:rgba(255,42,133,0.1); border:1px solid rgba(255,42,133,0.4); border-radius:12px; padding:14px; margin: 16px 0;">
                            <h4 style="color:var(--neon-pink); font-size:0.75rem; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">📝 Note for you from Command</h4>
                            <p style="font-size:0.9rem; color:var(--text-primary);">${myNote}</p>
                        </div>` : ''}

                        <div style="margin: 16px 0;">
                            <h4 style="color:var(--neon-teal); font-size:0.85rem; font-weight:600; text-transform:uppercase; letter-spacing:0.8px; margin-bottom:6px;">Operational Brief</h4>
                            <p style="font-size:0.95rem; line-height:1.5; color:var(--text-secondary);">${e.desc || 'No brief provided.'}</p>
                        </div>

                        ${e.address ? `
                        <div style="margin: 16px 0;">
                            <h4 style="color:var(--neon-teal); font-size:0.85rem; font-weight:600; text-transform:uppercase; letter-spacing:0.8px; margin-bottom:6px;">Location</h4>
                            <p style="font-size:0.95rem; color:var(--text-secondary);">${e.address}</p>
                            <a href="https://maps.google.com/?q=${encodeURIComponent(e.address)}" target="_blank" class="btn btn-outline btn-sm" style="margin-top:8px; text-decoration:none; display:inline-block;">📍 Get Directions</a>
                        </div>` : ''}

                        ${timelineSorted.length ? `
                        <div style="margin: 16px 0;">
                            <h4 style="color:var(--neon-teal); font-size:0.85rem; font-weight:600; text-transform:uppercase; letter-spacing:0.8px; margin-bottom:8px;">Shift Timeline</h4>
                            <div style="background:rgba(12,12,18,0.7); border:1px solid var(--border-glass); border-radius:12px; padding:6px 16px;">
                                ${timelineSorted.map(t => `<div style="display:flex; gap:12px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.05);"><strong style="color:var(--neon-teal); min-width:64px;">${t.time || '--:--'}</strong><span style="font-size:0.9rem;">${t.label || ''}</span></div>`).join('')}
                            </div>
                        </div>` : ''}

                        ${linkedPromoters.length ? `
                        <div style="background:rgba(255,255,255,0.04); border:1px solid var(--border-glass); border-radius:12px; padding:14px; margin: 16px 0;">
                            <h4 style="color:var(--neon-teal); font-size:0.8rem; font-weight:600; text-transform:uppercase; margin-bottom:8px;">Client / Producer Detail</h4>
                            ${linkedPromoters.map((promoter, i) => `
                            <div style="${i > 0 ? 'margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.06);' : ''}">
                                <p style="font-weight:600;">${promoter.name}</p>
                                <p style="font-size:0.85rem; color:var(--text-muted);">📞 ${promoter.phone} • ✉️ ${promoter.email}</p>
                            </div>`).join('')}
                        </div>` : ''}

                        ${positionsHtml}

                        <div style="margin: 20px 0;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                                <h4 style="color:var(--neon-teal); font-size:0.85rem; font-weight:600; text-transform:uppercase; letter-spacing:0.8px;">Signed-Up Team (${eventOpenSlots(e)} Slots Open)</h4>
                                ${!hasPositions ? `<button class="btn btn-sm ${isSignedUp ? 'btn-magenta' : ''}" onclick="toggleSignUp('${e.id}')" ${eventOpenSlots(e) === 0 && !isSignedUp ? 'disabled' : ''}>
                                    ${isSignedUp ? 'Cancel Shift' : (eventOpenSlots(e) === 0 ? 'Full' : 'Claim Shift')}
                                </button>` : ''}
                            </div>
                            <div style="background:rgba(12,12,18,0.7); border:1px solid var(--border-glass); border-radius:12px; padding:6px 16px;">
                                ${rosterHtml ? `<table style="width:100%; border-collapse:collapse; font-size:0.9rem;"><tbody>${rosterHtml}</tbody></table>` : (!canSeeRoster && (e.guards || []).length ? '<p style="color:var(--text-muted); font-size:0.85rem; padding:10px 0;">🔒 Sign up for this shift to see your team.</p>' : '<p style="color:var(--text-muted); font-size:0.85rem; padding:10px 0;">No officers assigned yet.</p>')}
                            </div>
                        </div>

                        ${canSeeRoster ? `
                        <div style="margin-top: 24px;">
                            <h4 style="color:var(--neon-teal); font-size:0.85rem; font-weight:600; text-transform:uppercase; letter-spacing:0.8px; margin-bottom:8px;">Live Shift Comms</h4>
                            <div id="detailChatBox" style="height:220px; overflow-y:auto; background:rgba(12,12,18,0.6); border:1px solid var(--border-glass); border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:8px; margin-bottom:10px;"></div>
                            <div style="display:flex; gap:8px;">
                                <input type="text" id="detailChatInput" class="input-field" placeholder="Transmit shift update..." style="margin:0;" data-1p-ignore>
                                <button class="btn btn-sm" onclick="sendDetailChat('${e.id}')">Send</button>
                            </div>
                        </div>` : ''}
                    </div>
                </div>
            `;
            if (canSeeRoster) renderDetailChat(e.id);
        }

        function updateGuardPost(eventId, guardName, postVal) {
            let e = getDB('events').find(x => x.id === eventId);
            if (e) {
                if (!e.guardPosts) e.guardPosts = {};
                e.guardPosts[guardName] = postVal;
                saveDoc('events', e.id, e);
                logAction(`Assigned ${guardName} to post [${postVal}] at ${e.title}`);
            }
        }

        function renderDetailChat(eventId) {
            const chanName = 'evt_' + eventId;
            const msgs = getDB('chats').filter(c => c.channel === chanName).sort((a, b) => a.id.localeCompare(b.id));
            const box = document.getElementById('detailChatBox');
            if (!box) return;
            box.innerHTML = msgs.map(c => `
                <div style="background:rgba(255,255,255,0.06); padding:8px 12px; border-radius:10px; font-size:0.85rem;">
                    <div style="color:var(--neon-teal); font-size:0.75rem; font-weight:600;">${c.user}</div>
                    <div>${c.text}</div>
                </div>
            `).join('') || '<p style="color:var(--text-muted); font-size:0.8rem; text-align:center; margin:auto;">No shift messages logged yet.</p>';
            box.scrollTop = box.scrollHeight;
            markChannelRead(chanName);
        }

        function sendDetailChat(eventId) {
            const input = document.getElementById('detailChatInput');
            const v = input.value.trim();
            if (v) {
                const cm = { id: 'm' + Date.now(), channel: 'evt_' + eventId, user: currUser().name, text: v, file: null };
                saveDoc('chats', cm.id, cm);
                input.value = '';
            }
        }

