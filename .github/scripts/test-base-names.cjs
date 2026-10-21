const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
for (const file of ['render-glb.mjs', 'render-template.html']) {
  const source = fs.readFileSync(`${__dirname}/${file}`, 'utf8');
  const lists = [...source.matchAll(/(?:const\s+)(?:BASE_NAME_PATTERNS|PART_BASE_PATTERNS|BASE_PATTERNS|patterns)\s*=\s*(\[[\s\S]*?\]);/g)];
  assert.ok(lists.length > 0);
  for (const [, expression] of lists) {
    const patterns = vm.runInNewContext(expression);
    for (const name of ['base', '60_base', '323_03_baseTC', '323_03_baseTC.001', '323_03_BaseTC']) {
      assert.ok(patterns.some((p) => p.test(name)), `${file}: must recognize ${name}`);
    }
    for (const name of ['baseball', 'databases', '323_03_06']) {
      assert.ok(!patterns.some((p) => p.test(name)), `${file}: must keep ${name}`);
    }
  }
}
console.log('GitHub base names: passed');
