async function sleep(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}

export default { sleep };
