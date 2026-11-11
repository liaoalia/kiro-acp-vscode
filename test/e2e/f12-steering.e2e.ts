/** F12 — prompts typed while a turn runs: steering, the queue fallback, and slash commands mid-turn (D22). */
import {
  assert,
  assertEqual,
  freshSession,
  lastStopReason,
  messagesOf,
  test,
  textOf,
  sleep,
  toolCall,
  waitFor,
  withTimeout,
  type Recorder,
} from "./harness.js";
import type { KiroAcpApi } from "../../src/extension.js";
import type { MessageView } from "../../src/ui/protocol.js";

/** Start the `slow` scenario (20 chunks, 100 ms apart) and return once at least two chunks streamed. */
async function startSlowTurn(
  api: KiroAcpApi,
  recorder: Recorder,
  mark: number,
  scenario = "slow",
): Promise<{ turn: Promise<void> }> {
  const turn = api.controller.prompt(`/scenario ${scenario}`, []);
  await waitFor(
    () => recorder.ofType("chunk", mark).filter((c) => c.role === "agent").length >= 2,
    15_000,
    "two streamed chunks of the slow turn",
  );
  assertEqual(api.controller.snapshot().turnActive, true, "turnActive while the slow turn streams");
  return { turn };
}

function userMessage(api: KiroAcpApi, text: string): MessageView | undefined {
  return messagesOf(api.controller.snapshot()).find((m) => m.role === "user" && textOf(m) === text);
}

/** Index in the recorder of the first message matching `predicate`, or -1. */
function indexOf(recorder: Recorder, mark: number, predicate: (m: Recorder["messages"][number]) => boolean): number {
  const index = recorder.since(mark).findIndex(predicate);
  return index < 0 ? -1 : mark + index;
}

test("F12.1 a prompt typed mid-turn is steered; the badge clears once the agent injects it", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  const { turn } = await startSlowTurn(api, recorder, mark);

  await withTimeout(api.controller.prompt("steer me", []), 15_000, "prompt() while steering");

  // Echoed at once with the steering badge, in the transcript and as a messageDelivery post.
  const steered = userMessage(api, "steer me");
  assert(steered, "the steered prompt is echoed as a user message");
  assertEqual(steered.delivery, "steering", "delivery badge right after prompt() resolved");
  assert(
    recorder.ofType("messageDelivery", mark).some((m) => m.messageId === steered.id && m.delivery === "steering"),
    "a messageDelivery 'steering' post was made for the echoed message",
  );

  // The fake agent injects the prompt inside the running turn, then the badge clears.
  await waitFor(
    () => messagesOf(api.controller.snapshot()).some((m) => m.role === "agent" && textOf(m).includes("Steered: steer me")),
    15_000,
    "the agent's 'Steered: steer me' chunk",
  );
  await waitFor(
    () => recorder.ofType("messageDelivery", mark).some((m) => m.messageId === steered.id && m.delivery === null),
    15_000,
    "the steering badge to clear",
  );
  assertEqual(userMessage(api, "steer me")?.delivery, undefined, "transcript carries no delivery after injection");
  const injectedAt = indexOf(
    recorder,
    mark,
    (m) => m.type === "chunk" && m.role === "agent" && m.segment.type === "text" && m.segment.text.includes("Steered:"),
  );
  const endedAt = indexOf(recorder, mark, (m) => m.type === "turn" && !m.active);
  assert(injectedAt >= 0 && (endedAt < 0 || injectedAt < endedAt), "the steered answer arrived inside the running turn");

  await withTimeout(turn, 15_000, "the slow turn");
  assertEqual(lastStopReason(recorder, mark), "end_turn", "the steered turn still ends normally");
  assertEqual(api.controller.snapshot().turnActive, false, "turnActive after the turn");
});

