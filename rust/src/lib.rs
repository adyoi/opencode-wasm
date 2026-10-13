//! OpenCode as a single WebAssembly module.
//!
//! Bun cannot target WebAssembly (`bun build --compile` only emits native
//! binaries for linux/darwin/windows), so the OpenCode runtime cannot be
//! *compiled* to wasm. What this crate does instead: the official OpenCode JS
//! runtime (`@opencode/client`, bundled into one browser IIFE) is embedded as
//! bytes straight into the wasm binary with `include_str!`. The host evaluates
//! that embedded source and reports every call result back into wasm memory,
//! so a single `.wasm` file is the whole distribution.
//!
//! Flow:
//!
//! ```text
//!   host                       wasm                       embedded JS runtime
//!   ----                       ----                       -------------------
//!   init()                     runtimeSource()   -------> (eval) globalThis.__oc
//!   client.call(..)     --->   queue(method, json) -----> __oc[method](payload)
//!   pump()               <---   requests/replies   <---- __ocSettle(ticket, ok, json)
//!   pump()               <---   events             <---- __ocEvent(json)
//! ```
//!
//! The wasm side never blocks and needs no async executor: `queue()` returns a
//! ticket, the host dispatches requests and drains results with `pump()`.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

use serde::Serialize;
use serde_json::Value;
use wasm_bindgen::prelude::*;

/// The complete OpenCode JS runtime, embedded into the wasm binary.
const RUNTIME_JS: &str = include_str!("../../js/dist/runtime.js");

#[derive(Serialize)]
struct Reply {
    ticket: u32,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Entry {
    /// One event coming from the server event stream.
    Event(Value),
    /// One settled call.
    Reply(Reply),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Drain {
    requests: Vec<Value>,
    replies: Vec<Reply>,
    events: Vec<Value>,
    session: Option<String>,
}

#[derive(Default)]
struct State {
    /// Requests the host still has to dispatch into the JS runtime.
    outbox: VecDeque<Value>,
    /// Settled replies and streamed events waiting to be drained.
    inbox: VecDeque<Entry>,
    next_ticket: u32,
    pending: u32,
    session: Option<String>,
    queued: u32,
    replies: u32,
    events: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn value_of(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        serde_json::from_str(trimmed).ok()
    }
}

fn json(raw: Value) -> String {
    serde_json::to_string(&raw).unwrap_or_else(|_| "null".to_owned())
}

/// Return the JS runtime source embedded in this wasm binary.
#[wasm_bindgen(js_name = runtimeSource)]
pub fn runtime_source() -> String {
    RUNTIME_JS.to_owned()
}

/// Size of the embedded JS runtime, in bytes.
#[wasm_bindgen(js_name = runtimeBytes)]
pub fn runtime_bytes() -> usize {
    RUNTIME_JS.len()
}

/// Called by the host once a settled call produced a result.
#[wasm_bindgen(js_name = settle)]
pub fn settle(ticket: u32, ok: bool, payload: &str) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.pending = s.pending.saturating_sub(1);
    });

    let entry = if ok {
        Reply {
            ticket,
            ok: true,
            data: value_of(payload),
            error: None,
        }
    } else {
        Reply {
            ticket,
            ok: false,
            data: None,
            error: Some(match value_of(payload) {
                Some(Value::String(message)) => message,
                Some(other) => other.to_string(),
                None => payload.to_owned(),
            }),
        }
    };
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.replies += 1;
        s.inbox.push_back(Entry::Reply(entry));
    });
}

/// Called by the host for every event emitted by the server event stream.
#[wasm_bindgen(js_name = event)]
pub fn event(payload: &str) {
    let data = value_of(payload).unwrap_or(Value::Null);
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.events += 1;
        s.inbox.push_back(Entry::Event(data));
    });
}

/// An OpenCode client whose runtime lives inside the wasm module.
#[wasm_bindgen]
pub struct OpenCode {
    runtime_evaluated: Cell<bool>,
}

impl Default for OpenCode {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl OpenCode {
    #[wasm_bindgen(constructor)]
    pub fn new() -> OpenCode {
        OpenCode {
            runtime_evaluated: Cell::new(false),
        }
    }

    /// Name of the runtime carried by this module.
    pub fn runtime(&self) -> String {
        "opencode".to_owned()
    }

