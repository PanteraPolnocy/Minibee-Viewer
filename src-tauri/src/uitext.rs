//! Lines the core writes for a person to read.
//!
//! The words live in src/lang/en.json, the one file the webview also loads
//! (baked in here with `include_str!`, so the binary carries its English);
//! the code names a line by key and hands over the values it interpolates,
//! kept apart from the words so a translation can place them:
//!
//! ```ignore
//! let line = UiText::new("friends.offered", json!({ "name": name })); // text: "Bob offered a friendship card."
//! line.fields(&mut payload, "text");                                   // text + textKey + textArgs
//! return Err(ui_err("err.noNotice", json!({})));
//! ```
//!
//! Three shapes reach the frontend (BeeI18n renders them in the UI language):
//! - `fields()`: `name`, `nameKey` and `nameArgs` beside each other in a
//!   payload (`text` + `textKey` + `textArgs` on a chat line, `reason` +
//!   `reasonKey` + ... on an event): BeeI18n.field / textOf;
//! - `value()`: a `{ "key", "text", "args" }` object standing on its own:
//!   BeeI18n.fromCore;
//! - `err()`: that object as JSON text, for a command's `Err(String)`:
//!   BeeUtils.errText decodes it, and anything that shows the raw string
//!   still shows readable English inside it.
//!
//! `npm run lang:check` reads the keys out of the source (`ui_err("…"`,
//! `ui_text("…"`, `UiText::new("…"`), so the key must be a string literal
//! written in the call, and en.json must have it.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

const ENGLISH_JSON: &str = include_str!("../../src/lang/en.json");

/// en.json, parsed once: key -> a string, or an object of plural forms.
fn english() -> &'static HashMap<String, Value> {
    static WORDS: OnceLock<HashMap<String, Value>> = OnceLock::new();
    WORDS.get_or_init(|| serde_json::from_str(ENGLISH_JSON).unwrap_or_default())
}

/// The English wording for `key` as en.json holds it.
pub fn wording(key: &str) -> Option<&'static Value> {
    english().get(key)
}