test("F12.2 without steering, mid-turn prompts queue and are sent one per turn after it ends", async ({ api, recorder }) => {
  const sessionId = await freshSession(api);
  api.controller.setSteerUnsupportedForTests(sessionId, true);
  const mark = recorder.mark();
  const { turn } = await startSlowTurn(api, recorder, mark);

  await withTimeout(api.controller.prompt("/scenario chat first", []), 15_000, "first queued prompt()");
  await withTimeout(api.controller.prompt("/scenario chat second", []), 15_000, "second queued prompt()");

  const first = userMessage(api, "/scenario chat first");
  const second = userMessage(api, "/scenario chat second");
  assert(first && second, "both prompts are echoed as user messages");
  assertEqual(first.delivery, "queued", "first prompt badge");
  assertEqual(second.delivery, "queued", "second prompt badge");
  assertEqual(
    recorder.ofType("messageDelivery", mark).filter((m) => m.delivery === "queued").length,
    2,
    "two messageDelivery 'queued' posts",
  );
  assertEqual(api.controller.snapshot().turnActive, true, "the slow turn is still running");

  await withTimeout(turn, 15_000, "the slow turn");

  // The first queued prompt starts the next turn by itself: badge cleared, no second echo.
  await waitFor(
    () => recorder.ofType("messageDelivery", mark).some((m) => m.messageId === first.id && m.delivery === null),
    15_000,
    "the first queued badge to clear",
  );
  assertEqual(userMessage(api, "/scenario chat second")?.delivery, "queued", "the second prompt waits for its own turn");
  const answers = () =>
    messagesOf(api.controller.snapshot()).filter((m) => m.role === "agent" && textOf(m) === "The answer is 42.").length;
  await waitFor(() => answers() >= 1, 15_000, "the first queued prompt's answer");
  await waitFor(
    () => recorder.ofType("messageDelivery", mark).some((m) => m.messageId === second.id && m.delivery === null),
    15_000,
    "the second queued badge to clear",
  );
  await waitFor(() => answers() >= 2 && !api.controller.snapshot().turnActive, 15_000, "the second queued prompt's answer");

  const users = messagesOf(api.controller.snapshot()).filter((m) => m.role === "user");
  assertEqual(users.filter((m) => textOf(m) === "/scenario chat first").length, 1, "the first prompt was echoed once");
  assertEqual(users.filter((m) => textOf(m) === "/scenario chat second").length, 1, "the second prompt was echoed once");
  assert(users.every((m) => m.delivery === undefined), "no badge remains once the queue drained");
  const ends = recorder.ofType("turn", mark).filter((t) => !t.active);
  assertEqual(ends.length, 3, "three turns ended (slow, first, second)");
  assert(ends.every((t) => t.stopReason === "end_turn"), `every turn ended with end_turn: ${JSON.stringify(ends)}`);
  const firstCleared = indexOf(recorder, mark, (m) => m.type === "messageDelivery" && m.messageId === first.id && m.delivery === null);
  const secondCleared = indexOf(recorder, mark, (m) => m.type === "messageDelivery" && m.messageId === second.id && m.delivery === null);
  assert(firstCleared < secondCleared, "queued prompts were sent in order");
});

test("F12.3 cancelling the turn keeps the queue: the queued prompt starts the next turn", async ({ api, recorder }) => {
  const sessionId = await freshSession(api);
  api.controller.setSteerUnsupportedForTests(sessionId, true);
  const mark = recorder.mark();
  const { turn } = await startSlowTurn(api, recorder, mark);

  await withTimeout(api.controller.prompt("/scenario chat later", []), 15_000, "queued prompt()");
  const queued = userMessage(api, "/scenario chat later");
  assert(queued && queued.delivery === "queued", "the prompt was queued");

  await api.controller.cancel();
  await withTimeout(turn, 15_000, "prompt() to resolve after cancel");
  assertEqual(lastStopReason(recorder, mark), "cancelled", "stop reason");

  // Stop ends the current answer only: the queued prompt goes out as the next turn.
  await waitFor(
    () => recorder.ofType("messageDelivery", mark).some((m) => m.messageId === queued.id && m.delivery === null),
    15_000,
    "the queued badge to clear",
  );
  assert(
    !recorder.ofType("notice", mark).some((n) => n.notice.text.includes("discarded")),
    `no 'discarded' notice: ${JSON.stringify(recorder.ofType("notice", mark))}`,
  );
  await waitFor(
    () =>
      messagesOf(api.controller.snapshot()).some((m) => m.role === "agent" && textOf(m) === "The answer is 42.") &&
      !api.controller.snapshot().turnActive,
    15_000,
    "the queued prompt's answer",
  );
  assertEqual(userMessage(api, "/scenario chat later")?.delivery, undefined, "transcript carries no badge");
  assertEqual(
    messagesOf(api.controller.snapshot()).filter((m) => m.role === "user" && textOf(m) === "/scenario chat later").length,
    1,
    "the queued prompt was echoed once",
  );
  assertEqual(recorder.ofType("turn", mark).filter((t) => t.active).length, 2, "the cancelled turn and the queued one");
});

