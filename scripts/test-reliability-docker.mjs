import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

const exec = promisify(execFile);
const docker = async (...args) => (await exec('docker', args, { timeout: 45000, maxBuffer: 2_000_000 })).stdout.trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const name = 'coolzou-check-' + Date.now();
const dir = await mkdtemp(path.join(tmpdir(), name));
const label = 'com.coolzou.test=' + name;
const report = { test: name, accounts: 20, environment: 'local Docker, synthetic data only', failures: [] };
const out = path.resolve('artifacts/reliability');
await mkdir(out, { recursive: true });
let monitor;
let sampling = false;
let sampleTask;
const inspect = async () => JSON.parse(await docker('inspect', name))[0];
async function waitFor(check, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await sleep(500); }
  throw new Error('Timed out waiting for container recovery');
}

try {
  monitor = spawn('python3', ['deploy/watchdog.py'], { env: { ...process.env, COOLZOU_WATCHDOG_LABEL: label, COOLZOU_WATCHDOG_LOG_DIR: dir }, detached: true, stdio: 'ignore' });
  await docker('run', '-d', '--name', name, '--init', '--restart', 'unless-stopped', '--label', label,
    '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '2', '--pids-limit', '128', '--ulimit', 'core=0',
    '-e', 'APP_MODE=demo', '-e', 'AI_MODE=demo', '-e', 'NODE_OPTIONS=--max-old-space-size=768',
    '-p', '127.0.0.1::4317', '-v', name + '-data:/app/var',
    '--health-cmd', 'node -e "fetch(\'http://127.0.0.1:4317/health\',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"',
    '--health-interval', '3s', '--health-timeout', '2s', '--health-retries', '2',
    'coolzou-reliability-test:20260916');
  const port = (await inspect()).NetworkSettings.Ports['4317/tcp'][0].HostPort;
  let base = 'http://127.0.0.1:' + port;
  await waitFor(async () => (await inspect()).State.Health.Status === 'healthy');
  let busy = 0;
  const call = async (route, token, body) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const value = await response.json();
      if ([429, 503].includes(response.status)) { busy++; await sleep(500 + Math.random() * 500); continue; }
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    }
    throw new Error('Retry budget exhausted');
  };
  sampling = true;
  const samples = [];
  sampleTask = (async () => {
    while (sampling) {
      const before = Date.now();
      const health = await fetch(base + '/health', { signal: AbortSignal.timeout(5000) });
      assert.equal(health.status, 200);
      const latencyMs = Date.now() - before;
      const stats = JSON.parse(await docker('stats', '--no-stream', '--format', '{{json .}}', name));
      samples.push({ latencyMs, memory: stats.MemUsage, cpu: stats.CPUPerc });
      await sleep(500);
    }
  })();
  sampleTask.catch(() => {});
  const image = await sharp(randomBytes(1600 * 1000 * 3), { raw: { width: 1600, height: 1000, channels: 3 } }).jpeg({ quality: 65 }).toBuffer();
  assert.ok(image.length <= 1000000);
  const started = Date.now();
  const accounts = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const { token } = await call('/api/session/demo', null, {});
    const photos = [];
    for (let n = 0; n < 3; n++) photos.push((await call('/api/assets', token, { name: 'synthetic.jpg', data: image.toString('base64') })).id);
    const { deck } = await call('/api/decks', token, { title: '合成压测' + i, grade: 3, gender: 'boy', content: Array.from({ length: 20 }, (_, p) => `第${p + 1}页｜合成观察\n这是测试数据。`).join('\n'), photoIds: photos, consent: true, reviewOutline: false });
    await waitFor(async () => {
      const current = (await call('/api/decks/' + deck.id, token)).deck;
      assert.notEqual(current.status, 'failed', current.error);
      return current.status === 'ready';
    });
    const ticket = await call('/api/decks/' + deck.id + '/download?variant=free', token);
    const result = await fetch(base + ticket.url, { headers: { authorization: 'Bearer ' + token } });
    assert.equal(result.status, 200);
    const bytes = await result.arrayBuffer();
    assert.ok(bytes.byteLength <= 5000000);
    return { token, id: deck.id, bytes: bytes.byteLength };
  }));
  const selected = accounts[0];
  const { order } = await call('/api/decks/' + selected.id + '/orders', selected.token, { channel: 'wechat' });
  await call('/api/orders/' + order.id + '/demo-pay', selected.token, { confirm: true });
  await waitFor(async () => {
    const deck = (await call('/api/decks/' + selected.id, selected.token)).deck;
    assert.notEqual(deck.status, 'failed', deck.error);
    return deck.fullReady;
  });
  report.load = { durationMs: Date.now() - started, uploadedPhotos: 60, downloadedDecks: 20, completedFullDecks: 1, backpressureResponses: busy, samples };
  sampling = false;
  await sampleTask;
  console.log('PASS 20 accounts: upload, queue, render, download; one full 20-page deck');

  const signalApp = signal => docker('exec', name, 'node', '-e', `const fs=require('fs');for(const p of fs.readdirSync('/proc')){if(!/^\\d+$/.test(p)||+p===process.pid)continue;try{const cmd=fs.readFileSync('/proc/'+p+'/cmdline','utf8');if(cmd.startsWith('node\\0server/main.mjs'))process.kill(+p,'${signal}');}catch{}}`);
  const oldStart = (await inspect()).State.StartedAt;
  await signalApp('SIGABRT');
  await waitFor(async () => { const c = await inspect(); return c.State.StartedAt !== oldStart && c.State.Health?.Status === 'healthy'; });
  base = 'http://127.0.0.1:' + (await inspect()).NetworkSettings.Ports['4317/tcp'][0].HostPort;
  assert.ok((await inspect()).RestartCount >= 1);
  assert.equal((await call('/api/decks/' + selected.id, selected.token)).deck.fullReady, true);
  report.crashRestart = 'PASS; existing login and generated files preserved';
  console.log('PASS process crash restarted with data preserved');

  const healthyStart = (await inspect()).State.StartedAt;
  await signalApp('SIGSTOP');
  await waitFor(async () => { const c = await inspect(); return c.State.StartedAt !== healthyStart && c.State.Health?.Status === 'healthy'; });
  const watchdog = await readFile(path.join(dir, 'watchdog.jsonl'), 'utf8');
  assert.match(watchdog, /unhealthy_restart/);
  assert.match(watchdog, /"action": "die"/);
  report.hangRestart = 'PASS; external watchdog detected and restarted unhealthy service';
  await writeFile(path.join(out, 'watchdog-test.jsonl'), watchdog);
  console.log('PASS frozen service recovered by watchdog');

  await docker('run', '-d', '--name', name + '-oom', '--label', label, '--memory', '96m', '--memory-swap', '96m',
    '--restart', 'on-failure:1', '--ulimit', 'core=0', 'coolzou-reliability-test:20260916',
    'node', '-e', 'const buffers=[]; setInterval(()=>buffers.push(Buffer.alloc(16*1024*1024,1)),25)');
  await waitFor(async () => {
    const events = await readFile(path.join(dir, 'watchdog.jsonl'), 'utf8');
    return events.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(e => e.action === 'oom' && e.name === name + '-oom');
  });
  await waitFor(async () => JSON.parse(await docker('inspect', name + '-oom'))[0].RestartCount >= 1);
  report.oom = 'PASS; kernel OOM event durably recorded and Docker restarted process';
  await writeFile(path.join(out, 'watchdog-test.jsonl'), await readFile(path.join(dir, 'watchdog.jsonl')));
  console.log('PASS memory exhaustion recorded and restarted');

  await docker('stop', '--time', '25', name);
  await sleep(12000);
  assert.equal((await inspect()).State.Running, false);
  report.manualStop = 'PASS; watchdog respects deliberate stop';
} catch (error) {
  report.failures.push(error.stack);
  process.exitCode = 1;
  console.error(error);
} finally {
  sampling = false;
  if (sampleTask) await sampleTask.catch(() => {});
  if (monitor?.pid) { try { process.kill(-monitor.pid, 'SIGTERM'); } catch {} }
  await docker('rm', '-f', name).catch(() => {});
  await docker('rm', '-fv', name + '-oom').catch(() => {});
  await docker('volume', 'rm', name + '-data').catch(() => {});
  await writeFile(path.join(out, 'docker-report.json'), JSON.stringify(report, null, 2));
  await rm(dir, { recursive: true, force: true });
}
