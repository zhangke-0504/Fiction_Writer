import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export class CommandStopError extends Error {}
const shellEnvNames =
  /^(systemroot|windir|path|pathext|comspec|temp|tmp|home|userprofile|appdata|localappdata|programdata|programfiles(?:\(x86\))?|programw6432|processor_architecture|os|number_of_processors|cmdcmdline|homedrive|homepath)$/i;
export async function runCommand(cwd: string, command: string, timeoutMs: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const win = process.platform === 'win32',
    env = Object.fromEntries(Object.entries(process.env).filter(([key]) => shellEnvNames.test(key)));
  const shell = win
    ? join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
    : '/bin/sh';
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; ${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
  const args = win
    ? [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ]
    : ['-c', command];
  const child = spawn(shell, args, {
    cwd,
    env,
    windowsHide: true,
    detached: !win,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const maxBytes = 24_000;
  let remaining = maxBytes,
    truncated = false,
    timedOut = false;
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  const capture = (buffers: Buffer[]) => (data: Buffer) => {
    const size = Math.min(remaining, data.length);
    if (size) buffers.push(data.subarray(0, size));
    remaining -= size;
    truncated ||= size < data.length;
  };
  child.stdout.on('data', capture(stdout));
  child.stderr.on('data', capture(stderr));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
  let stopping: Promise<void> | undefined;
  const terminate = () => {
    stopping ??= (async () => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (!win) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            throw new CommandStopError('无法停止命令进程组');
        }
      } else {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new CommandStopError('命令主进程已退出，无法确认其子进程已停止');
        await new Promise<void>((resolve, reject) => {
          const kill = spawn(
            join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore' },
          );
          const timer = setTimeout(() => {
            kill.kill();
            reject(new CommandStopError('停止命令进程树超时'));
          }, 5000);
          kill.once('error', () => {
            clearTimeout(timer);
            reject(new CommandStopError('无法执行命令进程树清理'));
          });
          kill.once('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new CommandStopError('无法确认命令进程树已停止'));
          });
        });
      }
    })();
    return stopping;
  };
  let drainTimer: NodeJS.Timeout | undefined;
  let rejectStop: (reason: Error) => void;
  const stopFailure = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  const stop = () => {
    drainTimer ??= setTimeout(() => rejectStop(new CommandStopError('进程终止后输出未关闭')), 8000);
    void terminate().catch(rejectStop);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    const result = await Promise.race([closed, stopFailure]);
    await stopping;
    signal.throwIfAborted();
    const decode = (parts: Buffer[]) => new StringDecoder('utf8').end(Buffer.concat(parts));
    return { ...result, timeout: timedOut, truncated, stdout: decode(stdout), stderr: decode(stderr) };
  } catch (error) {
    if (error instanceof CommandStopError) {
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null) child.kill();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(drainTimer);
    signal.removeEventListener('abort', stop);
  }
}