test("F12.5 a steer refused after the turn was cancelled is sent as the next turn", async ({ api, recorder }) => {
  const sessionId = await freshSession(api);
  api.controller.setSteerUnsupportedForTests(sessionId, false);
  const mark = recorder.mark();
  // `slow-steer`: the fake agent refuses `_session/steer` only after 1.5 s.
  const { turn } = await startSlowTurn(api, recorder, mark, "slow-steer");

  const steerPrompt = api.controller.prompt("/scenario chat late steer", []);
  const steered = await waitFor(() => userMessage(api, "/scenario chat late steer"), 15_000, "the mid-turn prompt to be echoed");
  assertEqual(steered.delivery, "steering", "badge while the steer request is in flight");

  // Stop the turn before the agent answers the steer.
  await api.controller.cancel();
  await withTimeout(turn, 15_000, "the slow turn to end after cancel");
  assertEqual(lastStopReason(recorder, mark), "cancelled", "stop reason");
  assertEqual(api.controller.snapshot().turnActive, false, "turnActive after cancel");

  // The late refusal arrives: the message was typed and never delivered, so it goes out as a prompt of its own.
  await withTimeout(steerPrompt, 15_000, "prompt() of the steered message to settle");
  await waitFor(
    () =>
      messagesOf(api.controller.snapshot()).some((m) => m.role === "agent" && textOf(m) === "The answer is 42.") &&
      !api.controller.snapshot().turnActive,
    15_000,
    "the re-sent message's answer",
  );
  const starts = recorder.ofType("turn", mark).filter((t) => t.active);
  assertEqual(starts.length, 2, `the cancelled turn and the re-sent one (${JSON.stringify(recorder.ofType("turn", mark))})`);
  assertEqual(userMessage(api, "/scenario chat late steer")?.delivery, undefined, "the badge is cleared");
  assert(
    recorder.ofType("messageDelivery", mark).some((m) => m.messageId === steered.id && m.delivery === null),
    "a messageDelivery null post cleared the badge",
  );
  assert(
    !recorder.ofType("notice", mark).some((n) => n.notice.text.startsWith("Message not sent")),
    `no 'Message not sent' notice: ${JSON.stringify(recorder.ofType("notice", mark))}`,
  );
  assertEqual(
    messagesOf(api.controller.snapshot()).filter((m) => m.role === "user" && textOf(m) === "/scenario chat late steer").length,
    1,
    "the re-sent prompt was echoed once",
  );

  // A late refusal says nothing about steering support: the next mid-turn prompt is steered again.
  const mark2 = recorder.mark();
  const { turn: turn2 } = await startSlowTurn(api, recorder, mark2);
  await withTimeout(api.controller.prompt("steer again", []), 15_000, "prompt() while steering");
  assertEqual(userMessage(api, "steer again")?.delivery, "steering", "steering is still attempted");
  await withTimeout(turn2, 15_000, "the second slow turn");
  assertEqual(api.controller.snapshot().turnActive, false, "idle after the follow-up turn");
});

test("F12.6 /clear mid-turn discards the queue and never starts a turn on the cleared session", async ({ api, recorder }) => {
  const sessionId = await freshSession(api);
  api.controller.setSteerUnsupportedForTests(sessionId, true);
  const mark = recorder.mark();
  const { turn } = await startSlowTurn(api, recorder, mark);

  await withTimeout(api.controller.prompt("/scenario chat later", []), 15_000, "queued prompt()");
  const queued = userMessage(api, "/scenario chat later");
  assert(queued && queued.delivery === "queued", "the prompt was queued");

  await withTimeout(api.controller.prompt("/clear", []), 15_000, "/clear mid-turn");
  await withTimeout(turn, 15_000, "the slow turn to end after /clear");
  await waitFor(() => {
    const s = api.controller.snapshot();
    return s.sessionId && s.sessionId !== sessionId && s.items.length === 0 ? true : undefined;
  }, 15_000, "a fresh, empty session after /clear");
  assert(!api.controller.snapshot().sessions.some((s) => s.id === sessionId), "the cleared session is gone");

  const notice = recorder.ofType("notice", mark).find((n) => n.notice.text.includes("discarded"));
  assert(notice, `a notice says the queued message was discarded: ${JSON.stringify(recorder.ofType("notice", mark))}`);
  assert(
    recorder.ofType("messageDelivery", mark).some((m) => m.messageId === queued.id && m.delivery === null),
    "the queued badge was cleared",
  );
  // Only the slow turn ever started: the queued prompt never became a session/prompt on the cleared session.
  await sleep(1000);
  assertEqual(recorder.ofType("turn", mark).filter((t) => t.active).length, 1, "no turn started for the discarded prompt");
  assert(
    !recorder.ofType("chunk", mark).some((c) => c.role === "agent" && c.segment.type === "text" && c.segment.text.includes("42")),
    "the discarded prompt was never answered",
  );
  assertEqual(api.controller.snapshot().turnActive, false, "the new session is idle");
});

