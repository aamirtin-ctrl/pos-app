// Split a mail body into what the sender actually wrote and the quoted history beneath it
// ("On … wrote:", Outlook's From:/Sent: block, forwarded-message rules, ">"-prefixed
// lines). The Messaging mail card shows `visible` and hides `quoted` behind a "Show
// previous emails" toggle (owner ask 2026-09-11). Pure — no DOM, unit-tested directly.

export interface SplitBody {
  visible: string;
  /** The quoted tail, or null when the message has none. */
  quoted: string | null;
}

const ON_WROTE = /^On .{0,300}wrote:\s*$/;
const RULE = /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}\s*$/i;
const FROM_LINE = /^From:\s\S/;
const HEADER_FOLLOW = /^(Sent|Date|To|Subject):\s/;
const QUOTE_LINE = /^\s?>/;

/** Index of the first line that starts the quoted tail, or -1. */
function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (ON_WROTE.test(line)) return i;
    // Gmail wraps long "On … wrote:" lines: "On Tue, Sep 9, 2026 at 3:12 PM Jane Doe" / "<jane@x.com> wrote:"
    if (/^On .{0,300}$/.test(line) && i + 1 < lines.length && ON_WROTE.test(`${line} ${lines[i + 1].trim()}`)) return i;
    if (RULE.test(line)) return i;
    if (FROM_LINE.test(line)) {
      for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
        if (HEADER_FOLLOW.test(lines[j])) return i;
      }
    }
    if (QUOTE_LINE.test(line) && i + 1 < lines.length && QUOTE_LINE.test(lines[i + 1])) return i;
  }
  return -1;
}

export function splitQuoted(text: string): SplitBody {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const at = quoteStart(lines);
  if (at < 0) return { visible: text.trim(), quoted: null };
  const visible = lines.slice(0, at).join("\n").trim();
  const quoted = lines.slice(at).join("\n").trim();
  // A message that is nothing but quote is still a message — show it, no toggle.
  if (!visible) return { visible: text.trim(), quoted: null };
  return { visible, quoted: quoted || null };
}
