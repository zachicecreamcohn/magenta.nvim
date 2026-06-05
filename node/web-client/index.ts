import {
  Binder,
  cls,
  mountStyle,
  type Ref,
  ref,
  sanitize,
  showKeyed,
  type View,
} from "./vamp.js";

type Action =
  | { type: "send"; text: string }
  | { type: "abort" }
  | { type: "approve"; id: string }
  | { type: "reject"; id: string }
  | { type: "new-thread" }
  | { type: "select-thread"; id: string };

type ThreadInfo = {
  id: string;
  title: string;
  status: string;
  active: boolean;
  parentId: string | undefined;
  agentName: string | undefined;
};

type Status = {
  running: boolean;
  pendingApproval?: { id: string; toolName: string };
  threads: ThreadInfo[];
};

type Snapshot = {
  chatText: string;
  status: Status;
  indexPort: number | undefined;
  indexHost: string | undefined;
};

type State = {
  connected: boolean;
  chatText: string;
  status: Status;
  input: string;
  sidebarOpen: boolean;
  indexPort: number | undefined;
  indexHost: string | undefined;
};

type Msg =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "connection"; open: boolean }
  | { type: "input"; text: string }
  | { type: "send" }
  | { type: "abort" }
  | { type: "approve" }
  | { type: "reject" }
  | { type: "new-thread" }
  | { type: "select-thread"; id: string }
  | { type: "toggle-sidebar" }
  | { type: "close-sidebar" };

function initialState(): State {
  return {
    connected: false,
    chatText: "",
    status: { running: false, threads: [] },
    input: "",
    sidebarOpen: false,
    indexPort: undefined,
    indexHost: undefined,
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
      state.indexPort = msg.snapshot.indexPort;
      state.indexHost = msg.snapshot.indexHost;
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
    case "approve": {
      const pending = state.status.pendingApproval;
      if (pending) postAction({ type: "approve", id: pending.id });
      break;
    }
    case "reject": {
      const pending = state.status.pendingApproval;
      if (pending) postAction({ type: "reject", id: pending.id });
      break;
    }
    case "new-thread":
      postAction({ type: "new-thread" });
      state.sidebarOpen = false;
      break;
    case "select-thread":
      postAction({ type: "select-thread", id: msg.id });
      state.sidebarOpen = false;
      break;
    case "toggle-sidebar":
      state.sidebarOpen = !state.sidebarOpen;
      break;
    case "close-sidebar":
      state.sidebarOpen = false;
      break;
  }
}

const rootClass = cls("root");
const topBarClass = cls("topBar");
const menuButtonClass = cls("menuButton");
const mainClass = cls("main");
const sidebarClass = cls("sidebar");
const sidebarOpenClass = cls("sidebarOpen");
const sidebarHeaderClass = cls("sidebarHeader");
const newThreadButtonClass = cls("newThreadButton");
const threadListClass = cls("threadList");
const threadItemClass = cls("threadItem");
const threadItemActiveClass = cls("threadItemActive");
const threadItemSubagentClass = cls("threadItemSubagent");
const threadTitleClass = cls("threadTitle");
const threadAgentNameClass = cls("threadAgentName");
const threadStatusClass = cls("threadStatus");
const contentClass = cls("content");
const backdropClass = cls("backdrop");
const statusClass = cls("status");
const chatClass = cls("chat");
const inputRowClass = cls("inputRow");
const textareaClass = cls("textarea");
const sendButtonClass = cls("sendButton");
const abortButtonClass = cls("abortButton");
const indexLinkClass = cls("indexLink");
const approvalRowClass = cls("approvalRow");
const approvalLabelClass = cls("approvalLabel");
const approveButtonClass = cls("approveButton");
const rejectButtonClass = cls("rejectButton");

