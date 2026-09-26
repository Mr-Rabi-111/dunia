import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_LOCALES, INTERESTS } from '../shared/data.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales');
const load = (code) => JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8'));
const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
const en = load('en');

test('every interest has an English label', () => {
  for (const id of INTERESTS) assert.ok(en[`interest.${id}`], id);
});

for (const [code] of UI_LOCALES) {
  test(`locale ${code}: same keys as English, placeholders preserved, nothing empty`, () => {
    const d = load(code);
    assert.deepEqual(Object.keys(d).sort(), Object.keys(en).sort());
    for (const k of Object.keys(en)) {
      assert.equal(placeholders(d[k]), placeholders(en[k]), `${code} ${k}`);
      assert.ok(String(d[k]).trim().length > 0, `${code} ${k} empty`);
    }
  });
}