test("F12.7 a prompt typed while /clear is replacing the session goes to the new session", async ({ api }) => {
  const before = await freshSession(api);
  const clear = api.controller.prompt("/clear", []);
  const question = api.controller.prompt("/scenario chat", []);
  await withTimeout(Promise.all([clear, question]), 15_000, "/clear and the prompt typed right after it");

  const s = api.controller.snapshot();
  assert(s.sessionId && s.sessionId !== before, "the view shows the replacement session");
  assert(!s.sessions.some((x) => x.id === before), "the cleared session is gone");
  const msgs = messagesOf(s);
  const users = msgs.filter((m) => m.role === "user");
  assertEqual(users.length, 1, `the new session holds just the typed question (${JSON.stringify(users.map(textOf))})`);
  assertEqual(textOf(users[0]!), "/scenario chat", "the question text");
  assert(msgs.some((m) => m.role === "agent" && textOf(m) === "The answer is 42."), "it was answered in the new session");
  assertEqual(s.turnActive, false, "idle afterwards");
});

test("F12.4 /cancel typed mid-turn runs immediately", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  const { turn } = await startSlowTurn(api, recorder, mark);

  await withTimeout(api.controller.prompt("/cancel", []), 15_000, "/cancel prompt()");
  await withTimeout(turn, 15_000, "the slow turn to end after /cancel");

  assertEqual(lastStopReason(recorder, mark), "cancelled", "stop reason");
  assertEqual(api.controller.snapshot().turnActive, false, "turnActive after /cancel");
  assert(
    !recorder.ofType("notice", mark).some((n) => n.notice.text.includes("Wait for the current turn")),
    "the mid-turn refusal notice is gone for slash commands",
  );
  assert(!userMessage(api, "/cancel"), "/cancel is not echoed as a prompt");
  const chunks = recorder.ofType("chunk", mark).filter((c) => c.role === "agent").length;
  assert(chunks < 20, `the turn was cut short (${chunks} chunks)`);
});

test("F12.8 Stop ends the turn locally when the agent never answers session/cancel (D27)", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  const turn = api.controller.prompt("/scenario hang", []);
  await waitFor(
    () => recorder.ofType("chunk", mark).some((c) => c.role === "agent"),
    15_000,
    "the stuck agent's first chunk",
  );
  assertEqual(api.controller.snapshot().turnActive, true, "turnActive while the agent hangs");

  const stopped = Date.now();
  await api.controller.cancel();
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "the turn to end without the agent's answer");
  const took = Date.now() - stopped;
  assert(took >= 4_000 && took < 12_000, `ended by the watchdog, not at once nor never (${took} ms)`);
  assertEqual(lastStopReason(recorder, mark), "cancelled", "ended as cancelled");
  assert(
    recorder.ofType("notice", mark).some((n) => n.notice.text.includes("did not confirm the stop")),
    `a notice explains the local stop: ${JSON.stringify(recorder.ofType("notice", mark))}`,
  );

  // The session is usable again: the next prompt runs as a new turn.
  await withTimeout(api.controller.prompt("/scenario chat", []), 15_000, "a prompt after the local stop");
  await waitFor(
    () => messagesOf(api.controller.snapshot()).some((m) => m.role === "agent" && textOf(m) === "The answer is 42."),
    15_000,
    "the next turn's answer",
  );
  void turn; // the hung prompt() never resolves in this fake; nothing awaits it
});

test("F12.9 Stop kills the session's running command, so an agent waiting on it can end the turn (D27)", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  const turn = api.controller.prompt("/scenario hang-terminal", []);
  await waitFor(
    () => recorder.ofType("toolCall", mark).some((t) => t.call.content.some((c) => c.type === "terminal")),
    15_000,
    "the tool card to show its terminal",
  );
  await sleep(300); // let the command start
  assertEqual(api.controller.snapshot().turnActive, true, "turnActive while the command runs");

  const stopped = Date.now();
  await api.controller.cancel();
  await withTimeout(turn, 15_000, "prompt() to resolve after Stop");
  const took = Date.now() - stopped;
  assert(took < 4_000, `the agent ended the turn itself once its wait returned (${took} ms), before the watchdog`);
  assertEqual(lastStopReason(recorder, mark), "cancelled", "the agent's own stop reason");
  assert(
    !recorder.ofType("notice", mark).some((n) => n.notice.text.includes("did not confirm")),
    "no watchdog notice: the agent confirmed the stop",
  );
  // The snapshot resolves the card's terminal against the (released) terminal: the kill left an exit status.
  const card = toolCall(api.controller.snapshot(), "call-service");
  const term = card.content.find((c) => c.type === "terminal");
  assert(term && term.type === "terminal", "the card keeps its terminal");
  assert(term.exitCode !== undefined, `the killed command has an exit status (${JSON.stringify(term)})`);
});
