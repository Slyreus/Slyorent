export class RefreshQueue {
  private running: Promise<void> | null = null;
  private again = false;

  run(action: () => Promise<void>, fresh = false): Promise<void> {
    if (this.running) {
      if (fresh) this.again = true;
      return this.running;
    }
    this.running = Promise.resolve().then(async () => {
      do {
        this.again = false;
        await action();
      } while (this.again);
    }).finally(() => { this.running = null; });
    return this.running;
  }
}
