import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forecastPresentation, newReportSchedule, reportRunLabel, reportScheduleDescription, reportSchedulePayload,
} from '../src/domain/reportAutomation.js';

test('schedule payload keeps supported dimensions and emits cadence-specific fields', () => {
  const draft = { ...newReportSchedule(),name:'  Weekly operations  ',cadence:'weekly',weekday:'1',
    monthDay:19,dimensions:['channel','category','category','unknown'],
    filters:{ channel:'pos',category:' Beverages ',ignored:'secret' },version:3,enabled:true };
  assert.deepEqual(reportSchedulePayload(draft), {
    version:3,name:'Weekly operations',cadence:'weekly',localTime:'08:00',weekday:1,monthDay:null,
    dimensions:['channel','category'],filters:{ channel:'pos',category:'Beverages' },
    historyDays:84,forecastHorizon:14,enabled:true,
  });
  assert.equal(reportScheduleDescription(draft), 'Weekly on Monday at 08:00 MYT');
});

test('run and forecast presentation distinguish completed data from insufficient history', () => {
  assert.equal(reportRunLabel({ status:'completed',period:{ from:'2026-10-01',to:'2026-10-07' } }),
    'Completed · 2026-10-01 to 2026-10-07');
  assert.deepEqual(forecastPresentation({ status:'insufficient_history',sampleSize:12,minimumSampleSize:28 }), {
    ready:false,title:'More history needed',detail:'12 of 28 daily observations available.',points:[],
  });
  const ready = forecastPresentation({ status:'ready',confidence:{ level:'medium' },
    metrics:{ mae:12.345,wape:18.9 },points:[{ date:'2026-10-10',value:100 }] });
  assert.equal(ready.title, 'medium confidence forecast');
  assert.equal(ready.detail, 'Weekday baseline · MAE 12.35 · WAPE 18.90%');
  assert.equal(ready.points.length, 1);
});
