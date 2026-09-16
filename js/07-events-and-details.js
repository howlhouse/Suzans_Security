        /* EVENTS FEED — compact, glanceable tiles. Tapping one opens the full
           detail view (renderEventDetail) for briefing, roster, positions,
           chat, etc. - keeping this primary list short and easy to scan was
           the whole point, so nothing actionable (claiming a shift, reading
           the brief) lives here anymore; it's all one tap away. */
        function renderEvents() {
            const evs = getDB('events').filter(e => !e.archived && !e.hidden).sort((a, b) => new Date(a.date) - new Date(b.date));
            const u = currUser();
            document.getElementById('userEventsFeedList').innerHTML = evs.map(e => {
                const openSlots = eventOpenSlots(e);
                const isSignedUp = (e.guards || []).includes(u?.name);
                const evtChan = 'evt_' + e.id;
                const unreadChat = (isSignedUp || u?.isAdmin) ? unreadCount(evtChan) : 0;
                const statusText = isSignedUp
                    ? `<span style="color:var(--neon-saguaro); font-weight:600;">✓ You're In</span>`
                    : (openSlots === 0 ? 'Filled' : `${openSlots} Open`);
                return `
                <div class="glass-card event-tile" onclick="openEventDetail('${e.id}')">
                    ${e.communityOnly ? `<div class="community-banner">📋 Community Listing Only — Not a Contracted Event</div>` : ''}
                    ${unreadChat > 0 ? `<div class="new-msg-banner">💬 ${unreadChat} new message${unreadChat > 1 ? 's' : ''} in shift chat</div>` : ''}
                    <div style="display:flex; gap:14px; align-items:center; padding:14px 16px;">
                        <div class="event-img-wrap" style="width:68px; height:68px; flex-shrink:0; border-radius:14px;">
                            <img src="${e.image}" class="event-img" style="height:100%; object-fit:cover;" onerror="this.src='https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=700'">
                        </div>
                        <div style="flex:1; min-width:0;">
                            <h3 style="font-family:'Outfit',sans-serif; font-size:1.05rem; font-weight:700; margin:0 0 4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${e.title}</h3>
                            <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:8px;">🗓️ ${e.date}${e.startTime ? ' · ' + e.startTime : ''} · ${statusText}</div>
                            <div class="tags-container" style="margin:0;">
                                ${(e.tags || []).map(t => `<span class="neon-tag ${t === 'NSFW' || t === 'Kink' ? 'tag-nsfw' : 'tag-active'}">${t}</span>`).join('')}
                            </div>
                        </div>
                        <span style="color:var(--text-muted); font-size:1.3rem; flex-shrink:0;">›</span>
                    </div>
                </div>
            `; }).join('') || `<p style="color:var(--text-muted); text-align:center; padding:30px 10px;">No shift postings right now — check back soon.</p>`;
        }

        function toggleSignUp(id, eEvent = null) {
            if (eEvent) eEvent.stopPropagation();
            let e = getDB('events').find(x => x.id === id), u = currUser();
            e.guards = e.guards || []; e.guardPosts = e.guardPosts || {};
            if (e.guards.includes(u.name)) {
                e.guards = e.guards.filter(g => g !== u.name);
                delete e.guardPosts[u.name];
                e.openSlots++;
                logAction('Dropped shift: ' + e.title);
            } else {
                e.guards.push(u.name);
                e.guardPosts[u.name] = 'Unassigned';
                e.openSlots--;
                logAction('Claimed shift: ' + e.title);
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
                logAction(`Dropped ${positionName} at ${e.title}`);
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
                logAction(`Claimed ${positionName} at ${e.title}`);
            }
            saveDoc('events', e.id, e);
        }

        /* EVENT DETAIL */
        let activeDetailId = null;
        function openEventDetail(id) { activeDetailId = id; switchView('eventDetail'); renderEventDetail(id); }

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
                    <div class="event-img-wrap" style="height:240px;">
                        <img src="${e.image}" class="event-img" style="height:100%; object-fit:cover;" onerror="this.src='https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=700'">
                        <div class="event-img-overlay"></div>
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

