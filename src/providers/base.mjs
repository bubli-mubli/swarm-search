// Общие утилиты для провайдеров: запуск CLI-процессов и HTTP-запросы к API.
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter } from 'node:path';

// Проверяет, есть ли исполняемый файл в PATH.
export async function hasBinary(name) {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(`${dir}/${name}`, constants.X_OK);
      return true;
    } catch {
      // ищем дальше
    }
  }
  return false;
}

export class ProviderError extends Error {
  constructor(message, { provider, cause, stderr } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.cause = cause;
    this.stderr = stderr;
  }
}

// Запускает процесс, собирает stdout/stderr, убивает по таймауту.
export function runProcess(cmd, args, { input, timeoutMs = 180_000, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new ProviderError(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`, { stderr }));
    }, timeoutMs);

    const onAbort = () => {
      child.kill('SIGKILL');
      finish(reject, new ProviderError(`${cmd} aborted`, { stderr }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => finish(reject, new ProviderError(`failed to start ${cmd}: ${err.message}`, { cause: err })));
    child.on('close', (code) => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new ProviderError(`${cmd} exited with code ${code}`, { stderr: stderr || stdout }));
    });

    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// POST JSON с таймаутом, возвращает распарсенный ответ или бросает ProviderError.
export async function postJson(url, { headers = {}, body, timeoutMs = 180_000, signal, provider }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ProviderError(`${provider}: HTTP ${res.status} ${text.slice(0, 500)}`, { provider });
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new ProviderError(`${provider}: non-JSON response`, { provider, cause: err });
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`${provider}: ${err.name === 'AbortError' ? 'timed out' : err.message}`, { provider, cause: err });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Склеивает system + prompt для CLI, у которых нет отдельного system-параметра.
export function mergeSystem(system, prompt) {
  return system ? `<instructions>\n${system}\n</instructions>\n\n${prompt}` : prompt;
}
