const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGPASSWORD ||= 'pagination-test-only';
const {
  buildPageEnvelope,
  escapeLike,
  parseListQuery,
  parsePageQuery,
  toPositiveInt
} = require('../src/services/pagination');

const resource = {
  primaryKeyColumn: 'u.id',
  defaultSort: 'u.created_at DESC',
  sortable: { createdAt: 'u.created_at' },
  searchable: ['u.name', 'u.email'],
  filters: {
    role: { column: 'u.role', values: ['admin', 'student'] },
    active: { column: 'u.active', type: 'int' }
  }
};

test('page inputs use strict integers, defaults, and bounded limits', () => {
  assert.deepEqual(parsePageQuery({}), {
    page: 1,
    pageSize: 20,
    offset: 0,
    keyword: ''
  });
  assert.deepEqual(parsePageQuery({ page: '-2', pageSize: '1000' }), {
    page: 1,
    pageSize: 100,
    offset: 0,
    keyword: ''
  });
  assert.equal(parsePageQuery({ page: '2junk', pageSize: '2.5' }).page, 1);
  assert.equal(parsePageQuery({ page: '2junk', pageSize: '2.5' }).pageSize, 20);
  assert.equal(toPositiveInt('9007199254740992', 7, 1, 100), 7);
});

test('keywords are trimmed, length-limited, and escaped for literal LIKE search', () => {
  const keyword = `${'x'.repeat(105)}%_!`;
  const parsed = parsePageQuery({ q: `  ${keyword}  ` });

  assert.equal(parsed.keyword.length, 100);
  assert.equal(escapeLike('%_!'), '!%!_!!');
});

test('sort parameters can select only registered columns and always add a stable key', () => {
  const injected = parseListQuery({ sortBy: 'createdAt; DROP TABLE users', sortOrder: 'asc' }, resource);
  const allowed = parseListQuery({ sortBy: 'createdAt', sortOrder: 'asc' }, resource);

  assert.equal(injected.orderSql, 'u.created_at DESC, u.id ASC');
  assert.equal(allowed.orderSql, 'u.created_at ASC, u.id ASC');
});

test('search, filters, and data scope keep values parameterized and ordered', () => {
  const parsed = parseListQuery(
    { q: '%_!', role: 'root', active: '1 OR 1=1' },
    resource,
    { sql: 'u.teacher_id = ?', params: [42] }
  );

  assert.equal(parsed.whereSql, "WHERE (u.name LIKE ? ESCAPE '!' OR u.email LIKE ? ESCAPE '!') AND (u.teacher_id = ?)");
  assert.deepEqual(parsed.params, ['%!%!_!!%', '%!%!_!!%', 42]);
});

test('page envelope reports empty and populated totals consistently', () => {
  assert.deepEqual(buildPageEnvelope([], { page: 1, pageSize: 20, total: 0 }), {
    items: [], page: 1, pageSize: 20, total: 0, totalPages: 0
  });
  assert.deepEqual(buildPageEnvelope([{ id: 1 }], { page: 2, pageSize: 10, total: 21 }), {
    items: [{ id: 1 }], page: 2, pageSize: 10, total: 21, totalPages: 3
  });
});
