import * as echarts from 'echarts/core';
import { BarChart, GaugeChart, HeatmapChart, LineChart, SankeyChart } from 'echarts/charts';
import {
  CalendarComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart, GaugeChart, HeatmapChart, LineChart, SankeyChart,
  CalendarComponent, DataZoomComponent, GridComponent, LegendComponent,
  TooltipComponent, VisualMapComponent, CanvasRenderer,
]);

const usd = (cents) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2,
}).format((cents ?? 0) / 100);
const monthLabel = (month) => new Intl.DateTimeFormat('en-US', {
  month: 'short', year: '2-digit', timeZone: 'UTC',
}).format(new Date(`${month}-01T12:00:00Z`));
const periodLabel = (row) => row.label ?? (/^\d{4}-\d{2}$/u.test(row.month) ? monthLabel(row.month) : row.month);
const html = (value) => String(value ?? '').replace(/[&<>"']/gu, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export const chartHost = (id, label, className = '') =>
  `<div class="echart ${className}" data-echart="${id}" role="img" aria-label="${label}"></div>`;

function palette(root) {
  // Custom-property computed values retain light-dark(...), which Canvas
  // cannot parse. Resolve each token through a real color declaration first.
  const probe = root.ownerDocument.createElement('span');
  probe.hidden = true;
  root.append(probe);
  const read = (name, fallback) => {
    probe.style.color = `var(${name}, ${fallback})`;
    return getComputedStyle(probe).color || fallback;
  };
  const colors = {
    ink: read('--sp-ink', '#17201a'),
    muted: read('--sp-muted', '#68736b'),
    line: read('--sp-line', '#d8ddd9'),
    paper: read('--sp-paper', '#ffffff'),
    income: read('--sp-income', '#33775b'),
    spend: read('--sp-spend', '#c86358'),
    accent: read('--sp-pine-ink', '#225440'),
    soft: read('--sp-soft', '#eef2ef'),
  };
  probe.remove();
  return colors;
}

const legend = (colors, count = 0) => ({
  type: count > 4 ? 'scroll' : 'plain',
  top: 0,
  left: 'center',
  width: '88%',
  icon: 'rect',
  itemWidth: 10,
  itemHeight: 10,
  itemGap: 14,
  textStyle: { color: colors.muted },
  pageTextStyle: { color: colors.muted },
  pageIconColor: colors.accent,
  pageIconInactiveColor: colors.line,
  selectedMode: true,
});

const base = (colors) => ({
  animationDuration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350,
  textStyle: { color: colors.ink, fontFamily: 'DM Sans, system-ui, sans-serif' },
  tooltip: {
    trigger: 'axis',
    backgroundColor: colors.paper,
    borderColor: colors.line,
    textStyle: { color: colors.ink },
  },
  legend: legend(colors),
});

export function cashFlowOption(monthly, { zoom = true } = {}) {
  return (colors) => ({
    ...base(colors),
    legend: { ...legend(colors, 3), data: ['Income', 'Spending', 'Net'] },
    grid: { left: 58, right: 24, top: 48, bottom: zoom ? 70 : 38 },
    xAxis: {
      type: 'category',
      data: monthly.map(periodLabel),
      axisLabel: { color: colors.muted },
      axisLine: { lineStyle: { color: colors.line } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: colors.muted, formatter: usd },
      splitLine: { lineStyle: { color: colors.line } },
    },
    dataZoom: zoom ? [{ type: 'inside' }, { type: 'slider', height: 22, bottom: 10 }] : [],
    series: [
      { name: 'Income', type: 'line', smooth: 0.22, showSymbol: false, color: colors.income, data: monthly.map((row) => row.earnedCents) },
      { name: 'Spending', type: 'line', smooth: 0.22, showSymbol: false, color: colors.spend, data: monthly.map((row) => row.spentCents) },
      { name: 'Net', type: 'line', smooth: 0.22, showSymbol: false, color: colors.accent, lineStyle: { type: 'dashed' }, data: monthly.map((row) => row.netCents) },
    ],
    tooltip: { ...base(colors).tooltip, valueFormatter: usd },
  });
}

export function categoryOption(categories) {
  const rows = [...categories].sort((a, b) => b.currentCents - a.currentCents).slice(0, 10);
  return (colors) => ({
    ...base(colors),
    legend: { ...legend(colors, 2), data: ['This month', 'Prior monthly average'] },
    grid: { left: 122, right: 26, top: 46, bottom: 28 },
    xAxis: { type: 'value', axisLabel: { color: colors.muted, formatter: usd }, splitLine: { lineStyle: { color: colors.line } } },
    yAxis: { type: 'category', inverse: true, data: rows.map((row) => row.category), axisLabel: { color: colors.ink } },
    series: [
      { name: 'This month', type: 'bar', color: colors.spend, data: rows.map((row) => row.currentCents) },
      { name: 'Prior monthly average', type: 'bar', color: colors.income, data: rows.map((row) => row.averageCents) },
    ],
    tooltip: { ...base(colors).tooltip, valueFormatter: usd },
  });
}

export function sankeyOption(allocation, categories, goals) {
  const destinations = [
    ...categories.filter((row) => row.totalCents > 0).slice(0, 6).map((row) => ({ name: row.category, value: row.totalCents })),
    ...goals.filter((goal) => goal.savedCents > 0).slice(0, 4).map((goal) => ({ name: `Goal · ${goal.name}`, value: goal.savedCents })),
    ...(allocation.unallocatedSalaryCents ? [{ name: 'Unallocated salary', value: allocation.unallocatedSalaryCents }] : []),
  ];
  let salaryLeft = allocation.salaryCents;
  const links = [];
  for (const item of destinations) {
    const fromSalary = Math.min(salaryLeft, item.value);
    if (fromSalary) links.push({ source: 'Salary', target: item.name, value: fromSalary });
    if (item.value > fromSalary) links.push({ source: 'Other funds', target: item.name, value: item.value - fromSalary });
    salaryLeft -= fromSalary;
  }
  const sources = [{ name: 'Salary' }, ...(links.some((link) => link.source === 'Other funds') ? [{ name: 'Other funds' }] : [])];
  return (colors) => ({
    ...base(colors),
    tooltip: { ...base(colors).tooltip, trigger: 'item', valueFormatter: usd },
    legend: { ...legend(colors, 1), data: ['Allocation'] },
    series: [{
      name: 'Allocation',
      type: 'sankey',
      data: [...sources, ...destinations.map(({ name }) => ({ name }))],
      links,
      lineStyle: { color: 'gradient', opacity: 0.45 },
      label: { color: colors.ink, fontSize: 11 },
      emphasis: { focus: 'adjacency' },
    }],
  });
}

export function recurringOption(months, recurring) {
  const names = [...new Set(recurring.map((row) => row.name))].slice(0, 8);
  return (colors) => ({
    ...base(colors),
    legend: { ...legend(colors, names.length), data: names },
    grid: { left: 56, right: 18, top: 58, bottom: 42 },
    xAxis: { type: 'category', data: months.map(monthLabel), axisLabel: { color: colors.muted } },
    yAxis: { type: 'value', axisLabel: { color: colors.muted, formatter: usd }, splitLine: { lineStyle: { color: colors.line } } },
    series: names.map((name) => ({
      name, type: 'bar', stack: 'recurring',
      data: months.map((month) => recurring.filter((row) => row.month === month && row.name === name).reduce((sum, row) => sum + row.cents, 0)),
    })),
    tooltip: { ...base(colors).tooltip, valueFormatter: usd },
  });
}

export function calendarOption(calendar) {
  const days = new Map(calendar.days.map((day) => [day.date, day]));
  return (colors) => {
    const tooltip = ({ value }) => {
      const date = Array.isArray(value) ? value[0] : value?.value?.[0];
      const day = days.get(date);
      const items = day?.items?.length ? day.items : [{
        name: `${day?.count ?? 0} expected ${(day?.count ?? 0) === 1 ? 'cost' : 'costs'}`,
        cents: day?.cents ?? 0,
        direction: 'debit',
      }];
      return `<strong>${html(date)}</strong>${items.map((item) =>
        `<br>${html(item.name)} · ${item.direction === 'credit' ? '+' : '−'}${html(usd(item.cents))}`).join('')}`;
    };
    return {
      ...base(colors),
      tooltip: { ...base(colors).tooltip, trigger: 'item', formatter: tooltip },
      legend: { ...legend(colors, 3), data: ['Bills', 'Salary', 'Today'] },
      visualMap: [
        { show: false, seriesIndex: 0, min: 0, max: 1, inRange: { color: [colors.spend, colors.spend] } },
        { show: false, seriesIndex: 1, min: 0, max: 1, inRange: { color: [colors.income, colors.income] } },
        { show: false, seriesIndex: 2, min: 0, max: 1, inRange: { color: [colors.ink, colors.ink] } },
      ],
      calendar: {
        range: [calendar.from, calendar.to],
        top: 48,
        left: 42,
        right: 12,
        bottom: 12,
        cellSize: ['auto', 18],
        itemStyle: { color: colors.soft, borderColor: colors.paper, borderWidth: 3 },
        dayLabel: { color: colors.muted },
        monthLabel: { color: colors.ink },
        yearLabel: { show: false },
      },
      series: [
        {
          name: 'Bills', type: 'heatmap', coordinateSystem: 'calendar',
          itemStyle: { color: colors.spend },
          data: calendar.days.filter((day) => (day.billCents ?? day.cents) > 0)
            .map((day) => [day.date, day.billCents ?? day.cents]),
        },
        {
          name: 'Salary', type: 'heatmap', coordinateSystem: 'calendar',
          itemStyle: { color: colors.income },
          data: calendar.days.filter((day) => (day.incomeCents ?? 0) > 0)
            .map((day) => [day.date, day.incomeCents]),
        },
        {
          name: 'Today', type: 'heatmap', coordinateSystem: 'calendar', silent: true,
          itemStyle: { color: colors.ink },
          data: calendar.today ? [{
            value: [calendar.today, 0],
            itemStyle: { color: 'transparent', borderColor: colors.ink, borderWidth: 2 },
          }] : [],
        },
      ],
    };
  };
}

export function goalOption(goal) {
  const percent = goal.targetCents ? Math.min(100, Math.round((goal.savedCents / goal.targetCents) * 100)) : 0;
  return (colors) => ({
    ...base(colors),
    tooltip: { ...base(colors).tooltip, trigger: 'item', formatter: `${goal.name}: ${percent}% funded` },
    legend: { show: false },
    series: [{
      name: 'Saved',
      type: 'gauge',
      startAngle: 90,
      endAngle: -270,
      radius: '92%',
      pointer: { show: false },
      progress: { show: true, roundCap: true, width: 10, itemStyle: { color: colors.accent } },
      axisLine: { lineStyle: { width: 10, color: [[1, colors.line]] } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      detail: { valueAnimation: true, formatter: '{value}%', color: colors.ink, fontSize: 18, offsetCenter: [0, 0] },
      data: [{ value: percent }],
    }],
  });
}

export function createChartManager(root) {
  const instances = new Map();
  let specs = new Map();
  const mount = (nextSpecs) => {
    specs = nextSpecs;
    const colors = palette(root);
    for (const [id, instance] of instances) {
      if (!specs.has(id) || !root.querySelector(`[data-echart="${CSS.escape(id)}"]`)) {
        instance.dispose();
        instances.delete(id);
      }
    }
    for (const [id, option] of specs) {
      const host = root.querySelector(`[data-echart="${CSS.escape(id)}"]`);
      if (!host) continue;
      let chart = instances.get(id);
      if (!chart || chart.getDom() !== host) {
        chart?.dispose();
        chart = echarts.init(host, null, { renderer: 'canvas' });
        instances.set(id, chart);
      }
      chart.setOption(option(colors), { notMerge: true });
      chart.resize();
    }
  };
  const resize = () => { for (const chart of instances.values()) chart.resize(); };
  const dispose = () => {
    for (const chart of instances.values()) chart.dispose();
    instances.clear();
    specs = new Map();
  };
  const observer = new MutationObserver(() => mount(specs));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return { mount, resize, dispose };
}
