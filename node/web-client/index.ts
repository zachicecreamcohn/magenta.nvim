import { Binder, ref, sanitize, type View } from "./vamp.js";

type State = {
  heading: string;
};

type Msg = never;

function initialState(): State {
  return { heading: "magenta remote — hello" };
}

class RootView implements View<State, Msg> {
  container: HTMLElement;
  private b: Binder<State>;

  constructor(
    container: HTMLElement,
    _dispatch: (msg: Msg) => void,
    initialState: State,
  ) {
    this.container = container;

    const headingRef = ref("heading");

    container.innerHTML = sanitize`
      <main>
        <h1 data-ref="${headingRef}"></h1>
      </main>
    `;

    this.b = new Binder(container, initialState);
    this.b.bindText(headingRef, (s) => s.heading);
  }

  sync(state: State): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

function mount(container: HTMLElement): void {
  const state = initialState();

  // The dispatch loop (dispatch → update → sync) is reintroduced in later
  // slices once there are messages to handle. Slice 1 has none.
  const noopDispatch = (_msg: Msg) => {};
  new RootView(container, noopDispatch, state);
}

const root = document.getElementById("root");
if (root) {
  mount(root);
}
