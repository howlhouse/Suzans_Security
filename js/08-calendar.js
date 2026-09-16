        /* CALENDAR */
        let calD = new Date(2026, 8, 1);
        function changeMonth(d) { calD.setMonth(calD.getMonth() + d); renderCal(); }
        function renderCal() {
            document.getElementById('calMonthText').innerText = calD.toLocaleString('default', { month: 'long', year: 'numeric' });
            const grid = document.getElementById('calGrid'); grid.innerHTML = '';
            const evs = getDB('events').filter(e => !e.archived && !e.hidden), days = new Date(calD.getFullYear(), calD.getMonth() + 1, 0).getDate(), first = new Date(calD.getFullYear(), calD.getMonth(), 1).getDay();
            ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => grid.innerHTML += `<div class="cal-head">${d}</div>`);
            for (let i = 0; i < first; i++) grid.innerHTML += `<div class="cal-day" style="background:transparent; border-color:transparent; cursor:default;"></div>`;
            for (let i = 1; i <= days; i++) {
                const dateStr = `${calD.getFullYear()}-${String(calD.getMonth() + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
                const dayEvs = evs.filter(e => e.date === dateStr);
                grid.innerHTML += `<div class="cal-day">
                    <span>${i}</span>
                    <div>${dayEvs.map(e => `<div class="cal-badge" onclick="event.stopPropagation(); openEventDetail('${e.id}')">${e.title}</div>`).join('')}</div>
                </div>`;
            }
        }

