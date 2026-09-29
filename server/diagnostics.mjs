import fs from 'node:fs';
import path from 'node:path';

export function errorDetails(error) {
  return { name: error?.name, code: error?.code, stack: String(error?.stack || '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 12).join('\n') };
}

export function createLogger(dataDir) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  return (event, fields = {}) => {
    const line = JSON.stringify({ time: new Date().toISOString(), event, pid: process.pid, ...fields }) + '\n';
    try {
      if (fs.existsSync(file) && fs.statSync(file).size >= 4_000_000) {
        fs.rmSync(file + '.3', { force: true });
        for (let n = 2; n >= 1; n--) if (fs.existsSync(file + '.' + n)) fs.renameSync(file + '.' + n, file + '.' + (n + 1));
        fs.renameSync(file, file + '.1');
      }
      fs.appendFileSync(file, line);
    } catch { process.stderr.write('{"event":"log_write_failed"}\n'); }
    process.stdout.write(line);
  };
}
