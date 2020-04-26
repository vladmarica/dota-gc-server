import redis from 'redis';
import logger from './logger';

export const MATCH_DETAILS_KEY_PREFIX = 'match-details:';

const client = redis.createClient();

client.on('err', (err) => {
  logger.error('Redis client error: ', err);
});

async function getModules(): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    client.sendCommand('module', ['list'], (err, res: string[][]) => {
      if (err) {
        reject(err);
      } else {
        const moduleList = res.map((moduleInfo) => moduleInfo[1]);
        resolve(moduleList);
      }
    });
  });
}

async function exists(key: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    client.exists(key, (err, res: number) => {
      if (err) {
        reject(err);
      } else {
        resolve(res === 1);
      }
    });
  });
}

async function jsonSet(key: string, object: any): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.sendCommand('json.set', [key, '.', JSON.stringify(object)], (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function jsonGet(key: string): Promise<any> {
  return new Promise<void>((resolve, reject) => {
    client.sendCommand('json.get', [key], (err, res: any) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    });
  });
}

export default {
  client,
  getModules,
  exists,
  jsonSet,
  jsonGet,
};
