import express from 'express';
import steam, { LogonOptions } from 'steam';
import crypto from 'crypto';
import morgan from 'morgan';
import config from 'config';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config({ path: config.get('env') });

/* eslint-disable import/first */
import redis, { MATCH_DETAILS_KEY_PREFIX } from './redis-database';
import Dota2GCClient from './dota2-gc-client';
import logger from './logger';
import { TaskResultStatus } from './queue';

let dotaClient: Dota2GCClient | null = null;

const PORT = config.get<number>('server.port');
const app = express();

const stream: morgan.StreamOptions = { write: (str: string) => logger.http(str.trimRight()) };
app.use(morgan(':method :url - :status (:response-time ms)', { stream }));
app.set('etag', false);

app.get('/api/matches/:matchId', async (req, res) => {
  const matchId = Number(req.params.matchId);

  if (Number.isNaN(matchId) || matchId < 0) {
    return res.status(400).send({ error: 'Invalid match ID' });
  }

  // Check if the match details are alreay cached in Redis
  const key = `${MATCH_DETAILS_KEY_PREFIX}${matchId}`;
  if (await redis.exists(key)) {
    logger.info(`Serving cached match details for ${matchId}`);
    return res.send({
      status: TaskResultStatus.SUCCESS,
      details: JSON.parse(await redis.jsonGet(key)),
    });
  }

  logger.info(`No cached match detailed for ${matchId}`);

  // Request match details from the GC, with a 3s timeout
  if (dotaClient === null) {
    return res.status(500).send({ status: TaskResultStatus.ERROR, message: 'Dota GC client unavailable' });
  }

  const result = await dotaClient.enqueueTask({
    type: 'match_details',
    match_id: matchId,
  }, 3000);

  if (result.status === TaskResultStatus.TIME_OUT) {
    return res.send({ status: result.status, message: 'No result in time' });
  }
  if (result.status === TaskResultStatus.SUCCESS) {
    return res.send({ status: result.status, details: result.data });
  }

  return res.send({ status: result.status });
});


app.listen(PORT, async () => {
  logger.info(`Running dota-gc-server on port ${PORT}`);

  // Check Redis connection and ensure ReJSON module is installed
  const redisModules = await redis.getModules();
  if (!redisModules.includes('ReJSON')) {
    logger.error('Redis server missing required module ReJSON');
    process.exit();
    return;
  }

  const steamClient = new steam.SteamClient();
  const steamUser = new steam.SteamUser(steamClient);

  const logOnOptions: LogonOptions = {
    account_name: process.env.STEAM_USER_NAME!,
    password: process.env.STEAM_USER_PASSWORD!,
  };

  try {
    logOnOptions.sha_sentryfile = fs.readFileSync('sentry');
  } catch (err) {
    logger.error(`Cannot load the sentry file: ${err}`);
    process.exit();
    return;
  }

  // Helper function for scheduling log on attempts
  // Should be used when Steam disconnects our client, such as during server maintenance
  let logOnTimer: NodeJS.Timeout | undefined;
  function scheduleLogOn(delay: number) {
    logger.info(`Scheduling Steam log on in ${delay}ms`);

    if (logOnTimer) {
      clearTimeout(logOnTimer);
    }
    logOnTimer = setTimeout(() => {
      if (steamClient.connected) {
        steamUser.logOn(logOnOptions);
      } else {
        steamClient.connect();
      }
    }, delay);
  }

  steamClient.connect();
  steamClient.on('connected', () => {
    logger.info('Steam client connected. Attempting login...');
    steamUser.logOn(logOnOptions);
  });

  steamClient.on('servers', (servers) => {
    logger.debug('Steam recieved servers');
    fs.writeFileSync(config.get('steam-servers-file'), servers, 'utf8');
  });

  steamClient.on('error', (error) => {
    logger.error('Steam error recieved ', error);

    if (dotaClient) {
      dotaClient.exit();
      dotaClient = null;
    }

    scheduleLogOn(10000);
  });

  steamClient.on('loggedOff', (result) => {
    switch (result) {
      case steam.EResult.LogonSessionReplaced: {
        logger.error('Logged off - this account is already logged in elsewhere');
        process.exit();
        break;
      }
      default: {
        logger.info(`Steam client logged out: ${result}`);
        scheduleLogOn(10000);
      }
    }
  });

  steamClient.on('logOnResponse', (response) => {
    switch (response.eresult) {
      // Login was successful
      case steam.EResult.OK: {
        logger.info('Steam log on successful');
        dotaClient = new Dota2GCClient(steamClient);
        dotaClient.launch();
        break;
      }

      // Occurs when the Steam login server is unavailable, such as during Tuesday maintenance
      case steam.EResult.ServiceUnavailable: {
        logger.warn('Service unavailable - Steam is currently down');
        scheduleLogOn(10000);
        break;
      }

      default:
        logger.error(`Steam login failed: ${response.eresult}`);
    }
  });

  steamUser.on('updateMachineAuth', (sentry, callback) => {
    logger.debug('Steam requesting updateMachineAuth');

    const hashedSentry = crypto.createHash('sha1').update(sentry.bytes).digest();
    fs.writeFileSync('sentry', hashedSentry);
    callback({ sha_file: hashedSentry });
  });
});
