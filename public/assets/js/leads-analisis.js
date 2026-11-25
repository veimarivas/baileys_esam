/**
 * /leads/analisis: dibuja los gráficos con ApexCharts (la librería del panel).
 * Los números vienen del servidor en #la-data. Respeta el modo oscuro.
 */
(function () {
  'use strict';

  const page = document.getElementById('la-page');
  if (!page) return;

  // Filtros: aplican al elegir (sin JS queda el botón «Aplicar»).
  page.querySelectorAll('[data-la-auto]').forEach((el) => el.addEventListener('change', () => el.form.submit()));
  const submit = page.querySelector('[data-la-submit]');
  if (submit) submit.hidden = true;

  const dataEl = document.getElementById('la-data');
  if (!dataEl || !window.ApexCharts) return;
  let data;
  try {
    data = JSON.parse(dataEl.textContent || '{}');
  } catch (e) {
    return;
  }

  const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  const C = dark
    ? { brand: '#5fb3d3', brand2: '#e0895a', ink: '#c3cedd', mute: '#8b9cb3', grid: '#223148', ok: '#34c38f' }
    : { brand: '#045474', brand2: '#e2683a', ink: '#475467', mute: '#98a2b3', grid: '#e6ebf1', ok: '#0f7b55' };
  const font = getComputedStyle(document.body).fontFamily || 'inherit';

  function base(type, extra) {
    return Object.assign({
      chart: { type: type, height: 300, fontFamily: font, toolbar: { show: false }, foreColor: C.ink, background: 'transparent',
        animations: { enabled: true, speed: 450 } },
      theme: { mode: dark ? 'dark' : 'light' },
      dataLabels: { enabled: false },
      grid: { borderColor: C.grid, strokeDashArray: 3, padding: { left: 6, right: 6 } },
      legend: { position: 'top', horizontalAlign: 'left', fontSize: '12px', markers: { size: 6 }, itemMargin: { horizontal: 8 } },
      tooltip: { theme: dark ? 'dark' : 'light' },
    }, extra || {});
  }
  function render(id, opts) {
    const el = document.getElementById(id);
    if (el) new ApexCharts(el, opts).render();
  }
  function empty(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div class="la-chart-empty"><i class="ri-bar-chart-2-line"></i>' + text + '</div>';
  }
  const entero = (v) => Math.round(v).toLocaleString('es-BO');
  function shortDay(iso) {
    const p = String(iso).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] : iso;
  }

  // Leads nuevos por semana, por origen.
  const semanas = data.semanas || [];
  if (semanas.length) {
    // Eje de fechas: ApexCharts reparte solo las etiquetas (no se enciman).
    const t = (s) => new Date(s.semana + 'T12:00:00Z').getTime();
    render('la-semanas', base('area', {
      series: [
        { name: 'WhatsApp', data: semanas.map((s) => [t(s), s.linea]) },
        { name: 'Prospectos', data: semanas.map((s) => [t(s), s.prospecto]) },
      ],
      colors: [C.brand, C.brand2],
      stroke: { curve: 'smooth', width: 2 },
      fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.32, opacityTo: 0.04, stops: [0, 95] } },
      xaxis: { type: 'datetime', axisBorder: { color: C.grid }, axisTicks: { show: false },
        labels: { datetimeUTC: false, format: 'dd MMM', datetimeFormatter: { day: 'dd MMM', month: "MMM 'yy" } } },
      yaxis: { labels: { formatter: entero } },
      tooltip: { shared: true, intersect: false, theme: dark ? 'dark' : 'light', x: { formatter: (v) => 'Semana del ' + shortDay(new Date(v).toISOString().slice(0, 10)) }, y: { formatter: entero } },
    }));
  } else {
    empty('la-semanas', 'Sin leads nuevos en el período.');
  }

  // Embudo: barras horizontales con el color de cada etapa.
  const etapas = data.etapas || [];
  render('la-embudo', base('bar', {
    series: [{ name: 'Leads', data: etapas.map((e) => e.n) }],
    colors: etapas.map((e) => e.color),
    plotOptions: { bar: { horizontal: true, distributed: true, borderRadius: 5, barHeight: '62%' } },
    dataLabels: { enabled: true, style: { fontSize: '12px', fontWeight: 600, colors: ['#fff'] }, formatter: entero, dropShadow: { enabled: false } },
    legend: { show: false },
    xaxis: { categories: etapas.map((e) => e.label), labels: { formatter: entero }, axisBorder: { show: false } },
    grid: { borderColor: C.grid, strokeDashArray: 3, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
    tooltip: { theme: dark ? 'dark' : 'light', y: { formatter: entero } },
  }));

  // Por sede: barras apiladas por etapa.
  const sedes = data.sedes || [];
  if (document.getElementById('la-sedes')) {
    render('la-sedes', base('bar', {
      chart: { type: 'bar', stacked: true, height: Math.max(260, sedes.length * 44 + 80), fontFamily: font, toolbar: { show: false }, foreColor: C.ink, background: 'transparent' },
      series: etapas.map((e) => ({ name: e.label, data: sedes.map((s) => s.porEtapa[e.clave] || 0) })),
      colors: etapas.map((e) => e.color),
      plotOptions: { bar: { horizontal: true, borderRadius: 3, barHeight: '58%' } },
      xaxis: { categories: sedes.map((s) => s.sede + (s.conversion === null ? '' : '  ·  ' + s.conversion + '%')), labels: { formatter: entero } },
      tooltip: { shared: true, intersect: false, theme: dark ? 'dark' : 'light', y: { formatter: entero } },
    }));
  }

  // Origen: dona.
  const o = data.origen || { prospecto: 0, linea: 0 };
  if (o.prospecto + o.linea) {
    render('la-origen', base('donut', {
      series: [o.linea, o.prospecto],
      labels: ['WhatsApp', 'Prospectos'],
      colors: [C.brand, C.brand2],
      legend: { position: 'bottom', fontSize: '12px' },
      stroke: { width: 2, colors: [dark ? '#1b2433' : '#fff'] },
      plotOptions: { pie: { donut: { size: '68%', labels: { show: true, total: { show: true, label: 'Leads', color: C.mute, formatter: (w) => entero(w.globals.seriesTotals.reduce((a, b) => a + b, 0)) } } } } },
      dataLabels: { enabled: true, formatter: (v) => Math.round(v) + '%', dropShadow: { enabled: false } },
    }));
  } else {
    empty('la-origen', 'Sin datos.');
  }

  // Programas: leads vs inscritos.
  const programas = data.programas || [];
  if (programas.length) {
    render('la-programas', base('bar', {
      chart: { type: 'bar', height: Math.max(260, programas.length * 38 + 80), fontFamily: font, toolbar: { show: false }, foreColor: C.ink, background: 'transparent' },
      series: [
        { name: 'Leads', data: programas.map((p) => p.total) },
        { name: 'Inscritos', data: programas.map((p) => p.inscritos) },
      ],
      colors: [C.brand, C.ok],
      plotOptions: { bar: { horizontal: true, borderRadius: 4, barHeight: '70%' } },
      xaxis: {
        categories: programas.map((p) => {
          const nombre = p.programa.length > 40 ? p.programa.slice(0, 38) + '…' : p.programa;
          return p.tipoLabel ? p.tipoLabel + ' · ' + nombre : nombre;
        }),
        labels: { formatter: entero },
      },
      yaxis: { labels: { maxWidth: 280, style: { fontSize: '12px' } } },
      tooltip: { shared: true, intersect: false, theme: dark ? 'dark' : 'light', y: { formatter: entero } },
    }));
  } else {
    empty('la-programas', 'Sin programas registrados.');
  }

  // Por tipo de programa: leads e inscritos, con la conversión en la etiqueta.
  const tipos = data.tipos || [];
  if (tipos.length) {
    render('la-tipos', base('bar', {
      series: [
        { name: 'Leads', data: tipos.map((t) => t.total) },
        { name: 'Inscritos', data: tipos.map((t) => t.inscritos) },
      ],
      colors: [C.brand, C.ok],
      plotOptions: { bar: { borderRadius: 4, borderRadiusApplication: 'end', columnWidth: '58%' } },
      xaxis: { categories: tipos.map((t) => [t.label, t.conversion === null ? '' : t.conversion + '% conv.']), axisTicks: { show: false } },
      yaxis: { labels: { formatter: entero } },
      tooltip: { shared: true, intersect: false, theme: dark ? 'dark' : 'light', y: { formatter: entero } },
    }));
  } else {
    empty('la-tipos', 'Sin datos.');
  }
})();
