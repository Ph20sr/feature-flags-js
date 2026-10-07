import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlags, bucket, fnv1a } from '../src/index.js';

const users = Array.from({ length: 20_000 }, (_, i) => `user_${i}`);

test('FNV-1a: valores de referência', () => {
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(fnv1a('foobar'), 0xbf9cf968);
});

test('balde é determinístico e fica entre 0 e 9999', () => {
  assert.equal(bucket('checkout', 'user_1'), bucket('checkout', 'user_1'));
  for (const u of users.slice(0, 500)) {
    const b = bucket('checkout', u);
    assert.ok(b >= 0 && b < 10000);
  }
});

test('rollout atinge a porcentagem configurada (±1,5 ponto)', () => {
  for (const rollout of [5, 25, 50, 90]) {
    const flags = createFlags({ checkout: { rollout } });
    const on = users.filter((u) => flags.isEnabled('checkout', { userId: u })).length / users.length;
    assert.ok(Math.abs(on * 100 - rollout) < 1.5, `rollout ${rollout}%: obtido ${(on * 100).toFixed(2)}%`);
  }
});

test('rollout é monotônico: quem estava em 10% continua em 20%', () => {
  const at = (rollout) => {
    const flags = createFlags({ checkout: { rollout } });
    return new Set(users.filter((u) => flags.isEnabled('checkout', { userId: u })));
  };
  const ten = at(10);
  const twenty = at(20);
  for (const u of ten) assert.ok(twenty.has(u), `${u} saiu ao aumentar o rollout`);
  assert.ok(twenty.size > ten.size);
});

test('flags diferentes sorteiam grupos diferentes (sem sempre os mesmos usuários)', () => {
  const flags = createFlags({ a: { rollout: 10 }, b: { rollout: 10 } });
  const inA = users.filter((u) => flags.isEnabled('a', { userId: u }));
  const inBoth = inA.filter((u) => flags.isEnabled('b', { userId: u })).length;
  assert.ok(inBoth / inA.length < 0.2, 'a sobreposição deve ser perto de 10%, não 100%');
});

test('ordem de decisão: kill switch > janela > bloqueio > permissão > regras > rollout', () => {
  const now = () => new Date('2026-10-07T12:00:00Z');
  const flags = createFlags({
    off: { enabled: false, allow: ['vip'] },
    beta: { rollout: 0, allow: ['vip', 'ana'], deny: ['ana'] },
    pro: { rules: [{ attribute: 'plan', in: ['pro', 'enterprise'] }, { attribute: 'country', equals: 'BR' }] },
    blackFriday: { startsAt: '2026-11-27T03:00:00Z', endsAt: '2026-11-28T03:00:00Z' },
  }, { now });

  assert.equal(flags.isEnabled('off', { userId: 'vip' }), false, 'kill switch vence a lista de permissão');
  assert.equal(flags.isEnabled('beta', { userId: 'vip' }), true);
  assert.equal(flags.isEnabled('beta', { userId: 'ana' }), false, 'bloqueio vence permissão');
  assert.equal(flags.isEnabled('beta', { userId: 'outro' }), false);
  assert.equal(flags.isEnabled('pro', { userId: 'x', attributes: { plan: 'pro', country: 'BR' } }), true);
  assert.equal(flags.isEnabled('pro', { userId: 'x', attributes: { plan: 'basic', country: 'BR' } }), false);
  assert.equal(flags.isEnabled('blackFriday', { userId: 'x' }), false);
  assert.equal(flags.isEnabled('nao-existe', { userId: 'x' }), false);

  assert.deepEqual(flags.explain('beta', { userId: 'ana' }), { enabled: false, reason: 'na lista de bloqueio' });
  assert.equal(flags.explain('blackFriday').reason, 'começa em 2026-11-27T03:00:00Z');
});

test('janela de tempo liga e desliga sozinha', () => {
  let t = '2026-11-27T02:59:59Z';
  const flags = createFlags({ bf: { startsAt: '2026-11-27T03:00:00Z', endsAt: '2026-11-28T03:00:00Z' } }, { now: () => new Date(t) });
  assert.equal(flags.isEnabled('bf', {}), false);
  t = '2026-11-27T03:00:00Z';
  assert.equal(flags.isEnabled('bf', {}), true);
  t = '2026-11-28T03:00:00Z';
  assert.equal(flags.isEnabled('bf', {}), false);
});

test('sem userId, o rollout parcial fica desligado (não sorteia no escuro)', () => {
  const flags = createFlags({ a: { rollout: 50 }, b: { rollout: 100 } });
  assert.equal(flags.explain('a', {}).reason, 'sem userId para o rollout gradual');
  assert.equal(flags.isEnabled('b', {}), true);
});

test('A/B: variantes estáveis e na proporção dos pesos', () => {
  const flags = createFlags({ precos: { variants: { controle: 50, desconto10: 30, frete_gratis: 20 } } });
  const counts = { controle: 0, desconto10: 0, frete_gratis: 0 };
  for (const u of users) counts[flags.variant('precos', { userId: u })]++;
  assert.ok(Math.abs(counts.controle / users.length - 0.5) < 0.02);
  assert.ok(Math.abs(counts.desconto10 / users.length - 0.3) < 0.02);
  assert.ok(Math.abs(counts.frete_gratis / users.length - 0.2) < 0.02);
  assert.equal(flags.variant('precos', { userId: 'user_7' }), flags.variant('precos', { userId: 'user_7' }));

  const gated = createFlags({ teste: { rollout: 0, variants: { a: 1, b: 1 } } });
  assert.equal(gated.variant('teste', { userId: 'u' }), null, 'fora da flag, sem variante');
});

test('evaluateAll para mandar ao front-end', () => {
  const flags = createFlags({ chat: { rollout: 100 }, beta: { enabled: false }, layout: { variants: { novo: 1 } } });
  assert.deepEqual(flags.evaluateAll({ userId: 'u1' }), { chat: true, beta: false, layout: 'novo' });
});

test('configuração inválida falha na criação', () => {
  assert.throws(() => createFlags({ x: { rollout: 120 } }), RangeError);
  assert.throws(() => createFlags({ x: { variants: { a: 0 } } }), RangeError);
  assert.throws(() => createFlags({ x: { rules: [{ attribute: 'plan' }] } }), TypeError);
});
