// His one-line life update for reconnect notes ("Just moved to SF and started a new job").
// Typed once on the Reconnect panel; every single and bulk draft uses it as sentence two.
// Kept in localStorage: it is a preference of this window, not CRM data.

const KEY = "pos.reconnect.myNews";

export function getMyNews(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setMyNews(v: string): void {
  try {
    if (v.trim()) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the drafts fall back to the worklog */
  }
}
