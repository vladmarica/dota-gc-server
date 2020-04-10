import dota2, { Dota2Client } from 'dota2';
import steam from 'steam';
import logger from './logger';
import util from './util';
import TaskQueue, { TaskResultStatus, TaskResult, timer } from './queue';
import redis, { MATCH_DETAILS_KEY_PREFIX } from './redis-database';

const NOT_READY_DELAY_MS = 5000;
const TASK_DELAY_MS = 3000;
const MATCH_DETAILS_TIMEOUT_MS = 10000;

const taskQueue: TaskQueue = new TaskQueue();

let ready = false;
let dotaClient: dota2.Dota2Client | undefined;

function onReady() {
  logger.info('Dota 2 client ready');
  ready = true;
}

function onUnready() {
  logger.warn('Dota 2 client unready');
  ready = false;
}

async function requestMatchDetails(matchId: number): Promise<TaskResult> {
  if (!dotaClient) {
    logger.error('requestMatchDetails called but client not initialized');
    return {
      status: TaskResultStatus.ERROR
    };
  }

  const matchDetailsPromise = new Promise<TaskResult>((resolve, reject) => {
    dotaClient!.requestMatchDetails(matchId, (err, matchData) => {
      if (err) {
        reject(err);
      } else {
        logger.info(`Successfully retrieved details from GC for match ${matchId}`)
        resolve({ status: TaskResultStatus.SUCCESS, data: matchData.match });
      }
    });
  });

  return Promise.race<TaskResult>([timer(MATCH_DETAILS_TIMEOUT_MS), matchDetailsPromise])
}

async function taskRunner() {
  logger.debug('Starting Dota 2 client task runner');
  while (true) {
    if (dotaClient === undefined || !ready) {
      logger.debug('Dota 2 client still not ready');
      await util.sleep(NOT_READY_DELAY_MS);
    } else {
      const taskEntry = taskQueue.deqeueue();
      if (!taskEntry) {
        // logger.info('No tasks to complete');
      } else {
        logger.info(`Running task: ${JSON.stringify( taskEntry.task)}`);

        let result: TaskResult;
        try {
          switch (taskEntry.task.type) {
            case 'match_details': {
              result = await requestMatchDetails(taskEntry.task.match_id);
    
              // Cache match details in Redis
              if (result.status === TaskResultStatus.SUCCESS) {
                await redis.jsonSet(`${MATCH_DETAILS_KEY_PREFIX}${taskEntry.task.match_id}`, result.data);
                logger.info('Cached match details for match ' + taskEntry.task.match_id);
              }

              break;
            }
            default: {
              throw new Error(`Unknown task type: ${taskEntry.task.type}`);
            }
          }
        } catch (err) {
          logger.error(`Task ${JSON.stringify(taskEntry.task)} failed: ${err}`);
          result = { status: TaskResultStatus.ERROR };
        }

        taskEntry.callback(result);
      }
      await util.sleep(TASK_DELAY_MS);
    }
  }
}

export default function getDota2Client(steamClient: steam.SteamClient): dota2.Dota2Client {
  if (!dotaClient) {
    dotaClient = new dota2.Dota2Client(steamClient, true, false);
    dotaClient.Logger = logger;

    dotaClient.on('ready', onReady);
    dotaClient.on('unready', onUnready);
    
    setImmediate(taskRunner);
  }

  return dotaClient;
}

export { taskQueue };