// Deferred surface. The spine (person/interaction/commitment) already ingests
// from connectors; a unified inbox is a view over it, not a new schema. Until
// then, this page deep-links out to where the messages actually live.

const LINKS: { label: string; href: string | null }[] = [
  { label: "Gmail", href: "https://mail.google.com" },
  { label: "LinkedIn", href: "https://linkedin.com/messaging" },
  { label: "iMessage", href: null },
];

export default function Inbox() {
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="drag-region absolute top-0 left-0 right-0 h-8" />
      <div
        className="max-w-md w-full rounded-xl border bg-white p-8 text-center no-drag"
        style={{ borderColor: "var(--line)" }}
      >
        <h1 className="font-display text-xl font-semibold mb-2">Inbox</h1>
        <p className="text-sm leading-relaxed mb-6" style={{ color: "var(--muted)" }}>
          Unified messaging lands here later. Connectors write to the same spine — no schema change needed.
        </p>
        <div className="flex justify-center gap-2">
          {LINKS.map(({ label, href }) =>
            href ? (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 rounded-md border text-sm bg-white hover:shadow-sm"
                style={{ borderColor: "var(--line)", color: "var(--muted)" }}
              >
                {label}
              </a>
            ) : (
              <span
                key={label}
                title="Open Messages on your Mac"
                className="px-3 py-1.5 rounded-md border text-sm"
                style={{ borderColor: "var(--line)", color: "var(--muted)", opacity: 0.6 }}
              >
                {label}
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
}
