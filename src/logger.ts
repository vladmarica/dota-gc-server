import winston, { createLogger, format } from 'winston';
import TransportStream from 'winston-transport';
import HumioTransport, { HumioError } from 'humio-winston';

const transports: TransportStream[] = [
  new winston.transports.Console({
    format: format.combine(
      format.colorize(),
      format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss',
      }),
      format.printf((info) => {
        const { message, level, timestamp, ...rest } = info;
        return `${timestamp} [${level}] ${message} ${
          Object.keys(rest).length > 0 ? JSON.stringify(rest) : ''}`;
      }),
    ),
  }),
];

const logger = createLogger({ level: 'debug', transports });
const backupLogger = createLogger({ level: 'debug', transports });

if (process.env.NODE_ENV === 'production') {
  const HUMIO_INGEST_TOKEN = process.env.HUMIO_INGEST_TOKEN; // eslint-disable-line
  if (!HUMIO_INGEST_TOKEN) {
    backupLogger.error('Environment variable HUMIO_INGEST_TOKEN must be set in production');
    process.exit();
  }

  logger.add(
    new HumioTransport({
      level: 'info',
      ingestToken: HUMIO_INGEST_TOKEN,
      tags: {
        app: 'dota-gc-server',
      },
      callback: (err?: Error) => {
        if (err) {
          const code = err instanceof HumioError ? `(${(<HumioError> err).code})` : '';
          backupLogger.error(`Failed to send log to Humio: '${err.message} ${code}'`);
        }
      },
    }),
  );
}

export default logger;
