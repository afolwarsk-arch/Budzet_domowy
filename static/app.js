// ── shared helpers ──────────────────────────────────────────────

function fmt(zl) {
  return Number(zl).toLocaleString('pl-PL', { style: 'currency', currency: 'PLN' });
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/'/g, '&#39;');
}

// ── DASHBOARD ────────────────────────────────────────────────────

if (document.getElementById('chart-kategorie')) { authRequireHousehold().then(async (me) => {
  await loadOsobaOptions('filter-osoba', true);
  let chartKat = null;
  let chartMies = null;
  let miesiaceLacznie = false;
  let lastMiesData = null;
  let lastMiesKat = null;

  const monthInput = document.getElementById('filter-month');
  const osobaSelect = document.getElementById('filter-osoba');
  const katSelect = document.getElementById('filter-kategoria');
  const odInput = document.getElementById('filter-od');
  const doInput = document.getElementById('filter-do');
  monthInput.value = currentMonth();
  let filterMode = 'month';
  let katMode = 'pierwotne';

  window.setKatMode = function(mode) {
    katMode = mode;
    document.getElementById('kat-mode-pierwotne').style.background = mode === 'pierwotne' ? '#4f7ef8' : '#fff';
    document.getElementById('kat-mode-pierwotne').style.color = mode === 'pierwotne' ? '#fff' : '#555';
    document.getElementById('kat-mode-kontekst').style.background = mode === 'kontekst' ? '#4f7ef8' : '#fff';
    document.getElementById('kat-mode-kontekst').style.color = mode === 'kontekst' ? '#fff' : '#555';
    loadDashboard();
  };

  window.setFilterMode = function(mode) {
    filterMode = mode;
    document.getElementById('filter-month-wrap').style.display = mode === 'month' ? '' : 'none';
    document.getElementById('filter-range-wrap').style.display = mode === 'range' ? 'flex' : 'none';
    document.getElementById('mode-month').style.background = mode === 'month' ? '#4f7ef8' : '#fff';
    document.getElementById('mode-month').style.color = mode === 'month' ? '#fff' : '#555';
    document.getElementById('mode-range').style.background = mode === 'range' ? '#4f7ef8' : '#fff';
    document.getElementById('mode-range').style.color = mode === 'range' ? '#fff' : '#555';
    loadDashboard();
  };

  // Załaduj kategorie dynamicznie z backendu
  authFetch('/api/kategorie').then(r => r.json()).then(hier => {
    const current = katSelect.value;
    katSelect.innerHTML = '<option value="">Wszystkie</option>' +
      Object.keys(hier).map(k => `<option value="${esc(k)}" ${k === current ? 'selected' : ''}>${esc(k)}</option>`).join('');
  });

  async function loadDashboard() {
    const osoba = osobaSelect.value;
    const kategoria = katSelect.value;
    const q = new URLSearchParams();
    if (filterMode === 'range') {
      if (odInput.value) q.set('od', odInput.value);
      if (doInput.value) q.set('do', doInput.value);
    } else {
      const month = monthInput.value;
      if (month) q.set('month', month);
    }
    if (osoba) q.set('osoba', osoba);
    if (kategoria) q.set('kategoria', kategoria);

    const qMies = new URLSearchParams();
    if (osoba) qMies.set('osoba', osoba);
    if (kategoria) qMies.set('kategoria', kategoria);
    qMies.set('n', '6');

    const qKat = new URLSearchParams(q);
    if (katMode === 'kontekst') qKat.set('kontekst', '1');
    const fetches = [
      authFetch('/api/stats/kategorie?' + qKat).then(r => r.json()),
      authFetch('/api/stats/miesiace?' + qMies).then(r => r.json()),
      authFetch('/api/stats/sklepy?' + q).then(r => r.json()),
      authFetch('/api/wydatki?' + q).then(r => r.json()),
    ];
    if (kategoria) {
      fetches.push(authFetch('/api/stats/subkategorie?' + new URLSearchParams({ kategoria_glowna: kategoria, ...Object.fromEntries(q) })).then(r => r.json()));
      fetches.push(authFetch('/api/stats/top-produkt?' + q).then(r => r.json()));
    }

    let results;
    try {
      results = await Promise.all(fetches);
    } catch (e) {
      document.getElementById('sklepy-list').textContent = 'Błąd ładowania: ' + e.message;
      return;
    }
    const [statKat, statMies, statSklepy, wydatki] = results;
    if (!Array.isArray(statKat) || !Array.isArray(wydatki)) {
      document.getElementById('sklepy-list').textContent = 'Błąd API: ' + JSON.stringify(statKat);
      return;
    }
    const statSub = kategoria ? results[4] : null;
    const topProdukt = kategoria ? results[5] : null;

    lastMiesData = statMies;
    lastMiesKat = kategoria;
    renderStats(wydatki, statKat, kategoria, topProdukt);
    renderKategorieChart(statKat, kategoria, statSub);
    renderMiesiaceChart(statMies, kategoria);
    renderSklepy(statSklepy);
    renderTable(wydatki);
  }

  function renderStats(wydatki, statKat, kategoria, topProdukt) {
    const suma = wydatki.reduce((s, w) => s + w.suma, 0);
    document.getElementById('stat-suma').textContent = fmt(suma);
    const sumaLabel = document.querySelector('.stat-card .label');
    if (sumaLabel) sumaLabel.textContent = filterMode === 'range' ? 'Suma za okres' : 'Suma miesięczna';
    document.getElementById('stat-paragony').textContent = wydatki.length;
    const labelEl = document.querySelector('[for-stat="topkat"], .stat-card:last-child .label');
    const statLabel = document.getElementById('stat-topkat-label');
    if (kategoria && topProdukt && topProdukt.nazwa) {
      document.getElementById('stat-topkat').textContent = `${topProdukt.nazwa} (${fmt(topProdukt.suma_total)})`;
      if (statLabel) statLabel.textContent = 'Najdroższy produkt';
    } else {
      const topKat = statKat[0];
      document.getElementById('stat-topkat').textContent = topKat ? `${topKat.kategoria_glowna} (${fmt(topKat.suma)})` : '—';
      if (statLabel) statLabel.textContent = 'Największa kategoria';
    }
  }

  // Stałe kolory kategorii głównych — kolor trzyma się nazwy, a nie pozycji na wykresie,
  // więc przełączanie widoków (pierwotne/kontekstowe) nie przetasowuje kolorów.
  const KAT_COLORS = {
    'Spożywcze':           '#4f7ef8',
    'Higiena i kosmetyki': '#f84f8a',
    'Wydatki na dziecko':  '#f8d74f',
    'Dom i wyposażenie':   '#f87e4f',
    'Transport i paliwo':  '#4fc8f8',
    'Zdrowie':             '#4ff87e',
    'Odzież i obuwie':     '#a04ff8',
    'Rozrywka i hobby':    '#f84f4f',
    'Edukacja':            '#4ff8d7',
    'Elektronika':         '#8af84f',
    'Rachunki domowe':     '#5e60ce',
    'Lokal Gałczyńskiego': '#c47f3d',
    'Prezenty':            '#ff9ff3',
    'Używki':              '#8d6e63',
    'Inne':                '#9e9e9e',
  };
  function katColor(nazwa) {
    if (KAT_COLORS[nazwa]) return KAT_COLORS[nazwa];
    // kategorie spoza listy (własne w gospodarstwie): deterministyczny kolor z nazwy
    let h = 0;
    for (let i = 0; i < nazwa.length; i++) h = (h * 31 + nazwa.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 65%, 58%)`;
  }

  let activeGlowna = null;

  function renderKategorieChart(data, kategoria, statSub) {
    const ctx = document.getElementById('chart-kategorie').getContext('2d');
    if (chartKat) chartKat.destroy();
    const hint = document.getElementById('chart-kategorie-hint');
    const subPanel = document.getElementById('subkat-panel');

    if (kategoria && statSub) {
      // tryb kategorii — poziomy słupkowy rozkład podkategorii
      subPanel.classList.add('hidden');
      hint.style.display = 'none';
      const max = statSub[0]?.suma || 1;
      chartKat = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: statSub.map(s => s.kategoria),
          datasets: [{ data: statSub.map(s => s.suma), backgroundColor: '#a04ff8', borderRadius: 4 }],
        },
        options: {
          indexAxis: 'y',
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: c => ` ${fmt(c.raw)}` } },
          },
          scales: { x: { beginAtZero: true, ticks: { callback: v => fmt(v) } } },
          onClick: (_, els) => {
            if (!els.length) return;
            const subkat = statSub[els[0].index].kategoria;
            showDrill(subkat);
          },
        },
      });
    } else {
      // tryb ogólny — kołowy
      chartKat = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: data.map(d => d.kategoria_glowna),
          datasets: [{ data: data.map(d => d.suma), backgroundColor: data.map(d => katColor(d.kategoria_glowna)), borderWidth: 2 }],
        },
        options: {
          plugins: {
            legend: {
              position: 'right',
              labels: { boxWidth: 12, font: { size: 12 }, cursor: 'pointer' },
              onClick: (e, legendItem) => showSubkategorie(legendItem.text),
            },
            tooltip: { callbacks: { label: ctx => ` ${fmt(ctx.raw)}` } },
          },
          cutout: '60%',
          onClick: (_, els) => {
            if (!els.length) return;
            const glowna = data[els[0].index].kategoria_glowna;
            showSubkategorie(glowna);
          },
        },
      });
      hint.style.display = '';
    }
  }

  async function showSubkategorie(glowna) {
    activeGlowna = glowna;
    const month = monthInput.value;
    const osoba = osobaSelect.value;
    const q = new URLSearchParams({ kategoria_glowna: glowna });
    if (month) q.set('month', month);
    if (osoba) q.set('osoba', osoba);
    if (katMode === 'kontekst') q.set('kontekst', '1');

    const qw = new URLSearchParams({ kategoria: glowna });
    if (month) qw.set('month', month);
    if (osoba) qw.set('osoba', osoba);
    if (katMode === 'kontekst') qw.set('kontekst', '1');

    const [subs, wydatki] = await Promise.all([
      authFetch('/api/stats/subkategorie?' + q).then(r => r.json()),
      authFetch('/api/wydatki?' + qw).then(r => r.json()),
    ]);
    const panel = document.getElementById('subkat-panel');
    const title = document.getElementById('subkat-title');
    const list = document.getElementById('subkat-list');

    title.textContent = glowna;
    const max = subs[0]?.suma || 1;
    const subHTML = subs.map((s, i) => `
      <div class="subkat-row" data-idx="${i}">
        <span class="subkat-toggle">▶</span>
        <span style="min-width:160px;font-size:13px">${esc(s.kategoria)}</span>
        <div class="sklep-bar-wrap"><div class="sklep-bar" style="width:${(s.suma/max*100).toFixed(1)}%;background:#a04ff8"></div></div>
        <span style="white-space:nowrap;color:var(--muted);font-size:13px">${fmt(s.suma)}</span>
      </div>
      <div class="subkat-pozycje hidden" id="subkat-poz-${i}">
        <div class="subkat-poz-loading">Ładowanie...</div>
      </div>`).join('');

    const wydatkiHTML = wydatki.length ? `
      <h3 style="font-size:14px;font-weight:600;margin:16px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Paragony w tej kategorii</h3>
      <table class="pozycje-table">
        <thead><tr>
          <th>Data</th><th>Sklep</th><th>Osoba</th><th style="text-align:right">Suma</th><th></th>
        </tr></thead>
        <tbody>
          ${wydatki.map(w => `
            <tr>
              <td>${w.data}</td>
              <td>
                ${w.sklep || '—'}
                ${w.notatki ? `<div class="notatka-hint">${w.notatki}</div>` : ''}
                ${katMode === 'kontekst' && w.kontekst_kategoria === glowna ? `<div style="font-size:11px;color:#a04ff8;margin-top:2px">↩ kontekst${w.kontekst_podkategoria ? ': ' + esc(w.kontekst_podkategoria) : ''}</div>` : ''}
              </td>
              <td><span class="badge ${w.osoba==='Ola'?'ola':''}">${w.osoba}</span></td>
              <td style="text-align:right;font-weight:600">${fmt(w.suma)}</td>
              <td><button class="btn btn-outline btn-sm" onclick="editWydatek(${w.id})">Edytuj</button></td>
            </tr>`).join('')}
        </tbody>
      </table>` : '';

    list.innerHTML = subHTML + wydatkiHTML;
    panel.classList.remove('hidden');

    // binduj kliknięcia po wyrenderowaniu
    list.querySelectorAll('.subkat-row').forEach((rowEl, i) => {
      rowEl.addEventListener('click', async () => {
        const poz = document.getElementById('subkat-poz-' + i);
        const toggle = rowEl.querySelector('.subkat-toggle');
        const isOpen = !poz.classList.contains('hidden');
        if (isOpen) { poz.classList.add('hidden'); toggle.textContent = '▶'; return; }
        poz.classList.remove('hidden');
        toggle.textContent = '▼';
        if (!poz.querySelector('.subkat-poz-loading')) return;

        const kategoria = subs[i].kategoria;
        const month = monthInput.value;
        const osoba = osobaSelect.value;
        const q = new URLSearchParams({ kategoria });
        if (month) q.set('month', month);
        if (osoba) q.set('osoba', osoba);
        if (katMode === 'kontekst') q.set('kontekst', '1');

        const items = await authFetch('/api/stats/pozycje-subkat?' + q).then(r => r.json());
        if (!items.length) {
          poz.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:6px 8px">Brak pozycji</p>';
          return;
        }
        poz.innerHTML = `
          <table class="pozycje-table" style="margin-left:20px">
            <thead><tr>
              <th>Produkt</th><th>Sklep</th><th>Data</th>
              <th style="text-align:right">Ilość</th>
              <th style="text-align:right">Cena</th>
              <th style="text-align:right">Suma</th>
            </tr></thead>
            <tbody>
              ${items.map(p => `<tr>
                <td>
                  ${esc(p.nazwa)}
                  ${katMode === 'kontekst' && p.kontekst_podkategoria && p.oryg_subkat !== p.kontekst_podkategoria ? `<div style="font-size:10px;color:#aaa">${esc(p.oryg_subkat)}</div>` : ''}
                </td>
                <td style="color:var(--muted)">${esc(p.sklep || '—')}</td>
                <td style="color:var(--muted)">${p.data}</td>
                <td style="text-align:right;color:var(--muted)">${p.ilosc > 1 ? p.ilosc : ''}</td>
                <td style="text-align:right;color:var(--muted)">${fmt(p.cena)}</td>
                <td style="text-align:right;font-weight:600">${fmt(p.suma)}</td>
              </tr>`).join('')}
            </tbody>
          </table>`;
      });
    });
  }

  document.getElementById('subkat-close')?.addEventListener('click', () => {
    document.getElementById('subkat-panel').classList.add('hidden');
    activeGlowna = null;
  });

  // toggle trendy: osobno / łącznie
  document.getElementById('btn-osobno')?.addEventListener('click', () => {
    miesiaceLacznie = false;
    document.getElementById('btn-osobno').classList.add('active');
    document.getElementById('btn-lacznie').classList.remove('active');
    if (lastMiesData) renderMiesiaceChart(lastMiesData, lastMiesKat);
  });
  document.getElementById('btn-lacznie')?.addEventListener('click', () => {
    miesiaceLacznie = true;
    document.getElementById('btn-lacznie').classList.add('active');
    document.getElementById('btn-osobno').classList.remove('active');
    if (lastMiesData) renderMiesiaceChart(lastMiesData, lastMiesKat);
  });

  async function showDrill(subkat) {
    const month = monthInput.value;
    const osoba = osobaSelect.value;
    const q = new URLSearchParams({ kategoria: subkat });
    if (month) q.set('month', month);
    if (osoba) q.set('osoba', osoba);
    if (katMode === 'kontekst') q.set('kontekst', '1');
    const data = await authFetch('/api/stats/pozycje-subkat?' + q).then(r => r.json());
    const panel = document.getElementById('drill-panel');
    document.getElementById('drill-title').textContent = subkat;
    const list = document.getElementById('drill-list');
    if (!data.length) {
      list.innerHTML = '<p style="color:var(--muted);font-size:13px">Brak danych</p>';
    } else {
      const rows = data.map(p => `<tr>
        <td>${p.data}</td>
        <td>${esc(p.sklep || '—')}</td>
        <td>
          ${esc(p.nazwa)}
          ${p.kontekst_podkategoria && p.oryg_subkat !== p.kontekst_podkategoria ? `<div style="font-size:10px;color:#aaa">${esc(p.oryg_subkat)}</div>` : ''}
        </td>
        <td style="text-align:right">${fmt(p.cena)} × ${p.ilosc}</td>
        <td style="text-align:right;font-weight:600">${fmt(p.suma)}</td>
      </tr>`).join('');
      list.innerHTML = `<div class="table-wrap" style="margin-top:10px"><table>
        <thead><tr><th>Data</th><th>Sklep</th><th>Produkt</th><th>Cena×il.</th><th>Suma</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    }
    panel.classList.remove('hidden');
  }

  document.getElementById('drill-close')?.addEventListener('click', () => {
    document.getElementById('drill-panel').classList.add('hidden');
  });

  function renderMiesiaceChart(data, kategoria) {
    const miesiace = [...new Set(data.map(d => d.miesiac))].sort();
    const ctx = document.getElementById('chart-miesiace').getContext('2d');
    if (chartMies) chartMies.destroy();

    let datasets;
    if (miesiaceLacznie) {
      const lacznie = miesiace.map(m =>
        data.filter(d => d.miesiac === m).reduce((s, d) => s + d.suma, 0)
      );
      datasets = [{ label: 'Łącznie', data: lacznie, backgroundColor: '#4fc8f8', borderRadius: 4 }];
    } else {
      const OSOBA_COLORS = ['#4f7ef8', '#f84f8a', '#4fc8f8', '#f8a04f', '#a04ff8', '#4ff8a0'];
      const osoby = [...new Set(data.map(d => d.osoba))].sort();
      datasets = osoby.map((osoba, i) => ({
        label: osoba,
        data: miesiace.map(m => data.find(d => d.miesiac === m && d.osoba === osoba)?.suma ?? 0),
        backgroundColor: OSOBA_COLORS[i % OSOBA_COLORS.length],
        borderRadius: 4,
      }));
    }

    chartMies = new Chart(ctx, {
      type: 'bar',
      data: { labels: miesiace, datasets },
      options: {
        scales: { x: { stacked: false }, y: { beginAtZero: true, ticks: { callback: v => fmt(v) } } },
        plugins: {
          legend: { position: 'top' },
          title: kategoria ? { display: true, text: kategoria, font: { size: 13 }, color: '#a04ff8' } : { display: false },
        },
      },
    });
  }

  function renderSklepy(data) {
    const el = document.getElementById('sklepy-list');
    if (!data.length) { el.innerHTML = '<p style="color:var(--muted);font-size:14px">Brak danych</p>'; return; }
    const max = data[0].suma;
    el.innerHTML = data.map(s => `
      <div class="sklep-row">
        <span style="min-width:100px;font-weight:500">${s.sklep}</span>
        <div class="sklep-bar-wrap"><div class="sklep-bar" style="width:${(s.suma/max*100).toFixed(1)}%"></div></div>
        <span style="white-space:nowrap;color:var(--muted);font-size:13px">${fmt(s.suma)}</span>
      </div>`).join('');
  }

  function renderTable(data) {
    const tbody = document.querySelector('#wydatki-table tbody');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Brak wydatków w tym okresie</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(w => `
      <tr class="wydatek-row" data-id="${w.id}">
        <td>
          <button class="expand-btn" onclick="togglePozycje(${w.id}, this)" title="Rozwiń pozycje">▶</button>
        </td>
        <td>${w.data}</td>
        <td>
          <span class="sklep-name">${w.sklep || '—'}</span>
          ${w.notatki ? `<div class="notatka-hint">${w.notatki}</div>` : ''}
        </td>
        <td style="font-size:13px">
          ${w.okazja ? `<span style="font-weight:500;color:#7c3aed">${esc(w.okazja)}</span>` : ''}
          ${w.kontekst_kategoria ? `<div style="font-size:11px;color:#a04ff8">→ ${esc(w.kontekst_kategoria)}</div>` : ''}
        </td>
        <td style="font-weight:600">${fmt(w.suma)}</td>
        <td><span class="badge ${w.osoba === 'Ola' ? 'ola' : ''}">${w.osoba}</span></td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="editWydatek(${w.id})">Edytuj</button>
          <button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteWydatek(${w.id})">Usuń</button>
        </td>
      </tr>
      <tr class="pozycje-row hidden" id="pozycje-${w.id}">
        <td colspan="6" class="pozycje-detail">
          <div class="pozycje-loading">Ładowanie...</div>
        </td>
      </tr>`).join('');
  }

  window.togglePozycje = async function(id, btn) {
    const row = document.getElementById('pozycje-' + id);
    const expanded = !row.classList.contains('hidden');

    if (expanded) {
      row.classList.add('hidden');
      btn.textContent = '▶';
      btn.classList.remove('expanded');
      return;
    }

    row.classList.remove('hidden');
    btn.textContent = '▼';
    btn.classList.add('expanded');

    const detail = row.querySelector('.pozycje-detail');
    if (detail.querySelector('.pozycje-loading')) {
      const w = await authFetch('/api/wydatki/' + id).then(r => r.json());
      if (!w.pozycje || !w.pozycje.length) {
        detail.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 0">Brak pozycji</p>';
        return;
      }
      detail.innerHTML = `
        <table class="pozycje-table">
          <thead>
            <tr>
              <th>Produkt</th>
              <th>Kategoria</th>
              <th style="text-align:right">Ilość</th>
              <th style="text-align:right">Cena</th>
              <th style="text-align:right">Suma</th>
            </tr>
          </thead>
          <tbody>
            ${w.pozycje.map(p => `
              <tr>
                <td>${p.nazwa}</td>
                <td>
                  <span class="badge" style="background:#eef1fb;margin-right:4px">${p.kategoria_glowna || ''}</span>
                  <span class="badge" style="background:#f0f3ff;color:#6b7280">${p.kategoria}</span>
                </td>
                <td style="text-align:right;color:var(--muted)">${p.ilosc > 1 ? p.ilosc + ' szt.' : ''}</td>
                <td style="text-align:right;color:var(--muted)">${fmt(p.cena)}</td>
                <td style="text-align:right;font-weight:600">${fmt(p.cena * p.ilosc)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="notatki-inline">
          <textarea id="note-${id}" rows="2" placeholder="Notatka do paragonu...">${w.notatki || ''}</textarea>
          <button class="btn btn-sm btn-outline" onclick="saveNote(${id})">Zapisz notatkę</button>
        </div>`;
    }
  };

  window.saveNote = async function(id) {
    const notatki = document.getElementById('note-' + id).value;
    await authFetch('/api/wydatki/' + id + '/notatki', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notatki }),
    });
    loadDashboard();
  };

  window.deleteWydatek = async function(id) {
    if (!confirm('Usunąć ten wydatek?')) return;
    await authFetch('/api/wydatki/' + id, { method: 'DELETE' });
    loadDashboard();
  };

  window.editWydatek = function(id) {
    window.location.href = '/upload?edit=' + id;
  };

  monthInput.addEventListener('change', loadDashboard);
  odInput.addEventListener('change', loadDashboard);
  doInput.addEventListener('change', loadDashboard);
  osobaSelect.addEventListener('change', loadDashboard);
  katSelect.addEventListener('change', loadDashboard);

  // ── Przelicz kategorie (tylko admin) ──
  if (!authIsAdmin(me)) {
    const rekatSection = document.querySelector('details.card');
    if (rekatSection) rekatSection.style.display = 'none';
  }

  const btnPreview = document.getElementById('btn-rekat-preview');
  const btnRun = document.getElementById('btn-rekat-run');
  const rekatInfo = document.getElementById('rekat-info');

  function rekatParams() {
    const od = document.getElementById('rekat-od').value;
    const do_ = document.getElementById('rekat-do').value;
    const q = new URLSearchParams();
    if (od) q.set('od', od);
    if (do_) q.set('do', do_);
    return q;
  }

  btnPreview.addEventListener('click', async () => {
    const q = rekatParams();
    const data = await authFetch('/api/admin/rekat-preview?' + q).then(r => r.json());
    if (data.liczba === 0) {
      rekatInfo.textContent = 'Brak pozycji w wybranym zakresie.';
      btnRun.disabled = true;
    } else {
      rekatInfo.innerHTML = `<strong>${data.liczba} pozycji</strong> do przeliczenia — ${data.szacowane_paczki} zapytań do Claude AI.`;
      btnRun.disabled = false;
    }
  });

  btnRun.addEventListener('click', async () => {
    if (!confirm('Przelicz kategorie? Zostanie wysłanych kilka zapytań do Claude AI.')) return;
    btnRun.disabled = true;
    btnRun.innerHTML = '<span class="loader"></span> Przeliczam...';
    rekatInfo.textContent = 'Trwa przeliczanie — nie zamykaj strony...';
    try {
      const q = rekatParams();
      const body = Object.fromEntries(q.entries());
      const data = await authFetch('/api/admin/rekategoryzuj', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json());
      rekatInfo.innerHTML = `Gotowe — zaktualizowano <strong>${data.zaktualizowane} pozycji</strong>.`;
      loadDashboard();
    } catch (e) {
      rekatInfo.textContent = 'Błąd: ' + e.message;
    } finally {
      btnRun.textContent = 'Przelicz';
    }
  });
  loadDashboard();
}); }

// ── UPLOAD PAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────

if (document.getElementById('drop-zone')) { authRequireHousehold().then(async (me) => {
  await loadOsobaOptions('osoba');
  const osobaSel = document.getElementById('osoba');
  if (me && me.display_name && [...osobaSel.options].some(o => o.value === me.display_name)) {
    osobaSel.value = me.display_name;
  }
  const OSOBY_OPCJE = [...osobaSel.options].map(o => ({ value: o.value, label: o.text }));
  let HIERARCHIA = {};
  let GLOWNE = [];

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const previewThumbs = document.getElementById('preview-thumbs');
  const analyzeBtn = document.getElementById('btn-analyze');
  const resultSection = document.getElementById('result-section');
  const alertEl = document.getElementById('alert');
  const textInput = document.getElementById('text-input');
  const tabImage = document.getElementById('tab-image');
  const tabText = document.getElementById('tab-text');
  const panelImage = document.getElementById('panel-image');
  const panelText = document.getElementById('panel-text');
  const cardsContainer = document.getElementById('paragony-cards');
  const saveAllBtn = document.getElementById('btn-save-all');

  // receiptsData[i] = { sklep, data, suma, osoba, notatki, pozycje[], konto_id }
  let receiptsData = [];
  let editId = null;
  let selectedFiles = [];
  let KONTA_OPCJE = [];
  let myDefaultKontoId = null;

  // Załaduj hierarchię kategorii + konta + domyślne konto
  Promise.all([
    authFetch('/api/kategorie').then(r => r.json()),
    authFetch('/api/konta').then(r => r.json()),
    authFetch('/api/me/konto-domyslne').then(r => r.json()),
  ]).then(([hier, konta, def]) => {
    HIERARCHIA = hier;
    GLOWNE = Object.keys(hier);
    KONTA_OPCJE = konta;
    myDefaultKontoId = def.konto_id || null;
    const params = new URLSearchParams(location.search);
    if (params.get('edit')) {
      editId = parseInt(params.get('edit'));
      loadEdit(editId);
    }
  });

  const params = new URLSearchParams(location.search);
  if (!params.get('edit')) {
    // nie ma edycji — init od razu (nie potrzebujemy HIERARCHIA przed akcją usera)
  }

  // tabs
  tabImage.addEventListener('click', () => {
    tabImage.classList.add('active'); tabText.classList.remove('active');
    panelImage.classList.remove('hidden'); panelText.classList.add('hidden');
    analyzeBtn.disabled = !fileInput.files.length;
  });
  tabText.addEventListener('click', () => {
    tabText.classList.add('active'); tabImage.classList.remove('active');
    panelText.classList.remove('hidden'); panelImage.classList.add('hidden');
    analyzeBtn.disabled = !textInput.value.trim();
  });

  textInput.addEventListener('input', () => {
    if (!panelText.classList.contains('hidden')) {
      analyzeBtn.disabled = !textInput.value.trim();
    }
  });

  // drag & drop
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', () => handleFiles(fileInput.files));

  function handleFiles(files) {
    if (!files || !files.length) return;
    for (const file of files) selectedFiles.push(file);
    renderFilePreviews();
  }

  function renderFilePreviews() {
    previewThumbs.innerHTML = '';
    selectedFiles.forEach((file, i) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;display:inline-block';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.style.cssText = 'height:80px;width:60px;object-fit:cover;border-radius:6px;border:1px solid var(--border)';
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'Usuń';
      del.style.cssText = 'position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:none;background:#e74c3c;color:#fff;font-size:12px;line-height:1;cursor:pointer;padding:0';
      del.onclick = (e) => { e.stopPropagation(); selectedFiles.splice(i, 1); renderFilePreviews(); fileInput.value = ''; };
      wrap.appendChild(img);
      wrap.appendChild(del);
      previewThumbs.appendChild(wrap);
    });
    const n = selectedFiles.length;
    dropZone.querySelector('p').textContent = n === 0 ? 'Przeciągnij zdjęcie lub kliknij, by wybrać plik' : n === 1 ? selectedFiles[0].name : `${n} zdjęć wybranych`;
    analyzeBtn.disabled = n === 0;
  }

  analyzeBtn.addEventListener('click', async () => {
    setAlert('');
    analyzeBtn.disabled = true;
    const fileCount = fileInput.files.length;
    analyzeBtn.innerHTML = `<span class="loader"></span> Analizuję${fileCount > 1 ? ` ${fileCount} zdjęć...` : '...'}`;
    const osoba = document.getElementById('osoba').value;
    const kontekst = document.getElementById('kontekst-input').value.trim();

    try {
      let list;
      if (!panelText.classList.contains('hidden')) {
        const text = textInput.value.trim();
        if (!text) { setAlert('Wpisz treść notatki', 'error'); return; }
        const res = await authFetch('/api/process-text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, osoba, kontekst }),
        });
        list = await res.json().catch(() => ({ detail: `Serwer zwrócił nieoczekiwaną odpowiedź (HTTP ${res.status}). Spróbuj ponownie.` }));
        if (!res.ok) throw new Error(list.detail || `Błąd serwera (HTTP ${res.status})`);
      } else {
        if (!selectedFiles.length) { setAlert('Wybierz plik', 'error'); return; }

        // wyślij wszystkie zdjęcia równolegle
        const requests = selectedFiles.map(file => {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('osoba', osoba);
          if (kontekst) fd.append('kontekst', kontekst);
          return authFetch('/api/process-image', { method: 'POST', body: fd })
            .then(r => r.json()
              .catch(() => ({ detail: `Serwer zwrócił nieoczekiwaną odpowiedź (HTTP ${r.status}). Spróbuj ponownie.` }))
              .then(data => ({ ok: r.ok, data, name: file.name })));
        });

        const results = await Promise.all(requests);
        const failed = results.filter(r => !r.ok);
        if (failed.length) {
          const prefix = selectedFiles.length > 1;
          throw new Error(failed
            .map(f => (prefix ? `${f.name}: ` : '') + (f.data.detail || 'nieznany błąd'))
            .join('\n'));
        }
        list = results.filter(r => r.ok).flatMap(r => r.data);
      }

      receiptsData = list.map(r => ({ ...r, osoba: r.osoba || osoba, notatki: '', konto_id: r.konto_id ?? myDefaultKontoId }));
      renderCards();
      resultSection.classList.remove('hidden');
    } catch (e) {
      setAlert('Błąd: ' + e.message, 'error');
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = 'Analizuj';
    }
  });

  // ── render all paragon cards ──

  function renderCards() {
    if (receiptsData.length === 0) { cardsContainer.innerHTML = ''; return; }

    const isEdit = editId !== null;
    saveAllBtn.textContent = isEdit ? 'Zapisz zmiany' : `Zapisz wszystkie (${receiptsData.length})`;

    cardsContainer.innerHTML = receiptsData.map((r, ri) => `
      <div class="paragon-card" id="card-${ri}">
        <div class="paragon-card-header" onclick="toggleCard(${ri})">
          <span class="card-toggle" id="toggle-${ri}">▼</span>
          <span class="card-title">
            <strong>${r.sklep || 'Nieznany sklep'}</strong>
            <span class="card-date">${r.data}</span>
          </span>
          <span class="card-suma">
            ${fmt(r.suma)}
            ${r.waluta && r.waluta !== 'PLN' ? `<span class="badge" style="font-size:11px;margin-left:6px">${r.waluta} × ${r.kurs}</span>` : ''}
          </span>
          ${receiptsData.length > 1 ? `<button class="remove-card-btn" onclick="removeCard(event,${ri})" title="Usuń ten paragon">×</button>` : ''}
        </div>
        <div class="paragon-card-body" id="card-body-${ri}">
          ${r._ostrzezenie ? `<div class="alert alert-warning" style="margin-bottom:12px">
            <strong>Uwaga:</strong> ${r._ostrzezenie}
            ${r.suma_paragon ? `<br><small>Suma z paragonu: <strong>${fmt(r.suma_paragon)}</strong> — użyto sumy widocznych pozycji. Sprawdź czy paragon był kompletny.</small>` : ''}
          </div>` : ''}
          <div class="form-row" style="margin-bottom:12px">
            <div class="form-group">
              <label>Sklep</label>
              <input type="text" value="${esc(r.sklep||'')}" placeholder="np. Biedronka" style="width:100%"
                oninput="updateReceipt(${ri},'sklep',this.value)">
            </div>
            <div class="form-group">
              <label>Data</label>
              <input type="date" value="${r.data}" style="width:100%"
                oninput="updateReceipt(${ri},'data',this.value)">
            </div>
          </div>
          <div class="form-row" style="margin-bottom:12px">
            <div class="form-group">
              <label>Suma (PLN)</label>
              <input type="number" step="0.01" value="${r.suma}" style="width:100%"
                oninput="updateReceipt(${ri},'suma',parseFloat(this.value))">
            </div>
            <div class="form-group">
              <label>Osoba</label>
              <select style="width:100%" onchange="updateReceipt(${ri},'osoba',this.value)">
                ${OSOBY_OPCJE.map(o => `<option value="${esc(o.value)}" ${r.osoba===o.value?'selected':''}>${esc(o.label)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-row" style="margin-bottom:12px">
            <div class="form-group" style="flex:1">
              <label>Z konta <span style="font-weight:400;color:var(--muted)">(opcjonalnie)</span></label>
              <select style="width:100%" onchange="updateReceipt(${ri},'konto_id',parseInt(this.value)||null)">
                <option value="">— nie przypisane —</option>
                ${KONTA_OPCJE.map(k => `<option value="${k.id}" ${r.konto_id===k.id?'selected':''}>${esc(k.nazwa)}${k.osoba?' ('+esc(k.osoba)+')':''}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="form-row" style="margin-bottom:12px">
            <div class="form-group">
              <label>Okazja <span style="font-weight:400;color:var(--muted)">(opcjonalnie)</span></label>
              <input type="text" value="${esc(r.okazja||'')}" placeholder="np. Urodziny Zosi, Wakacje 2026" style="width:100%"
                oninput="updateReceipt(${ri},'okazja',this.value)">
            </div>
            <div class="form-group">
              <label>Kontekst kategorii <span style="font-weight:400;color:var(--muted)">(opcjonalnie)</span></label>
              <select id="kkSelect-${ri}" style="width:100%" onchange="updateKontekstKat(${ri},this.value)">
                <option value="">— brak —</option>
                ${GLOWNE.map(g => `<option value="${esc(g)}" ${r.kontekst_kategoria===g?'selected':''}>${esc(g)}</option>`).join('')}
              </select>
            </div>
          </div>
          ${r.kontekst_kategoria ? `
          <div class="form-row" style="margin-bottom:12px">
            <div class="form-group" style="flex:1">
              <label>Kontekst podkategorii <span style="font-weight:400;color:var(--muted)">(opcjonalnie)</span></label>
              <select id="kpSelect-${ri}" style="width:100%" onchange="updateReceipt(${ri},'kontekst_podkategoria',this.value||null)">
                <option value="">— brak (użyj podkategorii pozycji) —</option>
                ${(HIERARCHIA[r.kontekst_kategoria]||[]).map(s => `<option value="${esc(s)}" ${r.kontekst_podkategoria===s?'selected':''}>${esc(s)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" style="flex:0">
            </div>
          </div>
          ` : ''}

          <div style="font-size:13px;font-weight:600;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">
            Pozycje (${r.pozycje.length})
          </div>
          <div class="pozycje-list" id="poz-${ri}">
            ${renderPozycjeHTML(ri, r.pozycje)}
          </div>
          <button class="btn btn-outline btn-sm" style="margin-top:8px" onclick="addPozycja(${ri})">+ Dodaj pozycję</button>
        </div>
      </div>`).join('');
  }

  function subOptions(glowna, wybrana) {
    return (HIERARCHIA[glowna] || ['Inne']).map(
      k => `<option value="${k}" ${k === wybrana ? 'selected' : ''}>${k}</option>`
    ).join('');
  }

  function renderPozycjeHTML(ri, pozycje) {
    const maKontekst = !!receiptsData[ri].kontekst_kategoria;
    return pozycje.map((p, pi) => {
      const glowna = p.kategoria_glowna || GLOWNE[0];
      return `
      <div class="pozycja-row-full">
        <div class="pozycja-main">
          <input type="text" value="${esc(p.nazwa)}" placeholder="Nazwa"
            oninput="updatePozycja(${ri},${pi},'nazwa',this.value)">
          <input type="number" step="0.01" value="${p.cena}" placeholder="Cena"
            oninput="updatePozycja(${ri},${pi},'cena',parseFloat(this.value))">
          <input type="number" step="0.1" value="${p.ilosc||1}" placeholder="Ilość"
            oninput="updatePozycja(${ri},${pi},'ilosc',parseFloat(this.value))">
          <button class="remove-btn" onclick="removePozycja(${ri},${pi})" title="Usuń">×</button>
        </div>
        <div class="pozycja-kat">
          <select id="glowna-${ri}-${pi}" onchange="onGlownaChange(${ri},${pi},this.value)">
            ${GLOWNE.map(g => `<option value="${g}" ${g===glowna?'selected':''}>${g}</option>`).join('')}
          </select>
          <select id="sub-${ri}-${pi}" onchange="updatePozycja(${ri},${pi},'kategoria',this.value)">
            ${subOptions(glowna, p.kategoria)}
          </select>
          ${maKontekst ? `
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#888;white-space:nowrap;cursor:pointer;margin-left:4px">
            <input type="checkbox" ${p.poza_kontekstem ? 'checked' : ''}
              onchange="updatePozycja(${ri},${pi},'poza_kontekstem',this.checked)"
              style="cursor:pointer">
            poza kontekstem
          </label>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  window.onGlownaChange = function(ri, pi, glowna) {
    updatePozycja(ri, pi, 'kategoria_glowna', glowna);
    const sub = HIERARCHIA[glowna]?.[0] || 'Inne';
    updatePozycja(ri, pi, 'kategoria', sub);
    const subSel = document.getElementById(`sub-${ri}-${pi}`);
    if (subSel) subSel.innerHTML = subOptions(glowna, sub);
  };

  window.toggleCard = function(ri) {
    const body = document.getElementById('card-body-' + ri);
    const tog = document.getElementById('toggle-' + ri);
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    tog.textContent = hidden ? '▼' : '▶';
  };

  window.removeCard = function(e, ri) {
    e.stopPropagation();
    receiptsData.splice(ri, 1);
    renderCards();
  };

  window.updateReceipt = (ri, key, val) => { receiptsData[ri][key] = val; };

  window.updateKontekstKat = function(ri, val) {
    receiptsData[ri].kontekst_kategoria = val || null;
    receiptsData[ri].kontekst_podkategoria = null;
    renderCards();
  };

  window.updatePozycja = (ri, pi, key, val) => { receiptsData[ri].pozycje[pi][key] = val; };

  window.removePozycja = function(ri, pi) {
    receiptsData[ri].pozycje.splice(pi, 1);
    document.getElementById('poz-' + ri).innerHTML = renderPozycjeHTML(ri, receiptsData[ri].pozycje);
  };

  window.addPozycja = function(ri) {
    receiptsData[ri].pozycje.push({ nazwa: '', cena: 0, ilosc: 1, kategoria: 'Inne' });
    document.getElementById('poz-' + ri).innerHTML = renderPozycjeHTML(ri, receiptsData[ri].pozycje);
  };

  // ── save ──

  saveAllBtn.addEventListener('click', async () => {
    if (!receiptsData.length) return;

    for (const r of receiptsData) {
      if (!r.data || !r.suma) { setAlert('Uzupełnij datę i sumę we wszystkich paragonach', 'error'); return; }
    }

    saveAllBtn.disabled = true;
    saveAllBtn.innerHTML = '<span class="loader"></span> Zapisuję...';

    try {
      if (editId) {
        const r = receiptsData[0];
        const res = await authFetch('/api/wydatki/' + editId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r),
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.detail); }
      } else {
        for (const r of receiptsData) {
          const res = await authFetch('/api/wydatki', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(r),
          });
          if (!res.ok) { const e = await res.json(); throw new Error(e.detail); }
        }
      }
      setAlert(`Zapisano ${receiptsData.length} paragon${receiptsData.length === 1 ? '' : receiptsData.length < 5 ? 'y' : 'ów'}!`, 'success');
      setTimeout(() => { window.location.href = '/'; }, 1000);
    } catch (e) {
      setAlert('Błąd zapisu: ' + e.message, 'error');
    } finally {
      saveAllBtn.disabled = false;
      saveAllBtn.textContent = editId ? 'Zapisz zmiany' : `Zapisz wszystkie (${receiptsData.length})`;
    }
  });

  // ── edit mode ──

  async function loadEdit(id) {
    document.getElementById('page-title').textContent = 'Edytuj wydatek';
    analyzeBtn.classList.add('hidden');
    const w = await authFetch('/api/wydatki/' + id).then(r => r.json());
    receiptsData = [{ ...w, notatki: w.notatki || '' }];
    renderCards();
    resultSection.classList.remove('hidden');
  }

  function setAlert(msg, type = 'error') {
    if (!msg) { alertEl.className = 'hidden'; return; }
    alertEl.className = 'alert alert-' + type;
    alertEl.style.whiteSpace = 'pre-line';
    alertEl.textContent = msg;
  }

}); }

