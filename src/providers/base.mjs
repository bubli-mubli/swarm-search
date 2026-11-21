// Общие утилиты для провайдеров: запуск CLI-процессов и HTTP-запросы к API.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
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
  constructor(message, { provider, cause, stderr, status } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    // HTTP-статус ответа API: по нему рой решает, повторять ли задание на другом провайдере.
    this.status = status;
    this.cause = cause;
    this.stderr = stderr;
  }
}

// Запускает процесс, собирает stdout/stderr, завершает дерево при остановке.
export function runProcess(cmd, args, { input, timeoutMs = 180_000, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError(`${cmd} aborted`, { stderr: '' }));
    const processTag = `SWARM_PROCESS_${randomUUID().replaceAll('-', '')}`;
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, [processTag]: '1' },
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let inputError;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };

    const terminateOwnedProcesses = () => {
      if (child.pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
          killer.on('error', () => child.kill('SIGKILL'));
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        }
      }
      if (process.platform === 'linux') {
        // Метка переживает setsid.
        const tag = `${processTag}=1`;
        try {
          let killed;
          do {
            killed = false;
            for (const pid of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
              try {
                if (!readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(tag)) continue;
                process.kill(Number(pid), 'SIGKILL');
                killed = true;
              } catch { /* exited/inaccessible */ }
            }
          } while (killed); // Повторяем для новых детей.
        } catch { /* no procfs: group only */ }
      }
    };

    const stop = (error) => {
      if (settled) return;
      terminateOwnedProcesses();
      // Освобождаем каналы.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(reject, error);
    };

    const timer = setTimeout(() => stop(new ProviderError(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`, { stderr })), timeoutMs);

    const onAbort = () => {
      stop(new ProviderError(`${cmd} aborted`, { stderr }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') inputError = err;
    });
    child.on('error', (err) => finish(reject, new ProviderError(`failed to start ${cmd}: ${err.message}`, { cause: err })));
    child.on('exit', () => {
      if (settled) return;
      clearTimeout(timer);
      // Основной процесс завершён: убираем потомков, но дочитываем каналы до close.
      terminateOwnedProcesses();
    });
    child.on('close', (code) => {
      if (inputError) finish(reject, new ProviderError(`${cmd} stdin: ${inputError.message}`, { cause: inputError, stderr }));
      else if (code === 0) finish(resolve, { stdout, stderr });
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
      throw new ProviderError(`${provider}: HTTP ${res.status} ${text.slice(0, 500)}`, { provider, status: res.status });
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