/// Fill `{name}` placeholders in `template` from `args` (an object). A
/// placeholder with no value, or a brace that opens no placeholder, stays as
/// written.
pub fn fill(template: &str, args: &Value) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let name_len = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        if name_len > 0 && after[name_len..].starts_with('}') {
            let name = &after[..name_len];
            match args.get(name) {
                Some(Value::String(s)) => out.push_str(s),
                Some(Value::Null) | None => {
                    out.push('{');
                    out.push_str(name);
                    out.push('}');
                }
                Some(other) => out.push_str(&other.to_string()),
            }
            rest = &after[name_len + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// The line for `key` out of `words`, with `args` filled in: a plural object
/// picks `one` for a count of exactly 1 and `other` otherwise (English
/// rules). The key itself when there is no such line, so a missing entry
/// shows up instead of hiding.
fn line_from(words: &HashMap<String, Value>, key: &str, args: &Value) -> String {
    let template: &str = match words.get(key) {
        Some(Value::String(s)) => s.as_str(),
        Some(Value::Object(forms)) => {
            let one = matches!(args.get("count").and_then(Value::as_f64), Some(c) if c == 1.0);
            let form = if one { "one" } else { "other" };
            forms
                .get(form)
                .or_else(|| forms.get("other"))
                .and_then(Value::as_str)
                .unwrap_or(key)
        }
        _ => key,
    };
    fill(template, args)
}

/// The English line for `key` with `args` filled in.
pub fn english_line(key: &str, args: &Value) -> String {
    line_from(english(), key, args)
}

/// A line with its key and arguments; see the module notes for the shapes.
#[derive(Debug, Clone, PartialEq)]
pub struct UiText {
    pub key: String,
    pub text: String,
    pub args: Value,
}

impl UiText {
    /// `args` is the json! object the line's placeholders read from
    /// (anything but an object counts as no arguments).
    pub fn new(key: &str, args: Value) -> Self {
        let args = if args.is_object() { args } else { Value::Object(Map::new()) };
        Self { key: key.to_string(), text: english_line(key, &args), args }
    }

    /// `{ "key", "text", "args" }`.
    pub fn value(&self) -> Value {
        json!({ "key": self.key, "text": self.text, "args": self.args })
    }

    /// `value()` as JSON text, the form a command's `Err(String)` carries.
    pub fn err(&self) -> String {
        self.value().to_string()
    }

    /// Write `name`, `nameKey` and `nameArgs` into `payload` (made an object
    /// if it is not one).
    pub fn fields(&self, payload: &mut Value, name: &str) {
        if !payload.is_object() {
            *payload = Value::Object(Map::new());
        }
        let obj = payload.as_object_mut().expect("just made an object");
        obj.insert(name.to_string(), Value::String(self.text.clone()));
        obj.insert(format!("{name}Key"), Value::String(self.key.clone()));
        obj.insert(format!("{name}Args"), self.args.clone());
    }

    /// The line `err()` encoded, if `text` is one. For tests and logs.
    pub fn decode(text: &str) -> Option<UiText> {
        let v: Value = serde_json::from_str(text).ok()?;
        let key = v.get("key")?.as_str()?.to_string();
        let text = v.get("text")?.as_str()?.to_string();
        let args = v.get("args").cloned().unwrap_or_else(|| Value::Object(Map::new()));
        Some(UiText { key, text, args })
    }
}

/// `{ "key", "text", "args" }` for a payload field of its own.
pub fn ui_text(key: &str, args: Value) -> Value {
    UiText::new(key, args).value()
}

/// The error form of a line, for `Err(ui_err(...))`.
pub fn ui_err(key: &str, args: Value) -> String {
    UiText::new(key, args).err()
}

/// The readable English of an error string: the `text` of an encoded line,
/// the string itself otherwise. For log lines and tests.
pub fn plain(err: &str) -> String {
    UiText::decode(err).map(|l| l.text).unwrap_or_else(|| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words() -> HashMap<String, Value> {
        let mut m = HashMap::new();
        m.insert("friends.offered".to_string(), json!("{name} offered a friendship card."));
        m.insert(
            "im.members".to_string(),
            json!({ "one": "{count} member", "other": "{count} members" }),
        );
        m
    }

    #[test]
    fn fill_replaces_named_placeholders_and_leaves_the_rest() {
        let args = json!({ "name": "Ruth", "metres": 12, "gone": null });
        assert_eq!(fill("{name} is {metres} m away", &args), "Ruth is 12 m away");
        assert_eq!(fill("{name} {unknown} {gone}", &args), "Ruth {unknown} {gone}");
        assert_eq!(fill("a { b } c {} d {", &args), "a { b } c {} d {");
        assert_eq!(fill("no placeholders", &json!(null)), "no placeholders");
    }

    #[test]
    fn a_line_is_looked_up_by_key_with_english_plural_rules() {
        let w = words();
        assert_eq!(line_from(&w, "friends.offered", &json!({ "name": "Bob" })), "Bob offered a friendship card.");
        assert_eq!(line_from(&w, "im.members", &json!({ "count": 1 })), "1 member");
        assert_eq!(line_from(&w, "im.members", &json!({ "count": 0 })), "0 members");
        assert_eq!(line_from(&w, "im.members", &json!({ "count": 5 })), "5 members");
        assert_eq!(line_from(&w, "im.members", &json!({})), "{count} members");
        // a key nobody defined shows itself
        assert_eq!(line_from(&w, "nope.missing", &json!({})), "nope.missing");
    }

    #[test]
    fn the_bundled_english_is_there() {
        assert!(english().len() > 100, "src/lang/en.json did not parse or is nearly empty");
        assert_eq!(english_line("common.cancel", &json!({})), "Cancel");
        assert_eq!(UiText::new("nope.missing", json!({})).text, "nope.missing");
    }

    #[test]
    fn a_line_carries_key_text_and_args_in_every_shape() {
        let line = UiText { key: "friends.offered".into(), text: "Bob offered a friendship card.".into(), args: json!({ "name": "Bob" }) };
        let v = line.value();
        assert_eq!(v["key"], "friends.offered");
        assert_eq!(v["text"], "Bob offered a friendship card.");
        assert_eq!(v["args"]["name"], "Bob");

        let mut payload = json!({ "kind": "system" });
        line.fields(&mut payload, "text");
        assert_eq!(payload["text"], "Bob offered a friendship card.");
        assert_eq!(payload["textKey"], "friends.offered");
        assert_eq!(payload["textArgs"]["name"], "Bob");
        assert_eq!(payload["kind"], "system");

        let err = line.err();
        assert!(err.starts_with('{'));
        assert_eq!(UiText::decode(&err), Some(line.clone()));
        assert_eq!(plain(&err), "Bob offered a friendship card.");
        assert_eq!(plain("plain words"), "plain words");
        assert!(UiText::decode("plain words").is_none());
    }

    #[test]
    fn non_object_args_count_as_none() {
        let line = UiText::new("common.cancel", Value::Null);
        assert_eq!(line.args, json!({}));
        assert_eq!(ui_err("common.cancel", json!([1, 2])), line.err());
        assert_eq!(ui_text("common.cancel", json!(7))["args"], json!({}));
    }
}
