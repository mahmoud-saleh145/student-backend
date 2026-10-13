/**
 * A small in-memory stand-in for the Prisma models the video/attachment code
 * touches. Unlike a jest.fn() that returns canned rows, it EVALUATES the
 * `where` it is given, using Prisma's semantics:
 *
 *   * a key whose value is `undefined` is ignored - exactly like Prisma, which
 *     is how `{ videoId: undefined }` silently becomes "every row";
 *   * `null` matches null;
 *   * operators: equals, in, notIn, not (value, null or nested filter);
 *   * relation filters on the declared relations below;
 *   * AND / OR / NOT.
 *
 * Any operator it does not understand throws, so a test cannot pass by the
 * fake quietly matching everything. Every call is recorded in `calls` with the
 * exact arguments, for assertions on the query shape itself.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

type ModelName = 'lesson' | 'video' | 'lessonVideo' | 'playbackTicket' | 'course';

type Relation =
  | { kind: 'one'; model: ModelName; local: string; foreign: string }
  | { kind: 'many'; model: ModelName; local: string; foreign: string };

const RELATIONS: Record<ModelName, Record<string, Relation>> = {
  lesson: {
    videoLinks: { kind: 'many', model: 'lessonVideo', local: 'id', foreign: 'lessonId' },
    video: { kind: 'one', model: 'video', local: 'id', foreign: 'lessonId' },
    course: { kind: 'one', model: 'course', local: 'courseId', foreign: 'id' },
  },
  video: {
    lessonLinks: { kind: 'many', model: 'lessonVideo', local: 'id', foreign: 'videoId' },
    lesson: { kind: 'one', model: 'lesson', local: 'lessonId', foreign: 'id' },
  },
  lessonVideo: {
    lesson: { kind: 'one', model: 'lesson', local: 'lessonId', foreign: 'id' },
    video: { kind: 'one', model: 'video', local: 'videoId', foreign: 'id' },
  },
  playbackTicket: {},
  course: {},
};

const COMPOSITE_KEYS: Partial<Record<ModelName, Record<string, string[]>>> = {
  lessonVideo: { lessonId_videoId: ['lessonId', 'videoId'] },
};

export type Call = { model: ModelName; op: string; args: Row };

export type Seed = Partial<Record<ModelName, Row[]>>;

const SCALAR_OPS = new Set(['equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte']);

export function createInMemoryPrisma(seed: Seed) {
  const tables: Record<ModelName, Row[]> = {
    lesson: [],
    video: [],
    lessonVideo: [],
    playbackTicket: [],
    course: [],
  };
  for (const [name, rows] of Object.entries(seed) as [ModelName, Row[]][]) {
    tables[name] = rows.map((r) => ({ ...r }));
  }
  const calls: Call[] = [];

  function related(model: ModelName, row: Row, rel: Relation): Row | Row[] | null {
    const matches = tables[rel.model].filter((r) => r[rel.foreign] === row[rel.local]);
    return rel.kind === 'one' ? matches[0] ?? null : matches;
  }

  function scalarMatches(value: unknown, filter: unknown): boolean {
    if (filter === null) return value === null || value === undefined;
    if (filter instanceof Date) return value instanceof Date && value.getTime() === filter.getTime();
    if (typeof filter !== 'object') return value === filter;
    const ops = filter as Record<string, unknown>;
    for (const [op, arg] of Object.entries(ops)) {
      if (arg === undefined) continue;
      if (!SCALAR_OPS.has(op)) throw new Error(`in-memory-prisma: unsupported operator "${op}"`);
      if (op === 'equals' && !scalarMatches(value, arg)) return false;
      if (op === 'in' && !(arg as unknown[]).includes(value)) return false;
      if (op === 'notIn' && (arg as unknown[]).includes(value)) return false;
      if (op === 'not' && scalarMatches(value, arg)) return false;
      if (op === 'lt' && !((value as number) < (arg as number))) return false;
      if (op === 'lte' && !((value as number) <= (arg as number))) return false;
      if (op === 'gt' && !((value as number) > (arg as number))) return false;
      if (op === 'gte' && !((value as number) >= (arg as number))) return false;
    }
    return true;
  }

  function matches(model: ModelName, row: Row, where: Where | undefined): boolean {
    if (!where) return true;
    for (const [key, filter] of Object.entries(where)) {
      if (filter === undefined) continue; // Prisma: undefined means "no filter"
      if (key === 'AND') {
        if (!(filter as Where[]).every((w) => matches(model, row, w))) return false;
        continue;
      }
      if (key === 'OR') {
        if (!(filter as Where[]).some((w) => matches(model, row, w))) return false;
        continue;
      }
      if (key === 'NOT') {
        if (matches(model, row, filter as Where)) return false;
        continue;
      }
      const composite = COMPOSITE_KEYS[model]?.[key];
      if (composite) {
        const parts = filter as Row;
        if (!composite.every((f) => row[f] === parts[f])) return false;
        continue;
      }
      const rel = RELATIONS[model][key];
      if (rel) {
        const target = related(model, row, rel);
        if (rel.kind === 'one') {
          if (filter === null) {
            if (target !== null) return false;
            continue;
          }
          const f = filter as Where;
          const inner = 'is' in f ? (f.is as Where) : f;
          if (!target || !matches(rel.model, target as Row, inner)) return false;
        } else {
          const f = filter as Record<string, Where>;
          const list = target as Row[];
          for (const [q, w] of Object.entries(f)) {
            if (q === 'some' && !list.some((r) => matches(rel.model, r, w))) return false;
            else if (q === 'none' && list.some((r) => matches(rel.model, r, w))) return false;
            else if (q === 'every' && !list.every((r) => matches(rel.model, r, w))) return false;
            else if (!['some', 'none', 'every'].includes(q)) {
              throw new Error(`in-memory-prisma: unsupported list filter "${q}"`);
            }
          }
        }
        continue;
      }
      if (!scalarMatches(row[key], filter)) return false;
    }
    return true;
  }

  function project(model: ModelName, row: Row, args: Row): Row {
    const select = args.select as Row | undefined;
    const include = args.include as Row | undefined;
    const shape = select ?? include;
    const base: Row = select ? {} : { ...row };
    if (!shape) return base;
    for (const [key, spec] of Object.entries(shape)) {
      if (!spec) continue;
      const rel = RELATIONS[model][key];
      if (!rel) {
        if (select) base[key] = row[key];
        continue;
      }
      const nested = spec === true ? {} : (spec as Row);
      const value = related(model, row, rel);
      if (rel.kind === 'one') {
        base[key] = value ? project(rel.model, value as Row, nested) : null;
      } else {
        const list = (value as Row[]).filter((r) => matches(rel.model, r, nested.where as Where));
        base[key] = list.map((r) => project(rel.model, r, nested));
      }
    }
    return base;
  }

  function model(name: ModelName) {
    const record = (op: string, args: Row) => calls.push({ model: name, op, args: structuredCloneSafe(args) });
    return {
      findFirst: async (args: Row = {}) => {
        record('findFirst', args);
        const row = tables[name].find((r) => matches(name, r, args.where as Where));
        return row ? project(name, row, args) : null;
      },
      findUnique: async (args: Row = {}) => {
        record('findUnique', args);
        const row = tables[name].find((r) => matches(name, r, args.where as Where));
        return row ? project(name, row, args) : null;
      },
      findMany: async (args: Row = {}) => {
        record('findMany', args);
        return tables[name].filter((r) => matches(name, r, args.where as Where)).map((r) => project(name, r, args));
      },
      count: async (args: Row = {}) => {
        record('count', args);
        return tables[name].filter((r) => matches(name, r, args.where as Where)).length;
      },
      create: async (args: Row) => {
        record('create', args);
        const row = { ...(args.data as Row) };
        tables[name].push(row);
        return project(name, row, args);
      },
      update: async (args: Row) => {
        record('update', args);
        const row = tables[name].find((r) => matches(name, r, args.where as Where));
        if (!row) throw new Error(`in-memory-prisma: ${name}.update found no row`);
        Object.assign(row, args.data as Row);
        return project(name, row, args);
      },
      updateMany: async (args: Row) => {
        record('updateMany', args);
        const rows = tables[name].filter((r) => matches(name, r, args.where as Where));
        for (const r of rows) Object.assign(r, args.data as Row);
        return { count: rows.length };
      },
      deleteMany: async (args: Row = {}) => {
        record('deleteMany', args);
        const keep = tables[name].filter((r) => !matches(name, r, args.where as Where));
        const count = tables[name].length - keep.length;
        tables[name] = keep;
        return { count };
      },
      upsert: async (args: Row) => {
        record('upsert', args);
        const row = tables[name].find((r) => matches(name, r, args.where as Where));
        if (row) {
          Object.assign(row, args.update as Row);
          return project(name, row, args);
        }
        const created = { ...(args.create as Row) };
        tables[name].push(created);
        return project(name, created, args);
      },
    };
  }

  const prisma = {
    lesson: model('lesson'),
    video: model('video'),
    lessonVideo: model('lessonVideo'),
    playbackTicket: model('playbackTicket'),
    course: model('course'),
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };

  return { prisma, tables, calls };
}

function structuredCloneSafe(v: Row): Row {
  // Dates and undefined must survive so assertions can see them exactly.
  const walk = (x: unknown): unknown => {
    if (x instanceof Date) return new Date(x.getTime());
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.entries(x as Row).map(([k, y]) => [k, walk(y)]));
    }
    return x;
  };
  return walk(v) as Row;
}
