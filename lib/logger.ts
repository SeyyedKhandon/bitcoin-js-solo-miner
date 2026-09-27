type LogLevel = 'info' | 'debug' | 'warn' | 'error';

export const Logger = {
  log(level: LogLevel, msg: string): void {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${time}] [${level.toUpperCase()}] ${msg}`);
  },
  info(msg: string): void { Logger.log('info', msg); },
  debug(msg: string): void { Logger.log('debug', msg); },
  warn(msg: string): void { Logger.log('warn', msg); },
  error(msg: string): void { Logger.log('error', msg); },
};
