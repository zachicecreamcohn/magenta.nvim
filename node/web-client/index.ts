import {
  Binder,
  cls,
  mountStyle,
  type Ref,
  ref,
  sanitize,
  type View,
} from "./vamp.js";

type Action = { type: "send"; text: string } | { type: "abort" };

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
  input: string;
};

type Msg =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "connection"; open: boolean }
  | { type: "input"; text: string }
  | { type: "send" }
  | { type: "abort" };

function initialState(): State {
  return {
    connected: false,
    chatText: "",
    status: { running: false },
    input: "",
  };
}

function postAction(action: Action): void {
  fetch("/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  }).catch((err) => {
    console.error("failed to POST /action", err);
  });
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
    case "input":
      state.input = msg.text;
      break;
    case "send": {
      const text = state.input.trim();
      if (!text) break;
      postAction({ type: "send", text });
      state.input = "";
      break;
    }
    case "abort":
      postAction({ type: "abort" });
      break;
  }
}

const rootClass = cls("root");
const statusClass = cls("status");
const chatClass = cls("chat");
const inputRowClass = cls("inputRow");
const textareaClass = cls("textarea");
const sendButtonClass = cls("sendButton");
const abortButtonClass = cls("abortButton");

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
.${inputRowClass} {
  flex: 0 0 auto;
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem;
  border-top: 1px solid #333;
  background: #1a1a1a;
}
.${textareaClass} {
  flex: 1 1 auto;
  resize: none;
  min-height: 2.5rem;
  max-height: 8rem;
  padding: 0.5rem;
  font: inherit;
  border: 1px solid #444;
  border-radius: 4px;
  background: #111;
  color: #eee;
}
.${sendButtonClass} {
  flex: 0 0 auto;
  padding: 0 1rem;
  font: inherit;
  border: none;
  border-radius: 4px;
  background: #b048b0;
  color: #fff;
}
.${sendButtonClass}:disabled {
  background: #444;
  color: #888;
}
.${abortButtonClass} {
  flex: 0 0 auto;
  padding: 0 1rem;
  font: inherit;
  border: none;
  border-radius: 4px;
  background: #b04848;
  color: #fff;
}
`);

class RootView implements View<State, Msg> {
  container: HTMLElement;
  private b: Binder<State>;
  private chatRef: Ref;

  private inputRef: Ref;

  constructor(
    container: HTMLElement,
    dispatch: (msg: Msg) => void,
    initialState: State,
  ) {
    this.container = container;

    const statusRef = ref("status");
    const chatRef = ref("chat");
    const inputRef = ref("input");
    const sendRef = ref("send");
    const abortRef = ref("abort");
    this.chatRef = chatRef;
    this.inputRef = inputRef;

    container.innerHTML = sanitize`
      <div class="${rootClass}">
        <div class="${statusClass}" data-ref="${statusRef}"></div>
        <pre class="${chatClass}" data-ref="${chatRef}"></pre>
        <div class="${inputRowClass}">
          <textarea class="${textareaClass}" data-ref="${inputRef}" placeholder="Send a message..."></textarea>
          <button class="${abortButtonClass}" data-ref="${abortRef}">Abort</button>
          <button class="${sendButtonClass}" data-ref="${sendRef}">Send</button>
        </div>
      </div>
    `;

    this.b = new Binder(container, initialState);
    this.b.bindText(statusRef, (s) =>
      s.connected ? "connected" : "disconnected",
    );
    this.b.bindText(chatRef, (s) => s.chatText);
    this.b.bindDisabled(sendRef, (s) => s.input.trim().length === 0);

    const textarea = this.b.ref<HTMLTextAreaElement>(inputRef);
    textarea.addEventListener("input", () => {
      dispatch({ type: "input", text: textarea.value });
    });
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      // Enter sends; Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "send" });
      }
    });
    this.b.ref(sendRef).addEventListener("click", () => {
      dispatch({ type: "send" });
    });
    this.b.bindVisible(abortRef, (s) => s.status.running);
    this.b.ref(abortRef).addEventListener("click", () => {
      dispatch({ type: "abort" });
    });
  }

  sync(state: State): void {
    const chat = this.b.ref(this.chatRef);
    const textarea = this.b.ref<HTMLTextAreaElement>(this.inputRef);
    // Keep the textarea DOM in sync with state (e.g. cleared after send).
    if (textarea.value !== state.input) {
      textarea.value = state.input;
    }

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
