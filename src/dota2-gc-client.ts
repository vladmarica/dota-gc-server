import dota2 from 'dota2';
import steam from 'steam';
import logger from './logger';
import TaskQueue, { TaskResultStatus, TaskResult, timer, Task } from './queue';
import redis, { MATCH_DETAILS_KEY_PREFIX } from './redis-database';

const TASK_DELAY_MS = 3500;
const MATCH_DETAILS_TIMEOUT_MS = 10000;

async function requestMatchDetails(dotaClient: dota2.Dota2Client, matchId: number): Promise<TaskResult> {
  const matchDetailsPromise = new Promise<TaskResult>((resolve, reject) => {
    dotaClient!.requestMatchDetails(matchId, (err, matchData) => {
      if (err) {
        reject(err);
      } else {
        logger.info(`Successfully retrieved details from GC for match ${matchId}`);
        resolve({ status: TaskResultStatus.SUCCESS, data: matchData.match });
      }
    });
  });

  return Promise.race<TaskResult>([
    timer(MATCH_DETAILS_TIMEOUT_MS),
    matchDetailsPromise,
  ]);
}

export default class Dota2GCClient {
  private _dota2Client: dota2.Dota2Client; // Underlying implementation of the Dota 2 client

  private _taskQueue: TaskQueue;

  private _taskQueueWorkerTimeout: NodeJS.Timeout | null;

  private _ready: boolean = false;

  constructor(steamClient: steam.SteamClient) {
    this._taskQueue = new TaskQueue();
    this._dota2Client = new dota2.Dota2Client(steamClient, true, false);
    this._dota2Client.Logger = logger;

    this._dota2Client.on('ready', this.onReady.bind(this));
    this._dota2Client.on('unready', this.onUnready.bind(this));

    this._taskQueueWorkerTimeout = setTimeout(this.taskQueueWorker.bind(this), TASK_DELAY_MS);
  }

  public async enqueueTask(task: Task, timeoutMs: number): Promise<TaskResult> {
    return this._taskQueue.enqueue(task, timeoutMs);
  }

  public exit() {
    logger.info('Exiting Dota 2 client...');
    this._dota2Client.exit();

    if (this._taskQueueWorkerTimeout !== null) {
      clearTimeout(this._taskQueueWorkerTimeout);
      this._taskQueueWorkerTimeout = null;
    }
  }

  public launch() {
    this._dota2Client.launch();
  }

  private async taskQueueWorker() {
    if (!this._ready) {
      logger.debug('Dota 2 client is not ready');
    } else {
      const taskEntry = this._taskQueue.deqeueue();
      if (taskEntry) {
        logger.info(`Running task: ${JSON.stringify(taskEntry.task)}`);

        let result: TaskResult;
        try {
          switch (taskEntry.task.type) {
            case 'match_details': {
              result = await requestMatchDetails(this._dota2Client, taskEntry.task.match_id);

              // Cache match details in Redis
              if (result.status === TaskResultStatus.SUCCESS) {
                await redis.jsonSet(`${MATCH_DETAILS_KEY_PREFIX}${taskEntry.task.match_id}`, result.data);
                logger.info(`Cached match details for match ${taskEntry.task.match_id}`);
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
    }

    // Schedule the next task worker execution
    if (this._taskQueueWorkerTimeout !== null) {
      this._taskQueueWorkerTimeout = setTimeout(this.taskQueueWorker.bind(this), TASK_DELAY_MS);
    }
  }


  private onReady() {
    logger.info('Dota 2 client ready');
    this._ready = true;
  }

  private onUnready() {
    logger.warn('Dota 2 client unready');
    this._ready = false;
  }
}
