// Command-line mode: call tools without an MCP client (CI, scripts, agents without MCP support).
//
//   asus-ipmi-mcp tools                                   list tools
//   asus-ipmi-mcp call <host> <tool> ['<json args>'] [--out file]
//   asus-ipmi-mcp run  <host> <steps.json|-> [--out-dir dir] [--keep-going]
//
// Same credentials (login tokens or ASUS_IPMI_PASSWORD) as the server.
// `run` executes all steps in ONE process, so the KVM connection, screen_ids and the
// firmware confirm_token carry over. Step args may reference earlier results:
//   "$prev.confirm_token"   field of the previous step's JSON result
//   "$steps.<n>.<path>"     field of step n (0-based), or "$steps.<id>.<path>" for a step with "id"
// A string that is exactly one reference is replaced by the value (any type).
// stdout: one JSON line per step: {step, tool, ok, result, images:[paths]}; logs go to stderr.
// Exit code: 0 all ok, 1 a step failed, 2 usage error.
import fs from 'node:fs';
import path from 'node:path';
import { createTools, flagsFromEnv, bmcFromEnv } from './tools.js';

const usage = `usage:
  asus-ipmi-mcp tools
  asus-ipmi-mcp call <host> <tool> ['<json args>'] [--out <file>]
  asus-ipmi-mcp run  <host> <steps.json | -> [--out-dir <dir>] [--keep-going]
steps.json: [{"tool": "screenshot", "args": {...}, "id": "optional"}, ...]; args may use "$prev.<field>" / "$steps.<n|id>.<field>".
Images are written to files (default: current directory), never printed as base64.`;

class UsageError extends Error {}

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`);
  argv.splice(i, 2);
  return v;
}
function flag(argv, name) { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; }

const getPath = (obj, p) => p.split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Replace "$prev.x" / "$steps.n.x" references inside args (deep). Unknown reference = error. */
export function resolveRefs(value, results) {
  if (typeof value === 'string') {
    const m = value.match(/^\$(prev|steps)((?:\.[\w-]+)*)$/);
    if (!m) return value;
    let base, rest = m[2].slice(1);
    if (m[1] === 'prev') base = results[results.length - 1];
    else {
      const [key, ...r] = rest.split('.'); rest = r.join('.');
      base = /^\d+$/.test(key) ? results[+key] : results.find((x) => x.id === key);
    }
    if (!base) throw new Error(`reference ${value}: no such step result`);
    const v = rest ? getPath(base.value, rest) : base.value;
    if (v === undefined) throw new Error(`reference ${value}: field not found in that step's result`);
    return v;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, results)]));
  return value;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Turn an MCP result into {ok, result, images}. Images go to files. */
function materialize(res, { out, outDir, prefix }) {
  const images = [];
  const texts = [];
  let n = 0;
  for (const c of res.content || []) {
    if (c.type === 'image') {
      const ext = EXT[c.mimeType] || 'bin';
      let file = out && n === 0 ? out : path.join(outDir || '.', `${prefix}${n ? `-${n}` : ''}.${ext}`);
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, Buffer.from(c.data, 'base64'));
      images.push(file); n++;
    } else if (c.type === 'text') texts.push(c.text);
  }
  const parsed = texts.map((t) => { try { return JSON.parse(t); } catch { return t; } });
  let result = parsed.length === 1 ? parsed[0] : parsed;
  if (res.isError && typeof result === 'string') result = result.replace(/^Error: /, '');
  return { ok: !res.isError, result, images };
}

async function validateArgs(tool, args) {
  const { z } = await import('zod');
  const r = z.object(tool.inputSchema).strict().safeParse(args || {});
  if (!r.success) throw new Error(`invalid args for ${tool.name}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return r.data;
}

export async function runSteps({ host, steps, outDir, out, keepGoing = false, write = (o) => process.stdout.write(JSON.stringify(o) + '\n'), env = process.env, bmc = null, log }) {
  const flags = flagsFromEnv(env);
  const { tools, close } = createTools({ bmc: bmc || bmcFromEnv(host, env), flags, log: log || ((m) => process.stderr.write(`[asus-ipmi-mcp] ${m}\n`)) });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const results = [];
  let failed = 0;
  try {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const stepNo = i;
      let line;
      try {
        if (!s || typeof s.tool !== 'string') throw new Error('step needs {"tool": "<name>", "args": {...}}');
        const tool = byName.get(s.tool);
        if (!tool) throw new Error(`unknown tool "${s.tool}" (list them with: asus-ipmi-mcp tools)`);
        const args = await validateArgs(tool, resolveRefs(s.args || {}, results));
        const res = await tool.handler(args);
        const m = materialize(res, { out: steps.length === 1 ? out : null, outDir, prefix: `step${String(stepNo).padStart(2, '0')}-${s.tool}` });
        line = { step: stepNo, ...(s.id ? { id: s.id } : {}), tool: s.tool, ...m };
      } catch (e) {
        line = { step: stepNo, ...(s?.id ? { id: s.id } : {}), tool: s?.tool, ok: false, result: e.message, images: [] };
      }
      results.push({ id: s?.id, value: line.result });
      write(line);
      if (!line.ok) { failed++; if (!keepGoing) break; }
    }
  } finally {
    await close();
  }
  return { failed, results };
}

export async function cli(argv) {
  argv = [...argv];
  const cmd = argv.shift();
  try {
    if (cmd === 'tools') {
      const { createTools: ct } = await import('./tools.js');
      const fake = { host: 'x', tokenMode: true, origin: 'https://x', logout: async () => {} };
      const { tools } = ct({ bmc: fake, flags: flagsFromEnv() });
      for (const t of tools) process.stdout.write(`${t.name.padEnd(24)} ${Object.keys(t.inputSchema).join(', ') || '-'}\n`);
      return 0;
    }
    const out = opt(argv, '--out');
    const outDir = opt(argv, '--out-dir');
    const keepGoing = flag(argv, '--keep-going');
    const [host, a, b, ...extra] = argv;
    if (!host) throw new UsageError('host missing');
    let steps;
    if (cmd === 'call') {
      if (!a) throw new UsageError('tool missing');
      if (extra.length) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
      let args = {};
      if (b !== undefined) { try { args = JSON.parse(b); } catch (e) { throw new UsageError(`args must be JSON: ${e.message}`); } }
      steps = [{ tool: a, args }];
    } else if (cmd === 'run') {
      if (!a) throw new UsageError('steps file missing');
      if (b !== undefined) throw new UsageError(`unexpected arguments: ${[b, ...extra].join(' ')}`);
      const src = a === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(a, 'utf8');
      try { steps = JSON.parse(src); } catch (e) { throw new UsageError(`steps file is not JSON: ${e.message}`); }
      if (!Array.isArray(steps)) throw new UsageError('steps file must contain a JSON array');
    } else throw new UsageError(`unknown command ${cmd}`);
    const { failed } = await runSteps({ host, steps, out, outDir, keepGoing });
    return failed ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`${e.message}\n${usage}\n`); return 2; }
    process.stderr.write(`[asus-ipmi-mcp] ${e.message}\n`);
    return 1;
  }
}
