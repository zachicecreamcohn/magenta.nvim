import {
  Binder,
  cls,
  mountStyle,
  noop,
  ref,
  sanitize,
  showKeyed,
  type View,
} from "./vamp.js";

type InstanceEntry = {
  pid: number;
  cwd: string;
  title: string;
  host: string;
  port: number;
  startedAt: number;
  heartbeatAt: number;
};

type InstancesResponse = {
  instances: InstanceEntry[];
  self: number;
};

type State = {
  connected: boolean;
  self: number | undefined;
  instances: InstanceEntry[];
};

type Msg =
  | { type: "instances"; response: InstancesResponse }
  | { type: "connection"; ok: boolean };

const POLL_MS = 3000;

function initialState(): State {
  return { connected: false, self: undefined, instances: [] };
}

function update(state: State, msg: Msg): void {
  switch (msg.type) {
    case "instances":
      state.connected = true;
      state.self = msg.response.self;
      state.instances = msg.response.instances;
      return;
    case "connection":
      state.connected = msg.ok;
      return;
  }
}

const rootClass = cls("root");
const headerClass = cls("header");
const statusClass = cls("status");
const listClass = cls("list");
const rowClass = cls("row");
const rowTitleClass = cls("row-title");
const rowCwdClass = cls("row-cwd");
const rowAddrClass = cls("row-addr");
const selfBadgeClass = cls("self-badge");
const emptyClass = cls("empty");

mountStyle(`
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #111; color: #eee; }
.${rootClass} { max-width: 720px; margin: 0 auto; padding: 1rem; }
.${headerClass} { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.${headerClass} h1 { font-size: 1.1rem; margin: 0; }
.${statusClass} { font-size: 0.8rem; color: #8a8; }
.${statusClass}[data-off="true"] { color: #c66; }
.${listClass} { list-style: none; margin: 1rem 0 0; padding: 0; }
.${rowClass} { display: block; padding: 0.75rem 1rem; margin-bottom: 0.5rem; border: 1px solid #333; border-radius: 8px; text-decoration: none; color: inherit; }
.${rowClass}:active { background: #1c1c1c; }
.${rowTitleClass} { font-weight: 600; }
.${selfBadgeClass} { margin-left: 0.5rem; font-size: 0.7rem; color: #88a; }
.${rowCwdClass} { font-size: 0.8rem; color: #999; word-break: break-all; }
.${rowAddrClass} { font-size: 0.75rem; color: #678; margin-top: 0.25rem; }
.${emptyClass} { color: #888; padding: 1rem; }
@media (min-width: 641px) { .${rootClass} { padding: 1.5rem; } }
`);

class InstanceRowView
  implements View<{ entry: InstanceEntry; self: number | undefined }>
{
  container: HTMLElement;
  private b: Binder<{ entry: InstanceEntry; self: number | undefined }>;

  constructor(
    container: HTMLElement,
    _dispatch: (msg: never) => void,
    initial: { entry: InstanceEntry; self: number | undefined },
  ) {
    this.container = container;
    const titleRef = ref("title");
    const badgeRef = ref("badge");
    const cwdRef = ref("cwd");
    const addrRef = ref("addr");

    container.innerHTML = sanitize`
      <a class="${rowClass}">
        <div><span class="${rowTitleClass}" data-ref="${titleRef}"></span><span class="${selfBadgeClass}" data-ref="${badgeRef}">this session</span></div>
        <div class="${rowCwdClass}" data-ref="${cwdRef}"></div>
        <div class="${rowAddrClass}" data-ref="${addrRef}"></div>
      </a>
    `;

    this.b = new Binder(container, initial);
    this.b.bindText(titleRef, (s) => s.entry.title);
    this.b.bindText(cwdRef, (s) => s.entry.cwd);
    this.b.bindText(addrRef, (s) => `${s.entry.host}:${s.entry.port}`);
    this.b.bindVisible(badgeRef, (s) => s.entry.pid === s.self);
    const link = container.querySelector("a");
    if (link) {
      link.setAttribute(
        "href",
        `http://${initial.entry.host}:${initial.entry.port}/`,
      );
    }
  }

  sync(state: { entry: InstanceEntry; self: number | undefined }): void {
    this.b.sync(state);
    const link = this.container.querySelector("a");
    if (link) {
      link.setAttribute(
        "href",
        `http://${state.entry.host}:${state.entry.port}/`,
      );
    }
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

class RootView implements View<State> {
  container: HTMLElement;
  private b: Binder<State>;

  constructor(
    container: HTMLElement,
    _dispatch: (msg: Msg) => void,
    initial: State,
  ) {
    this.container = container;
    const statusRef = ref("status");
    const listRef = ref("list");
    const emptyRef = ref("empty");

    container.innerHTML = sanitize`
      <div class="${rootClass}">
        <div class="${headerClass}">
          <h1>magenta instances</h1>
          <span class="${statusClass}" data-ref="${statusRef}"></span>
        </div>
        <ul class="${listClass}" data-ref="${listRef}"></ul>
        <div class="${emptyClass}" data-ref="${emptyRef}">No live instances.</div>
      </div>
    `;

    this.b = new Binder(container, initial);
    this.b.bindText(statusRef, (s) =>
      s.connected ? "connected" : "reconnecting…",
    );
    this.b.bindAttr(statusRef, "data-off", (s) =>
      s.connected ? undefined : "true",
    );
    this.b.bindVisible(
      emptyRef,
      (s) => s.connected && s.instances.length === 0,
    );
    this.b.bindList(listRef, "li", (s) =>
      s.instances.map((entry) =>
        showKeyed(
          String(entry.pid),
          InstanceRowView,
          { entry, self: s.self },
          noop,
        ),
      ),
    );
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

  let dispatching = false;
  function dispatch(msg: Msg): void {
    if (dispatching) throw new Error("dispatch-in-dispatch");
    dispatching = true;
    update(state, msg);
    view.sync(state);
    dispatching = false;
  }

  const view = new RootView(container, dispatch, state);
  view.sync(state);

  async function poll(): Promise<void> {
    try {
      const res = await fetch("/instances");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const response = (await res.json()) as InstancesResponse;
      dispatch({ type: "instances", response });
    } catch {
      dispatch({ type: "connection", ok: false });
    }
  }

  void poll();
  setInterval(() => void poll(), POLL_MS);
}

const root = document.getElementById("root");
if (root) {
  mount(root);
}
