import express from 'express';
import steam, { LogonOptions, SteamClient } from 'steam';
import crypto from 'crypto';
import morgan from 'morgan';
import config from 'config';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config({ path: config.get('env') });

import redis, { MATCH_DETAILS_KEY_PREFIX } from './redis-database';
import getDota2Client, { taskQueue } from './dota-client';
import logger from './logger';
import { TaskResultStatus } from './queue';

const PORT = config.get<number>('server.port');

const steamClient = new steam.SteamClient();
const steamUser = new steam.SteamUser(steamClient);
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
    logger.info('Serving cached match details for ' + matchId);
    return res.send({
      status: TaskResultStatus.SUCCESS,
      details: JSON.parse(await redis.jsonGet(key)),
    });
  }

  logger.info('No cached match detailed for ' + matchId);

  // Request match details from the GC, with a 3s timeout
  const result = await taskQueue.enqueue({
    type: 'match_details',
    match_id: matchId
  }, 3000);

  if (result.status === TaskResultStatus.TIME_OUT) {
    return res.send({ status: result.status, message: 'No result in time'});
  }
  else if (result.status === TaskResultStatus.SUCCESS) {
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

  const logOnOptions: LogonOptions = {
    account_name: process.env.STEAM_USER_NAME!,
    password: process.env.STEAM_USER_PASSWORD!,
  }

  try {
    logOnOptions.sha_sentryfile = fs.readFileSync('sentry');
  }
  catch (err){
    logger.error("Cannot load the sentry file " + err);
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
      steamUser.logOn(logOnOptions);
    }, delay);
  }

  steamClient.connect();
  steamClient.on('connected', () => {
    logger.info('Steam client connected. Attempting login...');
    steamUser.logOn(logOnOptions);
  });

  steamClient.on('servers', (servers) => {
    logger.debug(`Steam recieved servers`);
  });

  steamClient.on('error', (error) => {
    logger.error('Steam error recieved', error);
  });

  steamClient.on('loggedOff', (eresult) => {
    logger.info('Steam client logged out: ' + eresult);
    scheduleLogOn(10000);
  });

  steamClient.on('logOnResponse', (response) => {
    if (response.eresult === steam.EResult.OK) {
      logger.info('Steam log on successful');

      const dotaClient = getDota2Client(steamClient);
      dotaClient.launch();
    }
    else if (response.eresult === steam.EResult.ServiceUnavailable) {
      logger.error('Service unavailable - Steam is currently down');
      scheduleLogOn(10000);
    }
    else {
      logger.error('Steam login failed: ' + response.eresult);
    }
  })

  steamUser.on('updateMachineAuth', function(sentry, callback) {
    logger.debug('updateMachineAuth');
    var hashedSentry = crypto.createHash('sha1').update(sentry.bytes).digest();
    fs.writeFileSync('sentry', hashedSentry)
    callback({ sha_file: hashedSentry });
  });
});
