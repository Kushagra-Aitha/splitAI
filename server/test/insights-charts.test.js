import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarOption, cashFlowOption, recurringOption } from '../../src/features/insights/charts.js';

globalThis.matchMedia ??= () => ({ matches: false });
const colors = {
  ink: '#111111', muted: '#666666', line: '#dddddd', paper: '#ffffff',
  income: '#33775b', spend: '#c86358', accent: '#225440', soft: '#eef2ef',
};

test('chart legends use one square, top-aligned layout and scroll for many series', () => {
  const flow = cashFlowOption([])(colors);
  assert.equal(flow.legend.icon, 'rect');
  assert.equal(flow.legend.top, 0);
  assert.equal(flow.legend.type, 'plain');

  const recurring = recurringOption(['2026-11'], Array.from({ length: 6 }, (_, index) => ({
    month: '2026-11', name: `Bill ${index}`, cents: 100,
  })))(colors);
  assert.equal(recurring.legend.icon, 'rect');
  assert.equal(recurring.legend.type, 'scroll');
  assert.equal(recurring.legend.data.length, 6);
  assert.ok(recurring.grid.top >= 58);
});

test('calendar keeps small bills visible and lists each item in its tooltip', () => {
  const option = calendarOption({
    from: '2026-11-15', to: '2027-02-13', today: '2026-11-15',
    days: [{
      date: '2026-11-15', cents: 300069, billCents: 69, incomeCents: 300000, count: 2,
      items: [
        { name: 'SGI', cents: 69, direction: 'debit' },
        { name: 'Acme', cents: 300000, direction: 'credit' },
      ],
    }],
  })(colors);
  assert.deepEqual(option.legend.data, ['Bills', 'Salary', 'Today']);
  assert.deepEqual(option.series[0].data, [['2026-11-15', 69]]);
  assert.deepEqual(option.series[1].data, [['2026-11-15', 300000]]);
  assert.equal(option.series[2].data[0].value[0], '2026-11-15');
  const tooltip = option.tooltip.formatter({ value: ['2026-11-15', 69] });
  assert.match(tooltip, /SGI · −\$0\.69/);
  assert.match(tooltip, /Acme · \+\$3,000/);
});