    /// Mark the embedded JS runtime as evaluated; clears all pending state.
    pub fn boot(&self) -> bool {
        self.runtime_evaluated.set(true);
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.outbox.clear();
            s.inbox.clear();
            s.next_ticket = 0;
            s.pending = 0;
        });
        true
    }

    /// Ask the host to invoke `method` on the embedded runtime with `payload`
    /// (a JSON value). Returns the ticket that the reply will carry.
    pub fn queue(&self, method: &str, payload: &str) -> u32 {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.next_ticket = s.next_ticket.wrapping_add(1).max(1);
            s.pending += 1;
            s.queued += 1;
            let request = serde_json::json!({
                "ticket": s.next_ticket,
                "method": method,
                "payload": value_of(payload).unwrap_or(Value::Null),
            });
            s.outbox.push_back(request);
            s.next_ticket
        })
    }

    /// Drain queued requests, settled replies and streamed events as JSON.
    pub fn pump(&self) -> String {
        let (requests, replies, events, session) = STATE.with(|s| {
            let mut s = s.borrow_mut();
            let mut replies: Vec<Reply> = Vec::new();
            let mut events: Vec<Value> = Vec::new();
            while let Some(entry) = s.inbox.pop_front() {
                match entry {
                    Entry::Event(value) => events.push(value),
                    Entry::Reply(reply) => replies.push(reply),
                }
            }
            let requests = s.outbox.drain(..).collect();
            (requests, replies, events, s.session.clone())
        });

        json(serde_json::to_value(Drain {
            requests,
            replies,
            events,
            session,
        })
        .unwrap_or(Value::Null))
    }

    /// Remember the active session id inside wasm memory.
    pub fn remember(&self, session_id: &str) {
        STATE.with(|s| s.borrow_mut().session = Some(session_id.to_owned()));
    }

    /// Currently remembered session id, if any.
    pub fn session(&self) -> Option<String> {
        STATE.with(|s| s.borrow().session.clone())
    }

    /// Drop all queued state.
    pub fn reset(&self) {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.outbox.clear();
            s.inbox.clear();
            s.next_ticket = 0;
            s.pending = 0;
            s.session = None;
            s.queued = 0;
            s.replies = 0;
            s.events = 0;
        });
    }

    /// Counters plus the size of the embedded runtime.
    #[wasm_bindgen(js_name = stats)]
    pub fn stats_json(&self) -> String {
        let (pending, queued, replies, events) = STATE.with(|s| {
            let s = s.borrow();
            (s.pending, s.queued, s.replies, s.events)
        });
        json(serde_json::json!({
            "pending": pending,
            "queued": queued,
            "replies": replies,
            "events": events,
            "embeddedBytes": RUNTIME_JS.len(),
            "runtimeEvaluated": self.runtime_evaluated.get(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_is_embedded_and_bundled() {
        assert!(RUNTIME_JS.contains("__ocReady"), "bundle must install the bridge");
        assert!(RUNTIME_JS.contains("createSession"), "bundle must expose the OpenCode API");
        assert!(!RUNTIME_JS.contains("require(\"node:"), "browser bundle must not need node builtins");
    }

    #[test]
    fn replies_are_routed_back_to_the_host() {
        let client = OpenCode::new();
        client.boot();

        let ticket = client.queue("info", "null");
        assert_eq!(ticket, 1);
        client.remember("ses_123");

        let drained: Value = serde_json::from_str(&client.pump()).unwrap();
        let request = &drained["requests"][0];
        assert_eq!(request["method"], "info");
        assert_eq!(request["ticket"], 1);
        assert_eq!(drained["session"], "ses_123");

        settle(ticket, true, "{\"version\":\"2.0.28\"}");
        let drained: Value = serde_json::from_str(&client.pump()).unwrap();
        assert_eq!(drained["replies"][0]["ok"], true);
        assert_eq!(drained["replies"][0]["data"]["version"], "2.0.28");
    }

    #[test]
    fn errors_are_normalised_to_a_string() {
        let client = OpenCode::new();
        client.boot();
        let ticket = client.queue("prompt", "{}");
        let _ = client.pump();
        settle(ticket, false, "{\"message\":\"nope\"}");
        let drained: Value = serde_json::from_str(&client.pump()).unwrap();
        assert_eq!(drained["replies"][0]["ok"], false);
        assert!(drained["replies"][0]["error"].as_str().unwrap().contains("nope"));
    }
}
