import { execFile } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readFileSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 自包含路径解析；不加载 Electron、Agent Service 或仓库路径别名。 */
export function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (/^~[/\\]/.test(value)) return join(homedir(), value.slice(2))
  return resolve(value)
}

/** 有界只读文件协议；拒绝特殊文件和直接软链，不写实例目录。 */
export function readBoundedText(path: string, limit = 65536): string {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('实例元数据必须是普通文件')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!fstatSync(fd).isFile()) throw new Error('实例元数据不是普通文件')
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size <= limit) {
      const read = readSync(fd, buffer, size, buffer.length - size, null)
      if (!read) break
      size += read
    }
    if (size > limit) throw new Error(`实例元数据超过 ${limit} 字节`)
    return buffer.subarray(0, size).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export type ProcessIdentities = Map<number, string>

/** 查询已有 PID 的启动时间，不枚举命令行，不发终止信号。Windows 一次查询一批 PID。 */
export async function readProcessIdentities(pids: number[], signal: AbortSignal): Promise<ProcessIdentities> {
  const ids = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647)
  const result: ProcessIdentities = new Map()
  if (ids.length === 0) return result
  signal.throwIfAborted()
  if (process.platform === 'linux') {
    for (const pid of ids) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const fields = stat
          .slice(stat.lastIndexOf(')') + 2)
          .trim()
          .split(/\s+/)
        if (fields[0] !== 'Z' && /^\d+$/.test(fields[19] ?? '')) result.set(pid, `linux:${fields[19]}`)
      } catch {
        /* 已退出或不可读，失败关闭。 */
      }
    }
    return result
  }
  let executable: string
  let args: string[]
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    if (!isAbsolute(root)) throw new Error('SystemRoot 必须是绝对路径')
    executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { @{pid=$_.Id; start=$_.StartTime.ToUniversalTime().Ticks.ToString()} } catch {} }) | ConvertTo-Json -Compress`,
    ]
  } else if (process.platform === 'darwin') {
    executable = '/bin/ps'
    args = ['-o', 'pid=,lstart=', '-p', ids.join(',')]
  } else return result
  try {
    const stdout = await new Promise<string>((done, reject) => {
      execFile(
        executable,
        args,
        {
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 65536,
          windowsHide: true,
          signal,
          env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        },
        (error, output) => (error ? reject(error) : done(output))
      )
    })
    if (process.platform === 'win32') {
      const parsed: unknown = JSON.parse(stdout.trim() || '[]')
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item && ids.includes(item.pid) && typeof item.start === 'string' && /^\d+$/.test(item.start)) {
          result.set(item.pid, `win32:${item.start}`)
        }
      }
    } else {
      for (const line of stdout.trim().split('\n')) {
        const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
        if (match && ids.includes(Number(match[1]))) result.set(Number(match[1]), `darwin:${match[2]}`)
      }
    }
  } catch {
    /* 权限不足、超时或进程退出，不以 PID 存在冒充身份匹配。 */
  }
  signal.throwIfAborted()
  return result
}

export function sameLinuxScope(boot: unknown, namespace: unknown): boolean {
  if (process.platform !== 'linux') return true
  try {
    return (
      boot === readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() &&
      namespace === readlinkSync('/proc/self/ns/pid')
    )
  } catch {
    return false
  }
}
