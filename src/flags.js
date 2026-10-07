// Feature flags sem servidor: liga/desliga, rollout gradual estável,
// listas de permissão/bloqueio, regras por atributo, janela de tempo e A/B.

/** FNV-1a 32 bits: rápido, determinístico e bem distribuído para buckets. */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Balde de 0 a 9999 (granularidade de 0,01%). */
export const bucket = (flagKey, unitId, salt = '') => fnv1a(`${flagKey}:${salt}:${unitId}`) % 10000;

function validate(key, def) {
  if (def.rollout !== undefined && !(def.rollout >= 0 && def.rollout <= 100)) {
    throw new RangeError(`Flag "${key}": rollout deve estar entre 0 e 100`);
  }
  if (def.variants) {
    const weights = Object.values(def.variants);
    if (!weights.length || weights.some((w) => !(w > 0))) throw new RangeError(`Flag "${key}": pesos das variantes devem ser > 0`);
  }
  for (const rule of def.rules ?? []) {
    if (!rule.attribute || !('in' in rule || 'equals' in rule || 'notIn' in rule)) {
      throw new TypeError(`Flag "${key}": regra precisa de attribute e in/notIn/equals`);
    }
  }
}

function matchRule(rule, attributes) {
  const value = attributes?.[rule.attribute];
  if ('equals' in rule) return value === rule.equals;
  if ('in' in rule) return rule.in.includes(value);
  return !rule.notIn.includes(value);
}

/**
 * @param {Record<string, {
 *   enabled?: boolean, rollout?: number, allow?: string[], deny?: string[],
 *   rules?: { attribute: string, in?: any[], notIn?: any[], equals?: any }[],
 *   startsAt?: string, endsAt?: string, variants?: Record<string, number>, salt?: string,
 * }>} definitions
 */
export function createFlags(definitions, { now = () => new Date() } = {}) {
  for (const [key, def] of Object.entries(definitions)) validate(key, def);

  /** Decide e explica o porquê (útil para suporte: "por que o cliente X não vê?"). */
  function explain(key, ctx = {}) {
    const def = definitions[key];
    if (!def) return { enabled: false, reason: 'flag desconhecida' };
    if (def.enabled === false) return { enabled: false, reason: 'desligada (kill switch)' };

    const t = now().getTime();
    if (def.startsAt && t < Date.parse(def.startsAt)) return { enabled: false, reason: `começa em ${def.startsAt}` };
    if (def.endsAt && t >= Date.parse(def.endsAt)) return { enabled: false, reason: `terminou em ${def.endsAt}` };

    const id = ctx.userId ?? ctx.id;
    if (id != null && def.deny?.includes(String(id))) return { enabled: false, reason: 'na lista de bloqueio' };
    if (id != null && def.allow?.includes(String(id))) return { enabled: true, reason: 'na lista de permissão' };

    for (const rule of def.rules ?? []) {
      if (!matchRule(rule, ctx.attributes)) return { enabled: false, reason: `regra não atendida: ${rule.attribute}` };
    }

    const rollout = def.rollout ?? 100;
    if (rollout >= 100) return { enabled: true, reason: 'liberada para todos' };
    if (rollout <= 0) return { enabled: false, reason: 'rollout em 0%' };
    if (id == null) return { enabled: false, reason: 'sem userId para o rollout gradual' };

    const b = bucket(key, String(id), def.salt);
    return b < rollout * 100
      ? { enabled: true, reason: `no rollout de ${rollout}% (balde ${b})` }
      : { enabled: false, reason: `fora do rollout de ${rollout}% (balde ${b})` };
  }

  const isEnabled = (key, ctx) => explain(key, ctx).enabled;

  /**
   * Variante de um teste A/B, estável por usuário. null se a flag não está
   * ativa para ele.
   */
  function variant(key, ctx = {}) {
    const def = definitions[key];
    if (!def?.variants || !isEnabled(key, ctx)) return null;
    const id = ctx.userId ?? ctx.id;
    const entries = Object.entries(def.variants);
    if (id == null) return entries[0][0];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    // Hash separado do rollout: a divisão A/B não depende de quem entrou no rollout
    let point = (bucket(`${key}#variant`, String(id), def.salt) / 10000) * total;
    for (const [name, weight] of entries) {
      if (point < weight) return name;
      point -= weight;
    }
    return entries.at(-1)[0];
  }

  /** Todas as flags para um usuário, prontas para mandar ao front-end. */
  function evaluateAll(ctx = {}) {
    return Object.fromEntries(Object.keys(definitions).map((key) => {
      const def = definitions[key];
      return [key, def.variants ? variant(key, ctx) : isEnabled(key, ctx)];
    }));
  }

  return { isEnabled, variant, explain, evaluateAll };
}