mountStyle(`
html, body { margin: 0; height: 100%; background: #1a1a1a; color: #f0f0f0; }
.${rootClass} {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  overflow: hidden;
}
.${topBarClass} {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  background: #222;
  color: #ccc;
}
.${menuButtonClass} {
  flex: 0 0 auto;
  padding: 0.25rem 0.6rem;
  font: inherit;
  border: 1px solid #444;
  border-radius: 4px;
  background: #2a2a2a;
  color: #eee;
}
.${indexLinkClass} {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 0.25rem 0.5rem;
  font-size: 12px;
  color: #888;
  text-decoration: none;
}
.${indexLinkClass}:hover {
  color: #ccc;
}
.${mainClass} {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  position: relative;
}
.${sidebarClass} {
  flex: 0 0 auto;
  width: 240px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #333;
  background: #181818;
  overflow: hidden;
}
.${sidebarHeaderClass} {
  flex: 0 0 auto;
  padding: 0.5rem;
  border-bottom: 1px solid #333;
}
.${newThreadButtonClass} {
  width: 100%;
  padding: 0.5rem;
  font: inherit;
  border: none;
  border-radius: 4px;
  background: #b048b0;
  color: #fff;
}
.${threadListClass} {
  flex: 1 1 auto;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  list-style: none;
  margin: 0;
  padding: 0;
}
.${threadItemClass} {
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid #262626;
  cursor: pointer;
  color: #ddd;
}
.${threadItemActiveClass} {
  background: #2a1f2a;
  border-left: 3px solid #b048b0;
}
.${threadItemSubagentClass} {
  border-left: 2px solid #444;
  background: #151515;
}
.${threadAgentNameClass} {
  display: inline-block;
  font-size: 11px;
  color: #b048b0;
  margin-right: 0.3rem;
  opacity: 0.85;
}
.${threadTitleClass} {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${threadStatusClass} {
  display: block;
  font-size: 12px;
  color: #888;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${contentClass} {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.${backdropClass} {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1;
}
/* Mobile: sidebar is an overlay toggled open; menu button is shown. */
@media (max-width: 640px) {
  .${sidebarClass} {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 2;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .${sidebarOpenClass} {
    transform: translateX(0);
  }
}
/* Desktop: sidebar is always visible; hide the menu button and backdrop. */
@media (min-width: 641px) {
  .${menuButtonClass} {
    display: none;
  }
  .${backdropClass} {
    display: none;
  }
}
.${statusClass} {
  flex: 1 1 auto;
  color: #f0f0f0;
}
.${chatClass} {
  background: #1a1a1a;
  color: #f0f0f0;
  flex: 1 1 auto;
  overflow-y: auto;
  margin: 0;
  padding: 0.75rem;
  white-space: pre-wrap;
  word-break: break-word;
  -webkit-overflow-scrolling: touch;
}.${inputRowClass} {
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
  font-size: max(16px, 1em);
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
.${approvalRowClass} {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem;
  border-top: 1px solid #333;
  background: #2a221a;
}
.${approvalLabelClass} {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #e8c98a;
}
.${approveButtonClass} {
  flex: 0 0 auto;
  padding: 0.5rem 1rem;
  font: inherit;
  border: none;
  border-radius: 4px;
  background: #4a9d4a;
  color: #fff;
}
.${rejectButtonClass} {
  flex: 0 0 auto;
  padding: 0.5rem 1rem;
  font: inherit;
  border: none;
  border-radius: 4px;
  background: #b04848;
  color: #fff;
}
`);

type ThreadItemState = { thread: ThreadInfo; depth: number };
type ThreadItemMsg = { type: "click" };

