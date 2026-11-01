type Level = 'info' | 'warn' | 'error'

function stamp(): string {
  return new Date().toISOString().slice(11, 23)
}

export function log(level: Level, scope: string, ...args: unknown[]): void {
  const line = `${stamp()} [${level}] [${scope}]`
  if (level === 'error') console.error(line, ...args)
  else if (level === 'warn') console.warn(line, ...args)
  else console.log(line, ...args)
}

export const logger = {
  info: (scope: string, ...a: unknown[]) => log('info', scope, ...a),
  warn: (scope: string, ...a: unknown[]) => log('warn', scope, ...a),
  error: (scope: string, ...a: unknown[]) => log('error', scope, ...a)
}
