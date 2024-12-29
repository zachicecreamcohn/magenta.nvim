export class IdCounter {
  private counter: number = 1;
  constructor(private prefix: string) {}

  get() {
    const id = this.prefix + this.counter;
    this.counter += 1;
    return id;
  }
}
