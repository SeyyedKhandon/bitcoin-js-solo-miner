export const Logger = {
  log(level, msg) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${time}] [${level.toUpperCase()}] ${msg}`);
  },
  info(msg) { Logger.log('info', msg); },
  debug(msg) { Logger.log('debug', msg); },
  warn(msg) { Logger.log('warn', msg); },
  error(msg) { Logger.log('error', msg); },
};
