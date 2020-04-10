import logger from './logger';

export enum TaskResultStatus {
  SUCCESS = 0,
  TIME_OUT = 1,
  ERROR = 3,
}

interface BaseTask {
  type: string;
}

export interface MatchDetailsTask extends BaseTask {
  type: 'match_details';
  match_id: number;
}

export type Task = MatchDetailsTask;

export interface TaskResult {
  status: TaskResultStatus;
  data?: any;
}

interface TaskEntry {
  task: Task;
  callback: (result: TaskResult) => void;
}

export default class TaskQueue {
  private _queue: TaskEntry[] = [];

  async enqueue(task: Task, timeoutMs: number): Promise<TaskResult> {
    const completionPromise = new Promise<TaskResult>((resolve) => {
      logger.debug('A task has been enqueued', task);
      this._queue.unshift({
        task,
        callback: resolve,
      });
    });
    
    return Promise.race<TaskResult>([timer(timeoutMs), completionPromise]);
  }

  deqeueue(): TaskEntry | undefined {
    return this._queue.pop();
  }
}

export async function timer(timeoutMs: number): Promise<TaskResult> {
  return new Promise<TaskResult>((resolve) => 
    setTimeout(() => resolve({ status: TaskResultStatus.TIME_OUT }), timeoutMs));
}