class ThreadItemView implements View<ThreadItemState, ThreadItemMsg> {
  container: HTMLElement;
  private b: Binder<ThreadItemState>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: ThreadItemMsg) => void,
    initialState: ThreadItemState,
  ) {
    this.container = container;

    const itemRef = ref("threadItem");
    const agentNameRef = ref("threadAgentName");
    const titleRef = ref("threadTitle");
    const statusRef = ref("threadStatus");

    container.innerHTML = sanitize`
      <div class="${threadItemClass}" data-ref="${itemRef}">
        <span class="${threadTitleClass}">
          <span class="${threadAgentNameClass}" data-ref="${agentNameRef}"></span
          ><span data-ref="${titleRef}"></span>
        </span>
        <span class="${threadStatusClass}" data-ref="${statusRef}"></span>
      </div>
    `;

    this.b = new Binder(container, initialState);
    this.b.bindClass(itemRef, (s) => {
      const isSubagent = s.thread.agentName !== undefined;
      const classes = [threadItemClass];
      if (s.thread.active) classes.push(threadItemActiveClass);
      if (isSubagent) classes.push(threadItemSubagentClass);
      return classes.join(" ");
    });
    this.b.bindAttr(itemRef, "style", (s) =>
      s.depth > 0 ? `padding-left: ${0.6 + s.depth * 1.2}rem` : undefined,
    );
    this.b.bindText(agentNameRef, (s) =>
      s.thread.agentName ? `🤖 [${s.thread.agentName}] ` : "",
    );
    this.b.bindText(titleRef, (s) => s.thread.title);
    this.b.bindText(statusRef, (s) => s.thread.status);
    this.b.ref(itemRef).addEventListener("click", () => {
      dispatch({ type: "click" });
    });
  }

  sync(state: ThreadItemState): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

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

    const menuRef = ref("menu");
    const statusRef = ref("status");
    const mainRef = ref("main");
    const sidebarRef = ref("sidebar");
    const newThreadRef = ref("newThread");
    const threadListRef = ref("threadList");
    const backdropRef = ref("backdrop");
    const chatRef = ref("chat");
    const inputRef = ref("input");
    const sendRef = ref("send");
    const abortRef = ref("abort");
    const approvalRowRef = ref("approvalRow");
    const approvalLabelRef = ref("approvalLabel");
    const approveRef = ref("approve");
    const rejectRef = ref("reject");
    const indexLinkRef = ref("indexLink");
    this.chatRef = chatRef;
    this.inputRef = inputRef;

    container.innerHTML = sanitize`
      <div class="${rootClass}">
        <div class="${topBarClass}">
          <button class="${menuButtonClass}" data-ref="${menuRef}">☰</button>
          <span class="${statusClass}" data-ref="${statusRef}"></span>
          <a class="${indexLinkClass}" data-ref="${indexLinkRef}" href="#">all instances</a>
        </div>
        <div class="${mainClass}" data-ref="${mainRef}">
          <div class="${sidebarClass}" data-ref="${sidebarRef}">
            <div class="${sidebarHeaderClass}">
              <button class="${newThreadButtonClass}" data-ref="${newThreadRef}">+ New thread</button>
            </div>
            <ul class="${threadListClass}" data-ref="${threadListRef}"></ul>
          </div>
          <div class="${backdropClass}" data-ref="${backdropRef}"></div>
          <div class="${contentClass}">
            <pre class="${chatClass}" data-ref="${chatRef}"></pre>
            <div class="${approvalRowClass}" data-ref="${approvalRowRef}">
              <span class="${approvalLabelClass}" data-ref="${approvalLabelRef}"></span>
              <button class="${rejectButtonClass}" data-ref="${rejectRef}">Reject</button>
              <button class="${approveButtonClass}" data-ref="${approveRef}">Approve</button>
            </div>
            <div class="${inputRowClass}">
              <textarea class="${textareaClass}" data-ref="${inputRef}" placeholder="Send a message..."></textarea>
              <button class="${abortButtonClass}" data-ref="${abortRef}">Abort</button>
              <button class="${sendButtonClass}" data-ref="${sendRef}">Send</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.b = new Binder(container, initialState);
    this.b.bindText(statusRef, (s) =>
      s.connected ? "connected" : "disconnected",
    );
    this.b.bindVisible(indexLinkRef, (s) => s.indexPort !== undefined);
    this.b.bindAttr(indexLinkRef, "href", (s) =>
      s.indexPort !== undefined && s.indexHost !== undefined
        ? `http://${s.indexHost}:${s.indexPort}/`
        : undefined,
    );

    // Sidebar: always visible on desktop (CSS); on mobile it slides in when
    // sidebarOpen, with a backdrop that closes it.
    this.b.bindClass(sidebarRef, (s) =>
      s.sidebarOpen ? `${sidebarClass} ${sidebarOpenClass}` : sidebarClass,
    );
    this.b.bindVisible(backdropRef, (s) => s.sidebarOpen);
    this.b.ref(menuRef).addEventListener("click", () => {
      dispatch({ type: "toggle-sidebar" });
    });
    this.b.ref(backdropRef).addEventListener("click", () => {
      dispatch({ type: "close-sidebar" });
    });
    this.b.ref(newThreadRef).addEventListener("click", () => {
      dispatch({ type: "new-thread" });
    });
    this.b.bindList(threadListRef, "li", (s) => {
      // Build a depth map and tree-ordered list from the flat thread array.
      const byId = new Map(s.status.threads.map((t) => [t.id, t]));
      const depthOf = (id: string): number => {
        let depth = 0;
        let current: ThreadInfo | undefined = byId.get(id);
        while (current?.parentId !== undefined) {
          depth++;
          current = byId.get(current.parentId);
        }
        return depth;
      };
      // Tree-walk: roots (no parentId) sorted newest-first, children appended after parent.
      const ordered: ThreadInfo[] = [];
      const visited = new Set<string>();
      const appendSubtree = (thread: ThreadInfo) => {
        if (visited.has(thread.id)) return;
        visited.add(thread.id);
        ordered.push(thread);
        s.status.threads
          .filter((t) => t.parentId === thread.id)
          .forEach(appendSubtree);
      };
      s.status.threads
        .filter((t) => t.parentId === undefined)
        .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .forEach(appendSubtree);
      return ordered.map((thread) =>
        showKeyed(thread.id, ThreadItemView, { thread, depth: depthOf(thread.id) }, () =>
          dispatch({ type: "select-thread", id: thread.id }),
        ),
      );
    });

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

    // Approval row: shown only when there's a pending tool approval. The label
    // shows the pending tool/command; the id is read from state at click time
    // (via the dispatch → update path), so we don't capture a stale id here.
    this.b.bindVisible(
      approvalRowRef,
      (s) => s.status.pendingApproval !== undefined,
    );
    this.b.bindText(
      approvalLabelRef,
      (s) => s.status.pendingApproval?.toolName ?? "",
    );
    this.b.ref(approveRef).addEventListener("click", () => {
      dispatch({ type: "approve" });
    });
    this.b.ref(rejectRef).addEventListener("click", () => {
      dispatch({ type: "reject" });
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
