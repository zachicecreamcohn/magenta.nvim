import {
  Binder,
  cls,
  mountStyle,
  type Ref,
  ref,
  sanitize,
  type View,
} from "./vamp.js";

type Status = {
  running: boolean;
};

type Snapshot = {
  chatText: string;
  status: Status;
};

type State = {
  connected: boolean;
  chatText: string;
  status: Status;
};

type Msg =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "connection"; open: boolean };

function initialState(): State {
  return {
    connected: false,
    chatText: "",
    status: { running: false },
  };
}

function update(state: State, msg: Msg): void {
  switch (msg.type) {
    case "snapshot":
      state.chatText = msg.snapshot.chatText;
      state.status = msg.snapshot.status;
      break;
    case "connection":
      state.connected = msg.open;
      break;
  }
}

const rootClass = cls("root");
const statusClass = cls("status");
const chatClass = cls("chat");

mountStyle(`
html, body { margin: 0; height: 100%; }
.${rootClass} {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
}
.${statusClass} {
  flex: 0 0 auto;
  padding: 0.25rem 0.75rem;
  background: #222;
  color: #ccc;
}
.${chatClass} {
  flex: 1 1 auto;
  overflow-y: auto;
  margin: 0;
  padding: 0.75rem;
  white-space: pre-wrap;
  word-break: break-word;
  -webkit-overflow-scrolling: touch;
}
`);

class RootView implements View<State, Msg> {
  container: HTMLElement;
  private b: Binder<State>;
  private chatRef: Ref;

  constructor(
    container: HTMLElement,
    _dispatch: (msg: Msg) => void,
    initialState: State,
  ) {
    this.container = container;

    const statusRef = ref("status");
    const chatRef = ref("chat");
    this.chatRef = chatRef;

    container.innerHTML = sanitize`
      <div class="${rootClass}">
        <div class="${statusClass}" data-ref="${statusRef}"></div>
        <pre class="${chatClass}" data-ref="${chatRef}"></pre>
      </div>
    `;

    this.b = new Binder(container, initialState);
    this.b.bindText(statusRef, (s) =>
      s.connected ? "connected" : "disconnected",
    );
    this.b.bindText(chatRef, (s) => s.chatText);
  }

  sync(state: State): void {
    const chat = this.b.ref(this.chatRef);

    // Only stick to the bottom if the user is already near it, so scrolling up
    // to read earlier output doesn't get yanked back down on new content.
    const nearBottom =
      chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;

    this.b.sync(state);

    if (nearBottom) {
      chat.scrollTop = chat.scrollHeight;
    }
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

function mount(container: HTMLElement): void {
  const state = initialState();

  let dispatching = false;
  function dispatch(msg: Msg): void {
    if (dispatching) throw new Error("dispatch-in-dispatch");
    dispatching = true;
    update(state, msg);
    view.sync(state);
    dispatching = false;
  }

  const view = new RootView(container, dispatch, state);

  const source = new EventSource("/events");
  source.addEventListener("open", () => {
    dispatch({ type: "connection", open: true });
  });
  source.addEventListener("error", () => {
    // EventSource reconnects automatically; reflect the dropped connection.
    dispatch({ type: "connection", open: false });
  });
  source.addEventListener("message", (event: MessageEvent<string>) => {
    const snapshot = JSON.parse(event.data) as Snapshot;
    dispatch({ type: "snapshot", snapshot });
  });
}

const root = document.getElementById("root");
if (root) {
  mount(root);
}
